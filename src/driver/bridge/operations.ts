import type { RuntimeState } from '../runtime-state.ts';
import type { BridgeTransport } from './transport.ts';
import type { Friend, Group, GroupMember, InboundMessage, OutboundMessage, ProcessInfo, StrangerInfo } from '../../core/model.ts';
import type { MediaPayload, SendResult } from '../types.ts';
import type { BridgeStatusPayload } from './contract.ts';
import type { BridgeEvents } from './events.ts';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Segment } from '../../core/model.ts';

/** Only called for outbound actions; receive/get_msg/forward expansion never materialise media. */
async function outboundSegments(segments: readonly Segment[], limit: number): Promise<Segment[]> {
  return Promise.all(segments.map(async segment => {
    const data = { ...segment.data };
    if ((segment.type === 'forward' || segment.type === 'node') && Array.isArray(data.content)) {
      data.content = await outboundSegments(data.content as Segment[], limit);
    }
    if (['image', 'record', 'file', 'video'].includes(segment.type)) {
      const value = String(data.file || data.path || data.url || '');
      if (value && !/^(https?:|base64:|data:|dfm:)/i.test(value)) {
        const local = value.startsWith('file:') ? fileURLToPath(value) : value;
        let found = false;
        try {
          const stat = await fs.stat(local);
          found = stat.isFile();
          if (found && stat.size > limit) {
            throw new Error('FILE_TOO_LARGE: path=' + path.basename(local) + ' size=' + stat.size + ' limit=' + limit);
          }
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (found) {
          if (!data.name && !data.file_name) data.name = local.split(/[\\/]/).pop();
          data.file = 'base64://' + (await fs.readFile(local)).toString('base64');
        }
      }
    }
    return { ...segment, data };
  }));
}
export class BridgeOperations {
  #fileMaxBytes = 50 * 1024 * 1024;
  setFileMaxBytes(value: unknown): void {
    const limit = Number(value ?? (process.env.QQ_BRIDGE_FILE_MAX_BYTES || 50 * 1024 * 1024));
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('fileMaxBytes 必须是正整数');
    this.#fileMaxBytes = limit;
  }
  readonly #sendTails = new Map<string, Promise<void>>();
  readonly state: RuntimeState;
  readonly transport: BridgeTransport;
  readonly events: BridgeEvents;
  constructor(state: RuntimeState, transport: BridgeTransport, events: BridgeEvents) {
    this.setFileMaxBytes(undefined);
    this.state = state;
    this.transport = transport;
    this.events = events;
  }
  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    const key = message.scene + ':' + message.peerId;
    const entered = Date.now();
    const previous = this.#sendTails.get(key) || Promise.resolve();
    const job = previous.catch(() => {}).then(() => {
      if (Date.now() - entered > 120000) throw new Error('OUTBOUND_QUEUE_EXPIRED: Fox 出站排队超过 120 秒');
      return this.#sendNow(message);
    });
    const tail = job.then(() => {}, () => {});
    this.#sendTails.set(key, tail);
    void tail.finally(() => { if (this.#sendTails.get(key) === tail) this.#sendTails.delete(key); });
    return job;
  }

  async #sendNow(message: OutboundMessage): Promise<SendResult> {
    const text = message.segments.map((segment) => (segment.type === 'text' ? String(segment.data.text ?? '') : '')).join('');
    const plain = message.segments.every((segment) => segment.type === 'text');
    if (!text.trim() && plain)
      throw new Error('消息内容为空');
    // Contract v2 accepts any segment list; v1 only understands private text.
    if (this.state.contract >= 2 || this.state.caps.groupMessage || !plain || message.scene === 'group') {
      try {
        const sent = await this.transport.request<{
          message_id?: string | number;
          unknown?: boolean;
          error?: string;
        }>('/api/send', 'POST', {
          scene: message.scene,
          peer_id: message.peerId,
          segments: await outboundSegments(message.segments, this.#fileMaxBytes),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        });
        if (sent?.message_id !== undefined)
          return { messageId: String(sent.message_id) };
        // 202 + unknown：消息可能已送达但拿不到回执。必须让上层知道"结果未知"，
        // 否则框架会把失败当可重试，造成重复发送。
        if (sent?.unknown) {
          throw new Error('SEND_RESULT_UNKNOWN: ' + String(sent.error ?? '消息可能已送达但未确认回执'));
        }
        throw new Error('桥接服务未返回 message_id');
      }
      catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!detail.includes('HTTP 404'))
          throw error;
        // Fall through to the legacy route for text-only private messages.
        if (message.scene !== 'private' || !plain)
          throw error;
      }
    }
    if (message.scene !== 'private')
      throw new Error('桥接驱动仅支持私聊消息（当前运行时未提供群发送）');
    if (!plain)
      throw new Error('桥接驱动仅支持纯文本消息（当前运行时未提供媒体发送）');
    const sent = await this.transport.request<{
      message_id?: string | number;
    }>('/api/send-private', 'POST', {
      user_id: Number(message.peerId),
      message: text,
    });
    if (sent?.message_id === undefined)
      throw new Error('桥接服务未返回 message_id');
    return { messageId: String(sent.message_id) };
  }
  async recall(messageId: string): Promise<void> {
    if (!this.state.caps.recall)
      throw new Error('桥接驱动未提供撤回能力');
    await this.transport.request('/api/recall', 'POST', { message_id: messageId });
  }
  async friendList(): Promise<Friend[]> {
    if (!this.state.caps.friendList)
      throw new Error('桥接驱动未提供好友列表接口');
    const payload = await this.transport.request<{
      items?: Array<Record<string, unknown>>;
    }>('/api/friends');
    return (payload?.items ?? []).map((item) => ({
      id: String(item.user_id ?? ''),
      name: String(item.nickname ?? item.user_id ?? ''),
      ...(item.remark ? { remark: String(item.remark) } : {}),
    }));
  }
  async groupList(): Promise<Group[]> {
    if (!this.state.caps.groupList)
      throw new Error('桥接驱动未提供群列表接口');
    const payload = await this.transport.request<{
      items?: Array<Record<string, unknown>>;
    }>('/api/groups');
    return (payload?.items ?? []).map((item) => ({
      id: String(item.group_id ?? ''),
      name: String(item.group_name ?? item.group_id ?? ''),
      ...(item.member_count !== undefined ? { memberCount: Number(item.member_count) } : {}),
      ...(item.max_member_count !== undefined ? { maxMemberCount: Number(item.max_member_count) } : {}),
    }));
  }
  async strangerInfo(userId: string): Promise<StrangerInfo> {
    if (!this.state.caps.strangerInfo)
      throw new Error('桥接驱动未提供陌生人信息接口');
    const payload = await this.transport.request<Record<string, unknown>>(`/api/stranger?user_id=${encodeURIComponent(userId)}`);
    return {
      id: String(payload.user_id ?? userId),
      name: String(payload.nickname ?? userId),
      sex: payload.sex === 'male' || payload.sex === 'female' ? payload.sex : 'unknown',
      ...(payload.age !== undefined ? { age: Number(payload.age) } : {}),
    };
  }
  async groupMemberInfo(groupId: string, userId: string): Promise<GroupMember> {
    if (!this.state.caps.groupMemberInfo)
      throw new Error('桥接驱动未提供群成员接口');
    const payload = await this.transport.request<Record<string, unknown>>(`/api/group-member?group_id=${encodeURIComponent(groupId)}&user_id=${encodeURIComponent(userId)}`);
    return toMember(payload, groupId, userId);
  }
  async groupMemberList(groupId: string): Promise<GroupMember[]> {
    if (!this.state.caps.groupMemberList)
      throw new Error('桥接驱动未提供群成员列表接口');
    const payload = await this.transport.request<{
      items?: Array<Record<string, unknown>>;
    }>(`/api/group-members?group_id=${encodeURIComponent(groupId)}`);
    return (payload?.items ?? []).map((item) => toMember(item, groupId, String(item.user_id ?? '')));
  }
  async handleRequest(input: {
    readonly flag: string;
    readonly approve: boolean;
    readonly type: 'friend' | 'group';
    readonly subType?: string;
  }): Promise<void> {
    if (!this.state.caps.requestHandle)
      throw new Error('桥接驱动未提供请求处理能力');
    await this.transport.request('/api/request', 'POST', {
      flag: input.flag,
      approve: input.approve,
      type: input.type,
      ...(input.subType ? { sub_type: input.subType } : {}),
    });
  }
  async processInfo(): Promise<ProcessInfo> {
    const status = await this.transport.request<BridgeStatusPayload>('/api/status');
    return {
      running: Boolean(status?.message_ready),
      pid: status?.pid,
      cpu: status?.cpu,
      memoryMb: status?.memory_mb,
      version: status?.version,
      args: '由原生桥接服务管理',
    };
  }
  /**
     * Native lookup used by `get_msg` when the framework's recent window has
     * already evicted the message. Contract v1 runtimes cannot answer this
     * (their message ids are sequence numbers), so they return null.
     */
  async fetchMessage(nativeId: string, peer?: { scene: 'private' | 'group'; peerId: string }): Promise<InboundMessage | null> {
    if (this.state.contract < 2)
      return null;
    if (!nativeId)
      return null;
    try {
      const hint = peer ? `&scene=${peer.scene}&peer_id=${encodeURIComponent(peer.peerId)}` : '';
      const data = await this.transport.request<Record<string, unknown>>(`/api/message?message_id=${encodeURIComponent(nativeId)}${hint}`);
      return this.events.toMessage({ ...data, post_type: String(data.post_type ?? 'message') }, true);
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('HTTP 404'))
        return null;
      throw error;
    }
  }
  /**
     * Retrieve bytes for one selected media element; retain native error details.
     */
  async fetchMedia(nativeId: string, kind: 'image' | 'record' | 'file' | 'video', selector = ''): Promise<MediaPayload | null> {
    if (this.state.contract < 2)
      return null;
    if (!nativeId)
      return null;
    try {
      const data = await this.transport.request<{
        base64?: string;
        name?: string;
        size?: number;
      }>(`/api/media?message_id=${encodeURIComponent(nativeId)}&kind=${kind}&selector=${encodeURIComponent(selector)}`);
      const base64 = String(data.base64 ?? '');
      if (!base64)
        throw new Error('桥接媒体响应缺少 base64：' + kind + ' msg=' + nativeId);
      return { base64, name: String(data.name ?? ''), size: Number(data.size ?? 0) };
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 409 = 消息在、字节还没落盘，可重试；用专用标记让动作层报 1405 而不是"消息不存在"。
      if (message.includes('HTTP 409'))
        throw new Error('MEDIA_NOT_READY: ' + message);
      if (message.includes('HTTP 404'))
        return null;
      throw error;
    }
  }
  /**
     * 展开合并转发：运行时把节点归一化成 OneBot 段数组，这里再转成内部段。
     * 原生错误继续上抛，保留下载和展开失败的实际原因。
     */
  async fetchForward(nativeId: string): Promise<unknown[] | null> {
    if (this.state.contract < 2)
      return null;
    if (!nativeId)
      return null;
    try {
      const data = await this.transport.request<{
        content?: unknown[];
      }>(`/api/forward?message_id=${encodeURIComponent(nativeId)}`);
      if (!data || !Array.isArray(data.content))
        throw new Error('桥接转发响应缺少 content 节点数组');
      return data.content;
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('HTTP 404'))
        return null;
      throw error;
    }
  }
}
function toMember(payload: Record<string, unknown>, groupId: string, userId: string): GroupMember {
  const role = payload.role === 'owner' || payload.role === 'admin' ? payload.role : 'member';
  return {
    groupId: String(payload.group_id ?? groupId),
    userId: String(payload.user_id ?? userId),
    name: String(payload.nickname ?? payload.card ?? userId),
    ...(payload.card ? { card: String(payload.card) } : {}),
    role,
  };
}
