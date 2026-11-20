import crypto from 'node:crypto';
import os from 'node:os';
import type { AccountDriver, Capabilities, DriverContext, DriverOptions, SendResult } from './types.ts';
import { capabilityMap, downloadCapabilities, segmentCapabilities } from './types.ts';
import type {
  AccountNotice,
  AccountRequest,
  AccountStatus,
  Friend,
  Group,
  GroupMember,
  InboundMessage,
  LoginRequest,
  OutboundMessage,
  ProcessInfo,
  QrPayload,
  StrangerInfo,
  Segment,
} from '../core/model.ts';
import { syntheticQr } from './mock-qr.ts';

const MOCK_UIN = '10000';
const MOCK_NICK = 'duskfox 模拟账号';
const AVATAR = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0d0d0d"/><text x="32" y="42" font-family="Arial" font-size="26" font-weight="bold" fill="#df7f43" text-anchor="middle">DF</text></svg>').toString('base64')}`;
const QR_TTL_MS = 120_000;

const FRIENDS: readonly Friend[] = [
  { id: '20001', name: '测试好友甲' },
  { id: '20002', name: '测试好友乙' },
  { id: '20003', name: '测试好友丙' },
];

const GROUPS: readonly Group[] = [
  { id: '30001', name: 'duskfox 测试群', memberCount: 12, maxMemberCount: 200 },
  { id: '30002', name: 'OneBot 联调群', memberCount: 5, maxMemberCount: 500 },
];

/**
 * A self-contained account backend used for development, CI and console demos.
 *
 * It never touches a real QQ client: the login state machine, message ids and
 * inbound traffic are simulated locally, which keeps the OneBot layer fully
 * exercisable on any machine.
 */
export class MockDriver implements AccountDriver {
  readonly id = 'mock';
  readonly name = '模拟账号';
  readonly description = '本地模拟的 QQ 会话：用于在没有真实客户端时联调 OneBot 与控制台。';
  readonly capabilities: Capabilities = capabilityMap({
    privateMessage: true,
    groupMessage: true,
    send: segmentCapabilities(['text', 'image', 'record', 'video', 'file', 'forward', 'at', 'reply', 'face', 'json']),
    recv: segmentCapabilities(['text', 'image', 'record', 'video', 'file', 'forward', 'at', 'reply', 'face']),
    // 模拟账号没有真实媒体字节，下载方向一律不声明。
    download: downloadCapabilities([]),
    recall: true,
    friendList: true,
    groupList: true,
    groupInfo: true,
    strangerInfo: true,
    groupMemberInfo: true,
    groupMemberList: true,
    messageQuery: true,
    requestHandle: true,
    processControl: true,
    qrLogin: true,
    quickLogin: true,
    logout: true,
  });

  readonly #context: DriverContext;
  readonly #options: DriverOptions;
  readonly #inbox: InboundMessage[] = [];
  #status: AccountStatus;
  #qr: QrPayload = { state: 'none', seq: 0 };
  #started = false;
  #loginTimer: ReturnType<typeof setTimeout> | null = null;
  #qrTimer: ReturnType<typeof setTimeout> | null = null;
  #simulateTimer: ReturnType<typeof setInterval> | null = null;
  #counter = 0;
  #qrSeq = 0;

