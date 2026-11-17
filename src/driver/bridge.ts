import type { AccountDriver, Capabilities, DriverContext, DriverOptions, SendResult } from './types.ts';
import { capabilityMap } from './types.ts';
import type {
  AccountNotice,
  AccountStatus,
  Friend,
  Group,
  GroupMember,
  InboundMessage,
  LoginRequest,
  OutboundMessage,
  ProcessInfo,
  QrPayload,
  Segment,
  StrangerInfo,
} from '../core/model.ts';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:16082';
const STATUS_INTERVAL_MS = 2000;
const EVENT_INTERVAL_MS = 1000;

interface BridgeStatusPayload {
  readonly message_ready?: boolean;
  readonly qr_ready?: boolean;
  readonly phase?: string;
  readonly login_mode?: 'active' | 'passive';
  /** Contract version of the runtime (1 = legacy send-private only). */
  readonly contract?: number;
  /** Identity of the runtime process instance; changes across restarts. */
  readonly instance?: string;
  /** Which OneBot segments the runtime can actually send / receive. */
  readonly send_segments?: string[];
  readonly recv_segments?: string[];
  /** Native calls the runtime author has not verified against a real client. */
  readonly pending_native?: string[];
  /**
   * Optional capability report. Runtimes that implement contract v2 send it;
   * older ones omit it and keep the conservative v1 capability set.
   */
  readonly features?: Record<string, unknown>;
  readonly self_id?: number | string;
  readonly nickname?: string;
  readonly avatar?: string;
  readonly version?: string;
  readonly pid?: number;
  readonly cpu?: number;
  readonly memory_mb?: number;
  readonly native_probe?: Record<string, unknown>;
}

interface BridgeEventEnvelope {
  readonly cursor?: number;
  readonly instance?: string;
  /** How many events were dropped by the runtime ring since `after`. */
  readonly lost?: number;
  readonly events?: Array<{ readonly cursor?: number; readonly data?: Record<string, unknown> }>;
}

/**
 * Adapter for an out-of-process QQ runtime ("native bridge").
 *
 * The bridge is the process that owns the QQ session; it exposes a small HTTP
 * contract: `/api/status`, `/api/events`, `/api/send-private`, `/api/qr`.
 * Keeping the QQ-touching code behind an HTTP boundary means this framework
 * stays pure Node and runs unchanged on Windows and Linux, and the runtime can
 * be restarted or replaced without restarting the console.
 */
export class BridgeDriver implements AccountDriver {
  readonly id = 'bridge';
  readonly name = 'QQ 原生桥接';
  readonly description = '连接一个独立的 QQ 原生运行时（HTTP 契约），当前仅支持私聊文本。';
  /**
   * Starts at the v1 contract (private text + QR display) and converges on the
   * runtime's own feature report. `qrLogin` stays true in passive mode because
   * the console can still display the code the QQ window requested; whether a
   * refresh works is reported separately by {@link qrInfo}.
   */
  readonly #caps: Capabilities = capabilityMap({ privateMessage: true, qrLogin: true });

  get capabilities(): Capabilities {
    return this.#caps;
  }

