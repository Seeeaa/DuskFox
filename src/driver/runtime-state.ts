import type { AccountStatus, InboundMessage, QrPayload } from '../core/model.ts';
import type { Capabilities, DriverContext } from './types.ts';
import { capabilityMap } from './types.ts';
import { readLegacyCapabilities } from './bridge/legacy-capabilities.ts';
import type { BridgeStatusPayload } from './bridge/contract.ts';
/** One account/runtime snapshot, shared by login, actions and event polling. */
export class RuntimeState {
  readonly context: DriverContext;
  constructor(context: DriverContext) {
    this.context = context;
  }
  /** Capabilities are replaced from the current runtime report. */
  caps: Capabilities = capabilityMap({});
  status: AccountStatus = {
    uin: '',
    nick: '',
    avatar: '',
    state: 'starting',
    online: false,
    sessionState: 'unknown',
    bridgeReachable: false,
    messageReady: false,
    loginType: 'none',
    detail: '尚未连接桥接服务',
  };
  qr: QrPayload = { state: 'none', seq: 0 };
  cursor = 0;
  eventInstance = '';
  started = false;
  polling = false;
  eventPolling = false;
  /** 连续事件轮询失败次数：进入状态与日志，别让断流伪装成在线。 */
  pollFailures = 0;
  lastError = '';
  loginMode: 'active' | 'passive' | 'unknown' = 'unknown';
  /** Native phase reported by the runtime (waiting_login, scan_qr, ...). */
  phase = '';
  /** True when the runtime reports itself as a simulated kernel. */
  simulated = false;
  /** Contract version and instance id reported by the runtime. */
  contract = 1;
  instance = '';
  pendingReported = false;
  qrRefreshable = true;
  /** When the current QR image was first observed, used to derive expiry. */
  qrSeenAt = 0;
  qrHint = '';
  manualReloginUntil = 0;
  /** Driver start time; event delivery is governed by the bridge cursor. */
  startedAt = 0;
  /** Compatibility field; zero disables startup history filtering. */
  historyFloor = 0;
  /** 账号这次登录的起始时间（毫秒）：运行时长按它算，而不是按页面打开时间。 */
  onlineSince = 0;
  /** Whether this QQ session has entered message readiness. */
  wasOnline = false;
  readonly inbox: InboundMessage[] = [];
  applyStatus(payload: BridgeStatusPayload): void {
    this.phase = payload?.phase ?? '';
    if (typeof payload?.mode === 'string')
      this.simulated = payload.mode === 'sim';
    this.applyFeatures(payload);
    if (Array.isArray(payload?.pending_native) && !this.pendingReported && payload.pending_native.length > 0) {
      this.pendingReported = true;
      this.context.logger.warn('driver:bridge', `运行时报告 ${payload.pending_native.length} 项待实机验证的原生调用：${payload.pending_native.join('；')}`);
    }
    const uin = payload?.self_id ? String(payload.self_id) : '';
    // 新 bridge 给原始服务位，旧 bridge 只有 message_ready（旧义），按可观察事实降级。
    const messageReady = typeof payload?.message_service_ready === 'boolean'
      ? payload.message_service_ready
      : Boolean(payload?.message_ready);
    const sessionState = payload?.account_state ??
      (payload?.authorized || (messageReady && uin) ? 'authorized' : 'unknown');
    const authorized = sessionState === 'authorized';
    const nativeReady = authorized && messageReady && Boolean(uin);
    // 事件流故障只影响"接收"，不得翻转发送能力与账号状态。
    // online = 已授权 && 消息服务就绪；事件流健康单独用 detail 与接收侧告警表达。
    const eventStreamDown = this.pollFailures >= 3;
    const online = nativeReady;
    const waitingFor = messageReady ? '账号身份' : '消息服务';
    // 运行时长以“账号本次登录”为准：桥接侧持久化的 login_at 优先，
    // 这样刷新页面或重启控制台都不会把计时清零。
    const bridgeLoginAt = Number(payload?.login_at ?? 0) || 0;
    if (nativeReady) {
      const newLogin = bridgeLoginAt > 0 && bridgeLoginAt !== this.onlineSince;
      if (bridgeLoginAt > 0)
        this.onlineSince = bridgeLoginAt;
      else if (!this.onlineSince)
        this.onlineSince = Date.now();
      // Backlog is delivered from the saved cursor, including messages older than startup.
      if (!this.wasOnline || newLogin) {
        this.wasOnline = true;
        this.historyFloor = 0;
        this.context.logger.info('driver:bridge', '账号上线：按事件游标交付积压消息');
      }
    }
    else if (sessionState === 'signed_out') {
      this.onlineSince = 0;
      this.wasOnline = false;
    }
    const next: AccountStatus = {
      uin: authorized || online ? uin : '',
      nick: authorized || online ? String(payload?.nickname ?? '') : '',
      avatar: authorized || online ? String(payload?.avatar ?? '') : '',
      state: online ? 'online' : authorized ? 'logging' : 'offline',
      online,
      sessionState,
      bridgeReachable: true,
      messageReady,
      loginType: nativeReady ? 'session' : authorized ? 'qr' : 'none',
      detail: online
        ? eventStreamDown
          ? `QQ 在线，但事件流连续失败 ${this.pollFailures} 次：当前只能发送、收不到新消息`
          : undefined
        : authorized
          ? `QQ 已授权，正在等待${waitingFor}就绪`
          : sessionState === 'signed_out'
            ? 'QQ 会话已退出或失效，请在账号页重新登录'
            : '桥接服务在线，尚未确认 QQ 登录状态',
      ...(authorized && this.onlineSince ? { onlineSince: this.onlineSince } : {}),
    };
    this.lastError = '';
    this.setStatus(next);
  }
  unreachable(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail !== this.lastError) {
      this.lastError = detail;
      this.context.logger.warn('driver:bridge', `桥接服务不可用：${detail}`);
    }
    this.phase = 'error';
    this.setStatus({
      uin: '',
      nick: '',
      avatar: '',
      state: 'error',
      online: false,
      sessionState: 'unknown',
      bridgeReachable: false,
      messageReady: false,
      loginType: 'none',
      detail,
    });
  }
  /** v3 reports are consumed verbatim; older reports use one isolated adapter. */
  applyFeatures(payload: BridgeStatusPayload): void {
    const contract = Number(payload.contract ?? 1);
    const instance = String(payload.instance ?? '');
    const changed = contract !== this.contract || (instance && this.instance && instance !== this.instance);
    this.contract = contract;
    if (instance) this.instance = instance;
    this.caps = payload.capabilities ?? readLegacyCapabilities(payload);
    if (changed) this.context.logger.info('driver:bridge', `运行时契约更新：contract=${contract} instance=${instance || '?'}`);
  }

  setStatus(next: AccountStatus): void {
    const changed = JSON.stringify(this.status) !== JSON.stringify(next);
    this.status = next;
    if (changed)
      this.context.emit({ type: 'state', status: next });
  }
}