  constructor(context: DriverContext, options: DriverOptions) {
    this.#context = context;
    this.#options = options;
    this.#status = {
      uin: '',
      nick: '',
      avatar: '',
      state: 'starting',
      online: false,
      loginType: 'none',
    };
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#setStatus({ ...this.#status, state: 'qr', online: false, loginType: 'none' });
    this.#issueQr();
    if (this.#options.simulate) {
      this.#simulateTimer = setInterval(() => this.#simulateTraffic(), 20_000);
      this.#simulateTimer.unref?.();
    }
    if (this.#options.autoLogin !== false) {
      this.#loginTimer = setTimeout(() => {
        void this.#completeLogin('qr').catch((error: unknown) => {
          this.#context.logger.failure('driver:mock', '自动登录失败', error);
        });
      }, 2500);
      this.#loginTimer.unref?.();
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    for (const timer of [this.#loginTimer, this.#qrTimer]) if (timer) clearTimeout(timer);
    if (this.#simulateTimer) clearInterval(this.#simulateTimer);
    this.#loginTimer = null;
    this.#qrTimer = null;
    this.#simulateTimer = null;
    this.#setStatus({ ...this.#status, state: 'offline', online: false, loginType: 'none' });
  }

  async status(): Promise<AccountStatus> {
    return this.#status;
  }

  events(): readonly InboundMessage[] {
    return this.#inbox;
  }

  async login(request: LoginRequest): Promise<void> {
    const method = request.method;
    this.#context.logger.info('driver:mock', `模拟登录：${method}`);
    if (method === 'password') throw new Error('模拟驱动不支持密码登录，请使用扫码或快速登录');
    if (method === 'qr') {
      this.#issueQr();
      return;
    }
    this.#setStatus({ ...this.#status, state: 'logging' });
    this.#loginTimer = setTimeout(() => {
      void this.#completeLogin('quick').catch((error: unknown) => {
        this.#context.logger.failure('driver:mock', '快速登录失败', error);
      });
    }, 400);
    this.#loginTimer.unref?.();
  }

  async logout(): Promise<void> {
    if (this.#loginTimer) clearTimeout(this.#loginTimer);
    this.#loginTimer = null;
    this.#inbox.length = 0;
    this.#qr = { state: 'none', seq: this.#qrSeq };
    this.#setStatus({ uin: '', nick: '', avatar: '', state: 'qr', online: false, loginType: 'none' });
    this.#issueQr();
  }

  async qrCode(): Promise<QrPayload> {
    return this.#qr;
  }

  async refreshQr(): Promise<QrPayload> {
    this.#issueQr();
    return this.#qr;
  }

  async sendMessage(message: OutboundMessage): Promise<SendResult> {
    if (!this.#status.online) throw new Error('模拟账号尚未登录，无法发送消息');
    const text = message.segments
      .map((segment) => (segment.type === 'text' ? String(segment.data.text ?? '') : `[${segment.type}]`))
      .join('');
    if (!text.trim()) throw new Error('消息内容为空');
    if (text.length > 4000) throw new Error('消息过长（模拟上限 4000 字符）');
    const nativeId = `mock-${Date.now().toString(36)}-${(this.#counter += 1)}`;
    this.#context.logger.info(
      'driver:mock',
      `模拟发送 ${message.scene === 'group' ? '群 ' + message.peerId : '私聊 ' + message.peerId}：${text.slice(0, 60)}`,
    );
    // The driver always echoes what it sent; OneBotService decides whether bot
    // frameworks may see self messages (report_self_message).
    this.#push({
      scene: message.scene,
      messageId: nativeId,
      time: Math.floor(Date.now() / 1000),
      self: true,
      peer: { id: message.peerId, name: this.#peerName(message.scene, message.peerId) },
      sender: { id: MOCK_UIN, name: MOCK_NICK },
      segments: [...message.segments],
    });
    return { messageId: nativeId };
  }

  async recall(messageId: string): Promise<void> {
    if (!messageId) throw new Error('缺少 message_id');
    this.#context.logger.info('driver:mock', `撤回消息 ${messageId}`);
  }

  async friendList(): Promise<Friend[]> {
    return [...FRIENDS];
  }

  async groupList(): Promise<Group[]> {
    return [...GROUPS];
  }

  async strangerInfo(userId: string): Promise<StrangerInfo> {
    const friend = FRIENDS.find((entry) => entry.id === userId);
    return { id: userId, name: friend?.name ?? `用户 ${userId}`, sex: 'unknown', age: 18 };
  }

  async groupMemberInfo(groupId: string, userId: string): Promise<GroupMember> {
    return this.#member(groupId, userId);
  }

  async groupMemberList(groupId: string): Promise<GroupMember[]> {
    const members: GroupMember[] = [this.#member(groupId, MOCK_UIN)];
    for (const friend of FRIENDS) members.push(this.#member(groupId, friend.id));
    return members;
  }

  async handleRequest(input: {
    readonly flag: string;
    readonly approve: boolean;
    readonly type: 'friend' | 'group';
    readonly subType?: string;
  }): Promise<void> {
    this.#context.logger.info(
      'driver:mock',
      `模拟处理${input.type === 'friend' ? '好友' : '群'}请求：${input.approve ? '同意' : '拒绝'} flag=${input.flag}`,
    );
  }

  /** Test helper: push a notice through the driver pipeline. */
  emitNotice(notice: AccountNotice): void {
    this.#context.emit({ type: 'notice', notice });
  }

  /** Test helper: push a join request through the driver pipeline. */
  emitRequest(request: AccountRequest): void {
    this.#context.emit({ type: 'request', request });
  }

  #member(groupId: string, userId: string): GroupMember {
    const friend = FRIENDS.find((entry) => entry.id === userId);
    return {
      groupId,
      userId,
      name: friend?.name ?? `成员 ${userId}`,
      ...(friend ? { card: friend.name } : {}),
      role: userId === MOCK_UIN ? 'owner' : 'member',
    };
  }

  qrInfo(): { refreshable: boolean; loginMode: 'active' | 'passive' | 'unknown' } {
    return { refreshable: true, loginMode: 'active' };
  }

  async processInfo(): Promise<ProcessInfo> {
    const usage = process.memoryUsage();
    return {
      running: true,
      pid: process.pid,
      cpu: 0,
      memoryMb: Math.round(usage.rss / 1024 / 1024),
      version: `duskfox-mock ${process.version} ${os.platform()}/${os.arch()}`,
      args: process.execArgv.join(' ') || '(无)',
    };
  }

  async controlProcess(action: 'start' | 'restart' | 'stop'): Promise<void> {
    if (action === 'stop') {
      await this.stop();
      this.#setStatus({ uin: '', nick: '', avatar: '', state: 'offline', online: false, loginType: 'none' });
      return;
    }
    if (action === 'restart') {
      await this.stop();
      await this.start();
      return;
    }
    await this.start();
  }

  #completeLogin(method: 'qr' | 'quick'): Promise<void> {
    this.#setStatus({ ...this.#status, state: 'logging' });
    return new Promise((resolve) => {
      setTimeout(() => {
        this.#qr = { state: 'none', seq: this.#qrSeq };
        this.#setStatus({
          uin: MOCK_UIN,
          nick: MOCK_NICK,
          avatar: AVATAR,
          state: 'online',
          online: true,
          loginType: method === 'qr' ? 'qr' : 'quick',
        });
        resolve();
      }, 600).unref?.();
    });
  }

  #issueQr(): void {
    if (this.#qrTimer) clearTimeout(this.#qrTimer);
    this.#qrSeq += 1;
    const seed = `${MOCK_UIN}:${this.#qrSeq}:${Date.now()}`;
    const { dataUrl } = syntheticQr(seed);
    const expiresAt = Date.now() + QR_TTL_MS;
    this.#qr = { state: 'waiting', image: dataUrl, expiresAt, seq: this.#qrSeq, refreshable: true, loginMode: 'active' };
    this.#context.emit({ type: 'qr', qr: this.#qr });
    this.#qrTimer = setTimeout(() => {
      if (this.#qr.state !== 'waiting') return;
      this.#qr = { ...this.#qr, state: 'expired' };
      this.#context.emit({ type: 'qr', qr: this.#qr });
    }, QR_TTL_MS);
    this.#qrTimer.unref?.();
  }

  #setStatus(next: AccountStatus): void {
    this.#status = next;
    this.#context.emit({ type: 'state', status: next });
  }

  #peerName(scene: 'private' | 'group', peerId: string): string | undefined {
    if (scene === 'group') return GROUPS.find((group) => group.id === peerId)?.name;
    return FRIENDS.find((friend) => friend.id === peerId)?.name;
  }

  #simulateTraffic(): void {
    if (!this.#status.online) return;
    const friend = FRIENDS[Math.floor(Math.random() * FRIENDS.length)];
    if (!friend) return;
    const segments: Segment[] = [{ type: 'text', data: { text: '模拟消息：联调心跳正常' } }];
    this.#push({
      scene: 'private',
      messageId: `mock-in-${Date.now().toString(36)}-${(this.#counter += 1)}`,
      time: Math.floor(Date.now() / 1000),
      self: false,
      peer: { id: friend.id, name: friend.name },
      sender: { id: friend.id, name: friend.name },
      segments,
    });
  }

  #push(message: InboundMessage): void {
    this.#inbox.unshift(message);
    if (this.#inbox.length > 200) this.#inbox.pop();
    this.#context.emit({ type: 'message', message });
  }
}

/** Stable message id helper shared by tests that need to assert on ids. */
export function mockMessageId(seed: string): string {
  return `mock-${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 10)}`;
}