  readonly #context: DriverContext;
  readonly #endpoint: string;
  readonly #token: string;
  readonly #inbox: InboundMessage[] = [];
  #status: AccountStatus = {
    uin: '',
    nick: '',
    avatar: '',
    state: 'starting',
    online: false,
    loginType: 'none',
    detail: '尚未连接桥接服务',
  };
  #qr: QrPayload = { state: 'none', seq: 0 };
  #cursor = 0;
  #started = false;
  #statusTimer: ReturnType<typeof setInterval> | null = null;
  #eventTimer: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #eventPolling = false;
  #lastError = '';
  #loginMode: 'active' | 'passive' | 'unknown' = 'unknown';
  /** Native phase reported by the runtime (waiting_login, scan_qr, ...). */
  #phase = '';
  /** Contract version and instance id reported by the runtime. */
  #contract = 1;
  #instance = '';
  #pendingReported = false;
  #qrRefreshable = true;
  /** When the current QR image was first observed, used to derive expiry. */
  #qrSeenAt = 0;
  #qrHint = '';

  constructor(context: DriverContext, options: DriverOptions) {
    this.#context = context;
    this.#endpoint = (options.endpoint || process.env.DUSKFOX_BRIDGE_URL || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.#token = options.token || process.env.DUSKFOX_BRIDGE_TOKEN || '';
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#refreshStatus();
    this.#statusTimer = setInterval(() => void this.#refreshStatus(), STATUS_INTERVAL_MS);
    this.#statusTimer.unref?.();
    this.#eventTimer = setInterval(() => void this.#pollEvents(), EVENT_INTERVAL_MS);
    this.#eventTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    if (this.#eventTimer) clearInterval(this.#eventTimer);
    this.#statusTimer = null;
    this.#eventTimer = null;
    this.#setStatus({ ...this.#status, state: 'offline', online: false, detail: '已停止' });
  }

  async status(): Promise<AccountStatus> {
    return this.#status;
  }

  events(): readonly InboundMessage[] {
    return this.#inbox;
  }

  async login(request: LoginRequest): Promise<void> {
    if (request.method !== 'qr') throw new Error('桥接驱动仅支持扫码登录');
    await this.refreshQr();
  }

  async logout(): Promise<void> {
    // The bridge owns the session; there is no portable logout route yet.
    throw new Error('桥接服务未提供退出登录接口');
  }

  async qrCode(): Promise<QrPayload> {
    if (!this.#status.online) await this.#fetchQr();
    return this.#composeQr();
  }

  /**
   * Ask the runtime for a new login code.
   *
   * Passive runtimes answer 409 because only the QQ window can request a code;
   * active ones answer 202 and deliver the picture through GET /api/qr, so the
   * refresh has to wait for it instead of returning an empty payload.
   */
  async refreshQr(): Promise<QrPayload> {
    if (this.#loginMode === 'passive') {
      this.#qrRefreshable = false;
      this.#qrHint = '被动模式：请在 QQ 客户端窗口里刷新二维码，本控制台会同步显示';
      this.#publishQr();
      return this.#composeQr();
    }
    try {
      const payload = await this.#request<{
        picture?: string;
        image?: string;
        expires_at?: number;
        seq?: number;
        available?: boolean;
        accepted?: boolean;
      }>('/api/qr/refresh', 'POST');
      this.#qrRefreshable = true;
      this.#qrHint = '';
      if (payload.picture ?? payload.image) {
        this.#qr = this.#qrFromPayload(payload);
        this.#publishQr();
        return this.#composeQr();
      }
      // 202 accepted: poll until the asynchronous picture shows up.
      const before = this.#qr.image;
      await this.#awaitQr(before, 6000);
      return this.#composeQr();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes('HTTP 409')) {
        this.#qrRefreshable = false;
        this.#qrHint = '被动模式：请在该 QQ 窗口内刷新二维码，本控制台会同步显示';
        this.#publishQr();
        return this.#composeQr();
      }
      if (detail.includes('HTTP 404') || detail.includes('HTTP 503')) {
        this.#qrHint = `运行时暂时无法生成二维码：${detail}`;
        this.#publishQr();
        return this.#composeQr();
      }
      throw error;
    }
  }

  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    const text = message.segments.map((segment) => (segment.type === 'text' ? segment.text : '')).join('');
    const plain = message.segments.every((segment) => segment.type === 'text');
    if (!text.trim() && plain) throw new Error('消息内容为空');

    // Contract v2 accepts any segment list; v1 only understands private text.
    if (this.#contract >= 2 || this.capabilities.groupMessage || !plain || message.scene === 'group') {
      try {
        const sent = await this.#request<{ message_id?: string | number }>('/api/send', 'POST', {
          scene: message.scene,
          peer_id: message.peerId,
          segments: message.segments.map(toWireSegment),
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        });
        if (sent?.message_id !== undefined) return { messageId: String(sent.message_id) };
        throw new Error('桥接服务未返回 message_id');
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!detail.includes('HTTP 404')) throw error;
        // Fall through to the legacy route for text-only private messages.
        if (message.scene !== 'private' || !plain) throw error;
      }
    }

    if (message.scene !== 'private') throw new Error('桥接驱动仅支持私聊消息（当前运行时未提供群发送）');
    if (!plain) throw new Error('桥接驱动仅支持纯文本消息（当前运行时未提供媒体发送）');
    const sent = await this.#request<{ message_id?: string | number }>('/api/send-private', 'POST', {
      user_id: Number(message.peerId),
      message: text,
    });
    if (sent?.message_id === undefined) throw new Error('桥接服务未返回 message_id');
    return { messageId: String(sent.message_id) };
  }

  async recall(messageId: string): Promise<void> {
    if (!this.capabilities.recall) throw new Error('桥接驱动未提供撤回能力');
    await this.#request('/api/recall', 'POST', { message_id: messageId });
  }

  async friendList(): Promise<Friend[]> {
    if (!this.capabilities.friendList) throw new Error('桥接驱动未提供好友列表接口');
    const payload = await this.#request<{ items?: Array<Record<string, unknown>> }>('/api/friends');
    return (payload?.items ?? []).map((item) => ({
      id: String(item.user_id ?? ''),
      name: String(item.nickname ?? item.user_id ?? ''),
      ...(item.remark ? { remark: String(item.remark) } : {}),
    }));
  }

  async groupList(): Promise<Group[]> {
    if (!this.capabilities.groupList) throw new Error('桥接驱动未提供群列表接口');
    const payload = await this.#request<{ items?: Array<Record<string, unknown>> }>('/api/groups');
    return (payload?.items ?? []).map((item) => ({
      id: String(item.group_id ?? ''),
      name: String(item.group_name ?? item.group_id ?? ''),
      ...(item.member_count !== undefined ? { memberCount: Number(item.member_count) } : {}),
      ...(item.max_member_count !== undefined ? { maxMemberCount: Number(item.max_member_count) } : {}),
    }));
  }

  async strangerInfo(userId: string): Promise<StrangerInfo> {
    if (!this.capabilities.strangerInfo) throw new Error('桥接驱动未提供陌生人信息接口');
    const payload = await this.#request<Record<string, unknown>>(`/api/stranger?user_id=${encodeURIComponent(userId)}`);
    return {
      id: String(payload.user_id ?? userId),
      name: String(payload.nickname ?? userId),
      sex: payload.sex === 'male' || payload.sex === 'female' ? payload.sex : 'unknown',
      ...(payload.age !== undefined ? { age: Number(payload.age) } : {}),
    };
  }

  async groupMemberInfo(groupId: string, userId: string): Promise<GroupMember> {
    if (!this.capabilities.groupMemberInfo) throw new Error('桥接驱动未提供群成员接口');
    const payload = await this.#request<Record<string, unknown>>(
      `/api/group-member?group_id=${encodeURIComponent(groupId)}&user_id=${encodeURIComponent(userId)}`,
    );
    return toMember(payload, groupId, userId);
  }

  async groupMemberList(groupId: string): Promise<GroupMember[]> {
    if (!this.capabilities.groupMemberList) throw new Error('桥接驱动未提供群成员列表接口');
    const payload = await this.#request<{ items?: Array<Record<string, unknown>> }>(
      `/api/group-members?group_id=${encodeURIComponent(groupId)}`,
    );
    return (payload?.items ?? []).map((item) => toMember(item, groupId, String(item.user_id ?? '')));
  }

  async handleRequest(input: {
    readonly flag: string;
    readonly approve: boolean;
    readonly type: 'friend' | 'group';
    readonly subType?: string;
  }): Promise<void> {
    if (!this.capabilities.requestHandle) throw new Error('桥接驱动未提供请求处理能力');
    await this.#request('/api/request', 'POST', {
      flag: input.flag,
      approve: input.approve,
      type: input.type,
      ...(input.subType ? { sub_type: input.subType } : {}),
    });
  }

  qrInfo(): { refreshable: boolean; loginMode: 'active' | 'passive' | 'unknown' } {
    return { refreshable: this.#qrRefreshable, loginMode: this.#loginMode };
  }

  async processInfo(): Promise<ProcessInfo> {
    const status = await this.#request<BridgeStatusPayload>('/api/status');
    return {
      running: Boolean(status?.message_ready),
      pid: status?.pid,
      cpu: status?.cpu,
      memoryMb: status?.memory_mb,
      version: status?.version,
      args: '由原生桥接服务管理',
    };
  }

  async #refreshStatus(): Promise<void> {
    if (this.#polling || !this.#started) return;
    this.#polling = true;
    try {
      const payload = await this.#request<BridgeStatusPayload>('/api/status');
      this.#applyLoginMode(payload?.login_mode);
      if (payload?.phase) this.#phase = payload.phase;
      this.#applyFeatures(payload);
      if (Array.isArray(payload?.pending_native) && !this.#pendingReported && payload.pending_native.length > 0) {
        this.#pendingReported = true;
        this.#context.logger.warn(
          'driver:bridge',
          `运行时报告 ${payload.pending_native.length} 项待实机验证的原生调用：${payload.pending_native.join('；')}`,
        );
      }
      const online = Boolean(payload?.message_ready && payload?.self_id);
      const uin = payload?.self_id ? String(payload.self_id) : '';
      const next: AccountStatus = {
        uin: online ? uin : '',
        nick: online ? String(payload?.nickname ?? uin) : '',
        avatar: online ? String(payload?.avatar ?? '') : '',
        state: online ? 'online' : 'offline',
        online,
        loginType: online ? 'session' : 'none',
        detail: online ? undefined : '桥接服务在线，但 QQ 会话尚未就绪',
      };
      this.#lastError = '';
      this.#setStatus(next);
      if (!online && payload?.qr_ready && !this.#qr.image) await this.#fetchQr();
      this.#publishQr();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (detail !== this.#lastError) {
        this.#lastError = detail;
        this.#context.logger.warn('driver:bridge', `桥接服务不可用：${detail}`);
      }
      this.#setStatus({ uin: '', nick: '', avatar: '', state: 'error', online: false, loginType: 'none', detail });
    } finally {
      this.#polling = false;
    }
  }

  async #fetchQr(): Promise<void> {
    try {
      const response = await this.#request<{
        picture?: string;
        image?: string;
        expires_at?: number;
        seq?: number;
        available?: boolean;
        phase?: string;
        login_mode?: 'active' | 'passive';
      }>('/api/qr');
      if (response?.phase) this.#phase = response.phase;
      if (response?.login_mode) this.#applyLoginMode(response.login_mode);
      const next = this.#qrFromPayload(response);
      if (next.image !== this.#qr.image) this.#qr = next;
      this.#publishQr();
    } catch (error) {
      // A 404 means the runtime has no code right now (async request pending),
      // which is a state, not a transport failure.
      if (!(error instanceof Error && error.message.includes('HTTP 404'))) throw error;
      this.#publishQr();
    }
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
  async #pollEvents(): Promise<void> {
    if (!this.#started || !this.#status.online) return;
    if (this.#eventPolling) return;
    this.#eventPolling = true;
    try {
      // Page until caught up. A batch is never assumed to be everything: the
      // runtime may cap batch size (the legacy one returns 100), and jumping to
      // the server cursor at batch end would skip the rest of the backlog.
      for (let page = 0; page < 16; page += 1) {
        const payload = await this.#request<BridgeEventEnvelope>(`/api/events?after=${this.#cursor}`);
        const events = payload?.events ?? [];
        const serverCursor = Number(payload?.cursor ?? this.#cursor);
        const instance = String(payload?.instance ?? '');
        if (instance && this.#instance && instance !== this.#instance) {
          this.#context.logger.warn(
            'driver:bridge',
            `运行时实例已变更（${this.#instance} → ${instance}），重置事件游标并重新同步`,
          );
          this.#instance = instance;
          this.#cursor = 0;
          return;
        }
        if (instance) this.#instance = instance;

        if (serverCursor < this.#cursor) {
          // The runtime restarted and its sequence restarted too: re-read from 0.
          this.#context.logger.warn('driver:bridge', '运行时事件游标重置，重新同步事件流');
          this.#cursor = 0;
          return;
        }

        for (const envelope of events) {
          const data = envelope?.data;
          const eventCursor = Number(envelope?.cursor ?? 0);
          if (!data) continue;
          if (eventCursor > 0 && eventCursor <= this.#cursor) continue;
          this.#deliverEvent(data);
          if (eventCursor > 0) this.#cursor = Math.max(this.#cursor, eventCursor);
        }

        const lost = Number(payload?.lost ?? 0);
        if (lost > 0) {
          this.#context.logger.warn('driver:bridge', `运行时事件环缓冲溢出，丢失 ${lost} 条（已从最早可用事件继续）`);
          this.#cursor = Math.max(this.#cursor, serverCursor - events.length);
        }

        if (this.#cursor >= serverCursor) return;
        if (events.length === 0) {
          // Nothing left to deliver, but the server knows of newer events: the
          // ring dropped them. Advance and say so, instead of looping forever.
          this.#context.logger.warn('driver:bridge', `事件游标跳跃 ${this.#cursor} → ${serverCursor}，缓冲区已清理`);
          this.#cursor = serverCursor;
          return;
        }
        // Smaller batch than the server cursor: keep paging immediately.
      }
      this.#context.logger.warn('driver:bridge', '事件追赶页数过多，下一轮继续');
    } catch {
      // Status polling reports the failure; event polling stays quiet.
    } finally {
      this.#eventPolling = false;
    }
  }

  #deliverEvent(data: Record<string, unknown>): void {
    const postType = String(data.post_type ?? '');
    if (postType === 'message' || postType === 'message_sent') {
      const message = this.#toMessage(data);
      if (message) this.#push(message);
      return;
    }
    if (postType === 'notice') {
      this.#emitNotice(data);
      return;
    }
    if (postType === 'request') {
      this.#emitRequest(data);
    }
  }

  #toMessage(data: Record<string, unknown>): InboundMessage | null {
    // Both post types are accepted: the runtime may report our own sends as
    // `message_sent`, and the framework re-emits them as message_sent anyway.
    if (data.post_type !== 'message' && data.post_type !== 'message_sent') return null;
    const scene = data.message_type === 'group' ? 'group' : 'private';
    const peerId = String(data.group_id ?? data.user_id ?? '');
    if (!peerId) return null;
    const senderId = String(data.user_id ?? peerId);
    return {
      scene,
      messageId: String(data.message_id ?? ''),
      time: Number(data.time ?? Math.floor(Date.now() / 1000)),
      self: data.post_type === 'message_sent' || data.self === true || senderId === this.#status.uin,
      peer: { id: peerId },
      sender: { id: senderId },
      segments: this.#toSegments(data.message),
      raw: data,
    };
  }

  /**
   * Native lookup used by `get_msg` when the framework's recent window has
   * already evicted the message. Contract v1 runtimes cannot answer this
   * (their message ids are sequence numbers), so they return null.
   */
  async fetchMessage(nativeId: string): Promise<InboundMessage | null> {
    if (this.#contract < 2) return null;
    if (!nativeId) return null;
    try {
      const data = await this.#request<Record<string, unknown>>(
        `/api/message?message_id=${encodeURIComponent(nativeId)}`,
      );
      return this.#toMessage({ ...data, post_type: String(data.post_type ?? 'message') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('HTTP 404') || message.includes('HTTP 501')) return null;
      throw error;
    }
  }

  /**
   * Parse the runtime's OneBot-shaped segments into the framework model.
   * Every supported kind is mapped explicitly; anything else is kept as
   * `unknown` with its raw payload so the console can show it instead of
   * silently dropping the segment (which would corrupt the message).
   */
  #toSegments(input: unknown): Segment[] {
    if (typeof input === 'string') return input ? [{ type: 'text', text: input }] : [];
    if (!Array.isArray(input)) return [];
    const segments: Segment[] = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const segment = item as { type?: string; data?: Record<string, unknown> };
      const data = segment.data ?? {};
      switch (segment.type) {
        case 'text':
          segments.push({ type: 'text', text: String(data.text ?? '') });
          break;
        case 'face':
          segments.push({ type: 'face', id: String(data.id ?? '') });
          break;
        case 'image':
          segments.push({
            type: 'image',
            file: String(data.file ?? data.url ?? ''),
            ...(data.url ? { url: String(data.url) } : {}),
            ...(data.summary ? { summary: String(data.summary) } : {}),
          });
          break;
        case 'at':
          segments.push({
            type: 'at',
            target: String(data.qq ?? '') === 'all' ? 'all' : String(data.qq ?? ''),
            ...(data.name ? { name: String(data.name) } : {}),
          });
          break;
        case 'reply':
          segments.push({ type: 'reply', id: String(data.id ?? '') });
          break;
        case 'record':
          segments.push({ type: 'record', file: String(data.file ?? data.url ?? ''), ...(data.url ? { url: String(data.url) } : {}) });
          break;
        case 'video':
          segments.push({ type: 'video', file: String(data.file ?? data.url ?? ''), ...(data.url ? { url: String(data.url) } : {}) });
          break;
        case 'file':
          segments.push({
            type: 'file',
            file: String(data.file ?? data.url ?? ''),
            ...(data.name ? { name: String(data.name) } : {}),
            ...(data.file_size !== undefined ? { size: Number(data.file_size) } : {}),
            ...(data.url ? { url: String(data.url) } : {}),
          });
          break;
        case 'json':
          segments.push({ type: 'json', data: typeof data.data === 'string' ? data.data : JSON.stringify(data.data ?? {}) });
          break;
        case 'markdown':
          segments.push({ type: 'markdown', content: String(data.content ?? data.data ?? '') });
          break;
        case 'forward':
          segments.push({ type: 'forward', id: String(data.id ?? '') });
          break;
        default:
          if (segment.type) segments.push({ type: 'unknown', kind: String(segment.type), raw: data });
      }
    }
    return segments;
  }

  #qrFromPayload(payload: {
    picture?: string;
    image?: string;
    expires_at?: number;
    seq?: number;
    available?: boolean;
  } | null): QrPayload {
    const picture = payload?.picture ?? payload?.image;
    if (!payload || payload.available === false || !picture) {
      return { state: this.#status.online ? 'none' : 'expired', seq: this.#qr.seq };
    }
    const image = picture.startsWith('data:') ? picture : `data:image/png;base64,${picture}`;
    if (image !== this.#qr.image) this.#qrSeenAt = Date.now();
    const expires = payload.expires_at
      ? payload.expires_at * (payload.expires_at < 1e12 ? 1000 : 1)
      : (this.#qrSeenAt || Date.now()) + 120_000;
    return {
      state: 'waiting',
      image,
      expiresAt: expires,
      seq: Math.max(this.#qr.seq, payload.seq ?? 0) || 1,
      refreshable: this.#qrRefreshable,
      loginMode: this.#loginMode,
    };
  }

  /**
   * Map the native login phase onto the console's QR states.
   *
   * The native runtime is the source of truth: it knows whether a code is on
   * screen (`scan_qr`), already scanned (`confirm_on_phone`), failed
   * (`qr_failed`) or irrelevant because the session is authenticated.
   */
  #composeQr(): QrPayload {
    const seq = this.#qr.seq;
    // The runtime phase is authoritative: a cached picture must not hide
    // "already scanned" / "authenticated" / "failed" transitions.
    if (this.#phase === 'confirm_on_phone') {
      return { state: 'scanned', seq, refreshable: this.#qrRefreshable, loginMode: this.#loginMode, hint: '已扫码，请在手机上确认登录' };
    }
    if (this.#phase === 'authenticated') {
      return { state: 'confirmed', seq, refreshable: this.#qrRefreshable, loginMode: this.#loginMode };
    }
    if (this.#phase === 'qr_failed' && !this.#qr.image) {
      return { state: 'expired', seq, refreshable: this.#qrRefreshable, loginMode: this.#loginMode, hint: this.#qrHint || '二维码会话失败，请刷新重试' };
    }
    if (this.#qr.image && this.#qr.expiresAt && Date.now() > this.#qr.expiresAt) {
      return { ...this.#qr, state: 'expired', hint: '二维码已过期，请刷新' };
    }
    if (this.#qr.image) {
      return { ...this.#qr, refreshable: this.#qrRefreshable, loginMode: this.#loginMode };
    }
    if (this.#status.online) return { state: 'none', seq, refreshable: this.#qrRefreshable, loginMode: this.#loginMode };
    switch (this.#phase) {
      case 'confirm_on_phone':
        return { state: 'scanned', seq, refreshable: this.#qrRefreshable, loginMode: this.#loginMode, hint: '已扫码，请在手机上确认登录' };
      case 'qr_failed':
        return { state: 'expired', seq, refreshable: this.#qrRefreshable, loginMode: this.#loginMode, hint: this.#qrHint || '二维码会话失败，请刷新重试' };
      case 'authenticated':
        return { state: 'confirmed', seq, refreshable: this.#qrRefreshable, loginMode: this.#loginMode };
      case 'waiting_official_qq_login':
        return {
          state: 'unavailable',
          seq,
          refreshable: this.#qrRefreshable,
          loginMode: this.#loginMode,
          hint:
            this.#qrHint ||
            '运行时处于被动模式：需要在 QQ 客户端窗口点开“扫码登录”，二维码会自动同步到这里',
        };
      case 'starting':
      case 'checking_session':
        return {
          state: 'unavailable',
          seq,
          refreshable: this.#qrRefreshable,
          loginMode: this.#loginMode,
          hint: '运行时正在初始化登录服务，请稍候',
        };
      case 'error':
        return { state: 'unavailable', seq, refreshable: this.#qrRefreshable, loginMode: this.#loginMode, hint: this.#qrHint || '运行时报告登录错误' };
      default:
        return {
          state: 'unavailable',
          seq,
          refreshable: this.#qrRefreshable,
          loginMode: this.#loginMode,
          hint: this.#qrHint || '尚未获取到可扫描的二维码',
        };
    }
  }

  /** Emit a QR update only when the console would actually see a change. */
  #publishQr(): void {
    const next = this.#composeQr();
    if (JSON.stringify(next) === JSON.stringify(this.#qr)) return;
    this.#qr = next;
    this.#context.emit({ type: 'qr', qr: next });
  }

  /** Poll GET /api/qr until a (new) picture arrives or the timeout elapses. */
  async #awaitQr(previous: string | undefined, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await this.#fetchQr();
      if (this.#qr.image && this.#qr.image !== previous) return;
      if (this.#phase === 'qr_failed' || this.#phase === 'error') return;
    }
  }

  async #request<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#token) headers.authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response: Response;
    try {
      response = await fetch(`${this.#endpoint}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`桥接服务不可达：${this.#endpoint}（${reason}）`);
    }
    if (!response.ok) throw new Error(`桥接服务返回 HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  /**
   * Passive runtimes can only mirror the code the QQ window asks for, so the
   * console must not offer a refresh button that can never work.
   */
  #applyLoginMode(mode?: 'active' | 'passive'): void {
    if (!mode) return;
    this.#loginMode = mode;
    this.#qrRefreshable = mode === 'active';
    if (mode === 'passive') {
      this.#qrHint = '被动模式：需要在 QQ 客户端窗口里打开“扫码登录”，二维码会自动同步到这里';
    } else {
      this.#qrHint = '';
    }
  }

  /**
   * Capabilities are not static for this driver: the runtime tells us what it
   * can actually do, and the action layer gates on that report. Anything the
   * runtime does not claim stays unavailable with an explicit error.
   */
  /**
   * Reconcile capabilities with the runtime's contract report.
   *
   * A capability is "supported" only when the runtime claims it AND the segment
   * directions allow it: a runtime that can receive images but not send them
   * must not advertise a working image send. On a contract or instance change
   * the whole capability set is recomputed from scratch, so a restarted runtime
   * can never inherit stale capabilities.
   */
  #applyFeatures(payload: BridgeStatusPayload): void {
    const features = payload.features;
    const contract = Number(payload.contract ?? 1);
    const instance = payload.instance ? String(payload.instance) : '';
    const changed = contract !== this.#contract || (instance !== '' && this.#instance !== '' && instance !== this.#instance);
    this.#contract = contract;
    if (instance) this.#instance = instance;
    if (!features && contract < 2) return;

    const caps = this.#caps as unknown as Record<string, boolean>;
    if (changed) {
      this.#resetCapabilities();
      this.#context.logger.info('driver:bridge', `运行时契约更新：contract=${contract} instance=${instance || '?'}`);
    }
    if (features) {
      for (const [key, value] of Object.entries(features)) {
        if (!(key in caps) || typeof value !== 'boolean' || key === 'qrLogin') continue;
        caps[key] = value;
      }
    }
    if (contract >= 2) {
      const send = new Set(payload.send_segments ?? ['text']);
      const recv = new Set(payload.recv_segments ?? ['text']);
      const supported = (key: string): boolean => caps[key] === true;
      const both = (segment: string): boolean => send.has(segment) && recv.has(segment);
      caps.privateMessage = supported('privateMessage') && send.has('text');
      caps.groupMessage = supported('groupMessage') && send.has('text');
      caps.mediaImage = supported('mediaImage') && both('image');
      caps.mediaRecord = supported('mediaRecord') && both('record');
      caps.mediaVideo = supported('mediaVideo') && both('video');
      caps.mediaFile = supported('mediaFile') && both('file');
    }
  }

  #resetCapabilities(): void {
    const base = capabilityMap({ privateMessage: true, qrLogin: true });
    const caps = this.#caps as unknown as Record<string, boolean>;
    for (const key of Object.keys(base)) caps[key] = (base as unknown as Record<string, boolean>)[key] ?? false;
  }

  #setStatus(next: AccountStatus): void {
    const changed = JSON.stringify(this.#status) !== JSON.stringify(next);
    this.#status = next;
    if (changed) this.#context.emit({ type: 'state', status: next });
  }

  #push(message: InboundMessage): void {
    this.#inbox.unshift(message);
    if (this.#inbox.length > 200) this.#inbox.pop();
    this.#context.emit({ type: 'message', message });
  }

  /**
   * Notice/request events arrive through the same event stream as messages.
   * Unknown shapes are dropped instead of being reported as fake notifications.
   */
  #emitNotice(data: Record<string, unknown>): void {
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
    if (!kind) return;
    this.#context.emit({
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

  #emitRequest(data: Record<string, unknown>): void {
    const type = data.request_type === 'group' ? 'group' : 'friend';
    const groupId = String(data.group_id ?? '');
    this.#context.emit({
      type: 'request',
      request: {
        kind: type,
        time: Number(data.time ?? Math.floor(Date.now() / 1000)),
        scene: type === 'group' ? 'group' : 'private',
        peer: { id: groupId || String(data.user_id ?? '') },
        user: { id: String(data.user_id ?? '') },
        comment: String(data.comment ?? ''),
        flag: String(data.flag ?? ''),
        detail: { sub_type: data.sub_type },
      },
    });
  }
}

/**
 * Wire segment for contract v2. The native runtime speaks OneBot-shaped
 * segments, so the conversion is explicit and local to this adapter instead of
 * pulling the protocol layer into the driver.
 */
function toWireSegment(segment: Segment): Record<string, unknown> {
  switch (segment.type) {
    case 'text':
      return { type: 'text', data: { text: segment.text } };
    case 'face':
      return { type: 'face', data: { id: segment.id } };
    case 'image':
      return { type: 'image', data: { file: segment.file, ...(segment.url ? { url: segment.url } : {}) } };
    case 'at':
      return { type: 'at', data: { qq: segment.target } };
    case 'reply':
      return { type: 'reply', data: { id: segment.id } };
    case 'record':
      return { type: 'record', data: { file: segment.file, ...(segment.url ? { url: segment.url } : {}) } };
    case 'video':
      return { type: 'video', data: { file: segment.file, ...(segment.url ? { url: segment.url } : {}) } };
    case 'file':
      return {
        type: 'file',
        data: {
          file: segment.file,
          ...(segment.name ? { name: segment.name } : {}),
          ...(segment.size !== undefined ? { file_size: segment.size } : {}),
        },
      };
    case 'json':
      return { type: 'json', data: { data: segment.data } };
    case 'markdown':
      return { type: 'markdown', data: { content: segment.content } };
    default:
      return { type: 'text', data: { text: '' } };
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
