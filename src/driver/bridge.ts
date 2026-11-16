import type { AccountDriver, Capabilities, DriverContext, DriverOptions, SendResult } from './types.ts';
import { capabilityMap } from './types.ts';
import type {
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
  readonly capabilities: Capabilities = capabilityMap({
    privateMessage: true,
    qrLogin: true,
    logout: true,
  });

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
  #lastError = '';

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
    return this.#qr;
  }

  async refreshQr(): Promise<QrPayload> {
    const payload = await this.#request<{ picture?: string; expires_at?: number; seq?: number; available?: boolean }>(
      '/api/qr/refresh',
      'POST',
    );
    this.#qr = this.#qrFromPayload(payload);
    this.#context.emit({ type: 'qr', qr: this.#qr });
    return this.#qr;
  }

  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    if (message.scene !== 'private') throw new Error('桥接驱动仅支持私聊消息');
    const text = message.segments.map((segment) => (segment.type === 'text' ? segment.text : '')).join('');
    if (!text.trim()) throw new Error('桥接驱动仅支持纯文本消息');
    const sent = await this.#request<{ message_id?: string | number }>('/api/send-private', 'POST', {
      user_id: Number(message.peerId),
      message: text,
    });
    if (sent?.message_id === undefined) throw new Error('桥接服务未返回 message_id');
    return { messageId: String(sent.message_id) };
  }

  async recall(): Promise<void> {
    throw new Error('桥接驱动未实现撤回');
  }

  async friendList(): Promise<Friend[]> {
    throw new Error('桥接驱动未提供好友列表接口');
  }

  async groupList(): Promise<Group[]> {
    throw new Error('桥接驱动未提供群列表接口');
  }

  async strangerInfo(): Promise<StrangerInfo> {
    throw new Error('桥接驱动未提供陌生人信息接口');
  }

  async groupMemberInfo(): Promise<GroupMember> {
    throw new Error('桥接驱动未提供群成员接口');
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
      if (online && this.#qr.state !== 'none') {
        this.#qr = { state: 'none', seq: this.#qr.seq };
        this.#context.emit({ type: 'qr', qr: this.#qr });
      }
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

  async #pollEvents(): Promise<void> {
    if (!this.#started || !this.#status.online) return;
    try {
      const payload = await this.#request<BridgeEventEnvelope>(`/api/events?after=${this.#cursor}`);
      const events = payload?.events ?? [];
      const nextCursor = Number(payload?.cursor ?? this.#cursor);
      if (nextCursor < this.#cursor) {
        // The bridge restarted and its sequence restarted too.
        this.#cursor = 0;
        return;
      }
      for (const envelope of events) {
        const data = envelope?.data;
        if (!data) continue;
        const message = this.#toMessage(data);
        if (message) this.#push(message);
      }
      this.#cursor = Math.max(this.#cursor, nextCursor);
    } catch {
      // Status polling reports the failure; event polling stays quiet.
    }
  }

  #toMessage(data: Record<string, unknown>): InboundMessage | null {
    if (data.post_type !== 'message') return null;
    const scene = data.message_type === 'group' ? 'group' : 'private';
    const peerId = String(data.group_id ?? data.user_id ?? '');
    if (!peerId) return null;
    const senderId = String(data.user_id ?? peerId);
    return {
      scene,
      messageId: String(data.message_id ?? `bridge-${this.#cursor}`),
      time: Number(data.time ?? Math.floor(Date.now() / 1000)),
      self: Boolean(data.self === true || senderId === this.#status.uin),
      peer: { id: peerId },
      sender: { id: senderId },
      segments: this.#toSegments(data.message),
      raw: data,
    };
  }

  #toSegments(input: unknown): Segment[] {
    if (typeof input === 'string') return [{ type: 'text', text: input }];
    if (!Array.isArray(input)) return [{ type: 'text', text: '' }];
    const segments: Segment[] = [];
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const segment = item as { type?: string; data?: Record<string, unknown> };
      if (segment.type === 'text') segments.push({ type: 'text', text: String(segment.data?.text ?? '') });
      else if (segment.type) segments.push({ type: 'unknown', kind: segment.type, raw: segment.data });
    }
    if (segments.length === 0) segments.push({ type: 'text', text: '' });
    return segments;
  }

  #qrFromPayload(payload: { picture?: string; expires_at?: number; seq?: number; available?: boolean } | null): QrPayload {
    if (!payload || payload.available === false || !payload.picture) {
      // The bridge reports "no code" while the account is already signed in.
      return { state: this.#status.online ? 'none' : 'expired', seq: (this.#qr.seq ?? 0) + 1 };
    }
    const image = payload.picture.startsWith('data:') ? payload.picture : `data:image/png;base64,${payload.picture}`;
    return {
      state: 'waiting',
      image,
      expiresAt: payload.expires_at ? payload.expires_at * (payload.expires_at < 1e12 ? 1000 : 1) : Date.now() + 120_000,
      seq: payload.seq ?? (this.#qr.seq ?? 0) + 1,
    };
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
}
