import type { AccountStatus, InboundMessage } from '../core/model.ts';
import type { AccountDriver, Capabilities, DriverContext, DriverOptions } from './types.ts';
import { RuntimeState } from './runtime-state.ts';
import { BridgeTransport } from './bridge/transport.ts';
import { BridgeEvents } from './bridge/events.ts';
import { BridgeOperations } from './bridge/operations.ts';
import { LoginCoordinator } from './login/coordinator.ts';
import type { BridgeStatusPayload } from './bridge/contract.ts';

/** Composition and polling only. Native details remain behind the HTTP contract. */
export class BridgeDriver implements AccountDriver {
  readonly id = 'bridge';
  readonly name = 'QQ 原生桥接';
  readonly description = '连接独立 QQ 原生运行时，官方客户端负责账号会话，DF 接入消息与动作。';
  readonly #runtime: RuntimeState;
  readonly #transport: BridgeTransport;
  readonly #events: BridgeEvents;
  readonly #operations: BridgeOperations;
  readonly #login: LoginCoordinator;
  #statusTimer: ReturnType<typeof setInterval> | null = null;
  #eventTimer: ReturnType<typeof setInterval> | null = null;
  #outboundConfig: Record<string, unknown> | null = null;
  #outboundInstance = '';

  async configureOutbound(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#outboundConfig = { ...config };
    let result: Record<string, unknown>;
    try {
      result = await this.#transport.request<Record<string, unknown>>('/api/outbound/config', 'PUT', config);
    } catch (error) {
      if (!String(error).includes('HTTP 400')) this.#operations.setFileMaxBytes(config.fileMaxBytes);
      throw error;
    }
    this.#operations.setFileMaxBytes((result.config as Record<string, unknown> | undefined)?.fileMaxBytes ?? config.fileMaxBytes);
    this.#outboundInstance = this.#runtime.instance;
    return result;
  }

  async outboundStatus(): Promise<Record<string, unknown>> {
    return this.#transport.request<Record<string, unknown>>('/api/outbound/config');
  }

  readonly login: NonNullable<AccountDriver['login']>;
  readonly quickList: NonNullable<AccountDriver['quickList']>;
  readonly logout: NonNullable<AccountDriver['logout']>;
  readonly qrCode: NonNullable<AccountDriver['qrCode']>;
  readonly refreshQr: NonNullable<AccountDriver['refreshQr']>;
  readonly qrInfo: NonNullable<AccountDriver['qrInfo']>;
  readonly sendMessage: NonNullable<AccountDriver['sendMessage']>;
  readonly recall: NonNullable<AccountDriver['recall']>;
  readonly friendList: NonNullable<AccountDriver['friendList']>;
  readonly groupList: NonNullable<AccountDriver['groupList']>;
  readonly strangerInfo: NonNullable<AccountDriver['strangerInfo']>;
  readonly groupMemberInfo: NonNullable<AccountDriver['groupMemberInfo']>;
  readonly groupMemberList: NonNullable<AccountDriver['groupMemberList']>;
  readonly handleRequest: NonNullable<AccountDriver['handleRequest']>;
  readonly processInfo: NonNullable<AccountDriver['processInfo']>;
  readonly fetchMessage: NonNullable<AccountDriver['fetchMessage']>;
  readonly fetchMedia: NonNullable<AccountDriver['fetchMedia']>;
  readonly fetchForward: NonNullable<AccountDriver['fetchForward']>;

  constructor(context: DriverContext, options: DriverOptions) {
    this.#runtime = new RuntimeState(context);
    const endpoint = (options.endpoint || process.env.DUSKFOX_BRIDGE_URL || 'http://127.0.0.1:16082').replace(/\/+$/, '');
    this.#transport = new BridgeTransport(endpoint, options.token || process.env.DUSKFOX_BRIDGE_TOKEN || '');
    this.#events = new BridgeEvents(this.#runtime, this.#transport);
    this.#operations = new BridgeOperations(this.#runtime, this.#transport, this.#events);
    this.#login = new LoginCoordinator(this.#runtime, this.#transport);
    this.login = this.#login.login.bind(this.#login);
    this.quickList = this.#login.quickList.bind(this.#login);
    this.logout = this.#login.logout.bind(this.#login);
    this.qrCode = this.#login.qrCode.bind(this.#login);
    this.refreshQr = this.#login.refreshQr.bind(this.#login);
    this.qrInfo = this.#login.qrInfo.bind(this.#login);
    this.sendMessage = this.#operations.sendMessage.bind(this.#operations);
    this.recall = this.#operations.recall.bind(this.#operations);
    this.friendList = this.#operations.friendList.bind(this.#operations);
    this.groupList = this.#operations.groupList.bind(this.#operations);
    this.strangerInfo = this.#operations.strangerInfo.bind(this.#operations);
    this.groupMemberInfo = this.#operations.groupMemberInfo.bind(this.#operations);
    this.groupMemberList = this.#operations.groupMemberList.bind(this.#operations);
    this.handleRequest = this.#operations.handleRequest.bind(this.#operations);
    this.processInfo = this.#operations.processInfo.bind(this.#operations);
    this.fetchMessage = this.#operations.fetchMessage.bind(this.#operations);
    this.fetchMedia = this.#operations.fetchMedia.bind(this.#operations);
    this.fetchForward = this.#operations.fetchForward.bind(this.#operations);
  }

  get capabilities(): Capabilities { return this.#runtime.caps; }
  async status(): Promise<AccountStatus> { return this.#runtime.status; }
  events(): readonly InboundMessage[] { return this.#runtime.inbox; }

  async start(): Promise<void> {
    if (this.#runtime.started) return;
    this.#runtime.started = true;
    this.#runtime.startedAt = Date.now();
    this.#runtime.historyFloor = 0;
    await this.#refreshStatus();
    this.#statusTimer = setInterval(() => void this.#refreshStatus(), 2000);
    this.#statusTimer.unref?.();
    this.#eventTimer = setInterval(() => void this.#events.pollEvents(), 1000);
    this.#eventTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.#runtime.started = false;
    if (this.#statusTimer) clearInterval(this.#statusTimer);
    if (this.#eventTimer) clearInterval(this.#eventTimer);
    this.#statusTimer = null;
    this.#eventTimer = null;
    this.#runtime.setStatus({
      ...this.#runtime.status, state: 'offline', online: false,
      sessionState: 'unknown', bridgeReachable: false, messageReady: false, detail: '已停止'
    });
  }

  async #refreshStatus(): Promise<void> {
    const runtime = this.#runtime;
    if (runtime.polling || !runtime.started) return;
    runtime.polling = true;
    try {
      const payload = await this.#transport.request<BridgeStatusPayload>('/api/status');
      this.#login.applyLoginMode(payload.login_mode);
      runtime.applyStatus(payload);
      if (this.#outboundConfig && this.#outboundInstance !== runtime.instance) {
        try { await this.configureOutbound(this.#outboundConfig); }
        catch (error) { runtime.context.logger.failure('driver:bridge', '重推出站配置失败', error); }
      }
      await this.#login.reconcile(payload);
    } catch (error) {
      runtime.unreachable(error);
    } finally {
      runtime.polling = false;
    }
  }
}
