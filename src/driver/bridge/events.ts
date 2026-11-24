import type { RuntimeState } from '../runtime-state.ts';
import type { BridgeTransport } from './transport.ts';
import type { AccountNotice, InboundMessage, Segment } from '../../core/model.ts';
import type { BridgeEventEnvelope } from './contract.ts';
export class BridgeEvents {
  readonly state: RuntimeState;
  readonly transport: BridgeTransport;
  constructor(state: RuntimeState, transport: BridgeTransport) {
    this.state = state;
    this.transport = transport;
  }
  /**
     * Poll the runtime event stream.
     *
     * Invariants (regression tests cover them):
     * - never run two polls at once: a slow runtime must not make two requests
     *   race on the same cursor and replay or skip events;
     * - advance the cursor per delivered event, not to the batch cursor blindly;
     * - if the runtime restarted (cursor went backwards) resync from zero instead
     *   of dropping the batch;
     * - if the runtime ring overflowed (`lost`), report the gap loudly instead of
     *   pretending everything arrived.
     */
  async pollEvents(): Promise<void> {
    if (!this.state.started || !this.state.status.bridgeReachable || !this.state.status.messageReady ||
      this.state.status.sessionState !== 'authorized' || !this.state.status.uin)
      return;
    if (this.state.eventPolling)
      return;
    this.state.eventPolling = true;
    try {
      // Page until caught up. A batch is never assumed to be everything: the
      // runtime may cap batch size (the legacy one returns 100), and jumping to
      // the server cursor at batch end would skip the rest of the backlog.
      for (let page = 0; page < 16; page += 1) {
        const payload = await this.transport.request<BridgeEventEnvelope>(`/api/events?after=${this.state.cursor}`);
        const events = payload?.events ?? [];
        const serverCursor = Number(payload?.cursor ?? this.state.cursor);
        const instance = String(payload?.instance ?? '');
        if (instance && this.state.eventInstance && instance !== this.state.eventInstance) {
          this.state.context.logger.warn('driver:bridge', `运行时实例已变更（${this.state.eventInstance} → ${instance}），重置事件游标并重新同步`);
          this.state.eventInstance = instance;
          this.state.cursor = 0;
          return;
        }
        if (instance)
          this.state.eventInstance = instance;
        if (this.state.pollFailures > 0) {
          this.state.context.logger.info('driver:bridge', `事件轮询已恢复（此前连续失败 ${this.state.pollFailures} 次）`);
          this.state.pollFailures = 0;
        }
        if (serverCursor < this.state.cursor) {
          // The runtime restarted and its sequence restarted too: re-read from 0.
          this.state.context.logger.warn('driver:bridge', '运行时事件游标重置，重新同步事件流');
          this.state.cursor = 0;
          return;
        }
        for (const envelope of events) {
          const data = envelope?.data;
          const eventCursor = Number(envelope?.cursor ?? 0);
          if (!data)
            continue;
          if (eventCursor > 0 && eventCursor <= this.state.cursor)
            continue;
          this.deliverEvent(data);
          if (eventCursor > 0)
            this.state.cursor = Math.max(this.state.cursor, eventCursor);
        }
        const lost = Number(payload?.lost ?? 0);
        if (lost > 0) {
          this.state.context.logger.warn('driver:bridge', `运行时事件环缓冲溢出，丢失 ${lost} 条（已从最早可用事件继续）`);
          this.state.cursor = Math.max(this.state.cursor, serverCursor - events.length);
        }
        if (this.state.cursor >= serverCursor)
          return;
        if (events.length === 0) {
          // Nothing left to deliver, but the server knows of newer events: the
          // ring dropped them. Advance and say so, instead of looping forever.
          this.state.context.logger.warn('driver:bridge', `事件游标跳跃 ${this.state.cursor} → ${serverCursor}，缓冲区已清理`);
          this.state.cursor = serverCursor;
          return;
        }
        // Smaller batch than the server cursor: keep paging immediately.
      }
      this.state.context.logger.warn('driver:bridge', '事件追赶页数过多，下一轮继续');
    }
    catch (error) {
      // 以前这里把异常整个吞掉：运行时事件通道断了，控制台却还显示在线。
      this.state.pollFailures += 1;
      const detail = error instanceof Error ? error.message : String(error);
      if (this.state.pollFailures === 1 || this.state.pollFailures % 10 === 0) {
        this.state.context.logger.warn('driver:bridge', `事件轮询失败 ${this.state.pollFailures} 次：${detail}`);
      }
      // 事件流故障只影响接收。不得把 online 置 false——那会让发送被
      // "账号未登录"拒绝，并可能误发掉线邮件。只更新 detail，接收侧告警由日志承担。
      if (this.state.pollFailures >= 3 && this.state.status.online) {
        this.state.setStatus({
          ...this.state.status,
          detail: `QQ 在线，但事件流连续失败 ${this.state.pollFailures} 次：当前只能发送、收不到新消息`,
        });
      }
    }
    finally {
      this.state.eventPolling = false;
    }
  }
  deliverEvent(data: Record<string, unknown>): void {
    const postType = String(data.post_type ?? '');
    if (postType === 'message' || postType === 'message_sent') {
      const message = this.toMessage(data);
      if (message)
        this.push(message);
      return;
    }
    if (postType === 'notice') {
      this.emitNotice(data);
      return;
    }
    if (postType === 'request') {
      this.emitRequest(data);
    }
  }
  toMessage(data: Record<string, unknown>, allowHistory = false): InboundMessage | null {
    // Both post types are accepted: the runtime may report our own sends as
    // `message_sent`, and the framework re-emits them as message_sent anyway.
    if (data.post_type !== 'message' && data.post_type !== 'message_sent')
      return null;
    if (!allowHistory && this.state.historyFloor > 0) {
      const seconds = Number(data.time ?? 0);
      if (seconds > 0 && seconds < this.state.historyFloor) {
        this.state.context.logger.debug('driver:bridge', `忽略启动前的历史消息 id=${String(data.message_id ?? '')}`);
        return null;
      }
    }
    const scene = data.message_type === 'group' ? 'group' : 'private';
    const peerId = String(data.group_id ?? data.user_id ?? '');
    if (!peerId)
      return null;
    // 群消息没有顶层 user_id，发送者在 sender 里；之前直接退化成 peerId（群号），
    // 导致日志出现“← 群号”、AstrBot 把群号当发送者。
    const sender = (data.sender && typeof data.sender === 'object' ? data.sender : {}) as Record<string, unknown>;
    const senderId = String(sender.user_id ?? data.user_id ?? peerId);
    const senderName = sender.nickname ?? sender.card;
    const role = sender.role === 'owner' || sender.role === 'admin' || sender.role === 'member' ? sender.role : undefined;
    return {
      scene,
      messageId: String(data.message_id ?? ''),
      ...(data.message_seq ? { seq: String(data.message_seq) } : {}),
      time: Number(data.time ?? Math.floor(Date.now() / 1000)),
      self: data.post_type === 'message_sent' || data.self === true || senderId === this.state.status.uin,
      peer: { id: peerId, ...(data.group_name ? { name: String(data.group_name) } : {}) },
      sender: {
        id: senderId,
        ...(senderName ? { name: String(senderName) } : {}),
        ...(sender.card ? { card: String(sender.card) } : {}),
        ...(role ? { role } : {}),
      },
      segments: this.toSegments(data.message),
      raw: data,
    };
  }
  /**
     * Accept the segment array without rebuilding its payload.
     */
  toSegments(input: unknown): Segment[] {
    if (typeof input === 'string')
      return input ? [{ type: 'text', data: { text: input } }] : [];
    return Array.isArray(input) ? input as Segment[] : [];
  }
  push(message: InboundMessage): void {
    this.state.inbox.unshift(message);
    if (this.state.inbox.length > 200)
      this.state.inbox.pop();
    this.state.context.emit({ type: 'message', message });
  }
  /**
     * Notice/request events arrive through the same event stream as messages.
     * Unknown shapes are dropped instead of being reported as fake notifications.
     */
  emitNotice(data: Record<string, unknown>): void {
    const noticeType = String(data.notice_type ?? '');
    const groupId = String(data.group_id ?? '');
    const userId = String(data.user_id ?? data.operator_id ?? '');
    const scene: 'private' | 'group' = groupId ? 'group' : 'private';
    const peer = { id: groupId || userId };
    const user = { id: userId };
    const map: Record<string, AccountNotice['kind']> = {
      friend_recall: 'friend_recall',
      group_recall: 'group_recall',
      group_increase: 'group_increase',
      group_decrease: 'group_decrease',
      group_admin: 'group_admin',
      group_ban: 'group_ban',
      group_upload: 'group_upload',
    };
    const kind = map[noticeType];
    if (!kind)
      return;
    this.state.context.emit({
      type: 'notice',
      notice: {
        kind,
        time: Number(data.time ?? Math.floor(Date.now() / 1000)),
        scene,
        peer,
        user,
        detail: { ...data, message_id: data.message_id, operator_id: data.operator_id },
      },
    });
  }
  emitRequest(data: Record<string, unknown>): void {
    const type = data.request_type === 'group' ? 'group' : 'friend';
    const groupId = String(data.group_id ?? '');
    const userId = String(data.user_id ?? '');
    // user_id=0 说明运行时没能把原生 uid 换成 QQ 号；把 uid 带着，别让上层以为真的是 0 号。
    const uid = String(data.uid ?? '');
    this.state.context.emit({
      type: 'request',
      request: {
        kind: type,
        time: Number(data.time ?? Math.floor(Date.now() / 1000)),
        scene: type === 'group' ? 'group' : 'private',
        peer: { id: groupId || userId },
        user: { id: userId, ...(uid ? { uid } : {}) },
        comment: String(data.comment ?? ''),
        flag: String(data.flag ?? ''),
        detail: { sub_type: data.sub_type },
      },
    });
  }
}
