import type { LoginRequest, QrPayload } from '../../core/model.ts';
import type { RuntimeState } from '../runtime-state.ts';
import type { BridgeStatusPayload } from '../bridge/contract.ts';
import type { BridgeTransport } from '../bridge/transport.ts';
/** Only explicit user login commands start authentication; status reads never do. */
export class LoginCoordinator {
  readonly state: RuntimeState;
  readonly transport: BridgeTransport;
  constructor(state: RuntimeState, transport: BridgeTransport) {
    this.state = state;
    this.transport = transport;
  }
  async reconcile(payload: BridgeStatusPayload): Promise<void> {
    const authorized = this.state.status.sessionState === 'authorized';
    const nativeReady = this.state.status.online;
    if (authorized && Date.now() >= this.state.manualReloginUntil)
      this.state.qr = { state: 'none', seq: this.state.qr.seq };
    if (nativeReady && !payload?.qr_ready && this.state.qr.image && this.state.manualReloginUntil > 0) {
      this.state.manualReloginUntil = 0;
      this.state.qr = { state: 'none', seq: this.state.qr.seq };
    }
    if (!authorized && payload?.qr_ready && !this.state.qr.image)
      await this.fetchQr();
    this.publishQr();
  }
  async login(request: LoginRequest): Promise<void> {
    if (request.method === 'qr') {
      await this.refreshQr();
      return;
    }
    if (request.method === 'password') {
      if (!this.state.caps.passwordLogin)
        throw new Error('当前运行时未启用密码登录');
      const uin = String(request.uin ?? '').trim();
      const password = String(request.password ?? '');
      if (!/^\d{5,12}$/.test(uin))
        throw new Error('QQ 号格式不正确');
      if (!password)
        throw new Error('密码不能为空');
      // The runtime md5s the password in memory; it is never persisted or logged.
      await this.transport.request('/api/login', 'POST', { method: 'password', uin, password });
      return;
    }
    if (request.method === 'quick') {
      if (!this.state.caps.quickLogin)
        throw new Error('当前运行时未启用快速登录');
      const uin = String(request.uin ?? '').trim();
      if (!/^\d{5,12}$/.test(uin))
        throw new Error('QQ 号格式不正确');
      await this.transport.request('/api/login', 'POST', { method: 'quick', uin });
      return;
    }
    throw new Error('桥接驱动仅支持扫码、快速或密码登录');
  }
  async quickList(): Promise<Array<{
    uin: string;
    nickname: string;
    avatar?: string;
  }>> {
    if (!this.state.caps.quickLogin)
      return [];
    const payload = await this.transport.request<{
      items?: Array<{
        uin?: string;
        nickname?: string;
        avatar?: string;
      }>;
    }>('/api/quick-list');
    return (payload?.items ?? [])
      .map((item) => ({ uin: String(item.uin ?? ''), nickname: String(item.nickname ?? ''), avatar: String(item.avatar ?? '') }))
      .filter((item) => item.uin);
  }
  async logout(): Promise<void> {
    if (!this.state.caps.logout)
      throw new Error('当前运行时未提供退出登录接口');
    await this.transport.request('/api/logout', 'POST', {});
  }
  async qrCode(): Promise<QrPayload> {
    if (!this.state.status.online)
      await this.fetchQr();
    const payload = this.composeQr();
    // A simulated runtime hands out placeholder bytes, not a scannable code.
    return this.state.simulated ? { ...payload, mock: true } : payload;
  }
  /**
     * Ask the runtime for a new login code.
     *
     * Passive runtimes answer 409 because only the QQ window can request a code;
     * active ones answer 202 and deliver the picture through GET /api/qr, so the
     * refresh has to wait for it instead of returning an empty payload.
     */
  async refreshQr(force = false): Promise<QrPayload> {
    if (this.state.loginMode === 'passive') {
      this.state.qrRefreshable = false;
      this.state.qrHint = '被动模式：请在 QQ 客户端窗口里刷新二维码，本控制台会同步显示';
      this.publishQr();
      return this.composeQr();
    }
    try {
      const payload = await this.transport.request<{
        picture?: string;
        image?: string;
        expires_at?: number;
        seq?: number;
        available?: boolean;
        accepted?: boolean;
      }>(force ? '/api/qr/refresh?force=1' : '/api/qr/refresh', 'POST');
      if (force)
        this.state.manualReloginUntil = Date.now() + 120000;
      this.state.qrRefreshable = true;
      this.state.qrHint = '';
      if (payload.picture ?? payload.image) {
        this.state.qr = this.qrFromPayload(payload);
        this.publishQr();
        return this.composeQr();
      }
      // 202 accepted: poll until the asynchronous picture shows up.
      const before = this.state.qr.image;
      await this.awaitQr(before, 6000);
      return this.composeQr();
    }
    catch (error) {
      if (force)
        this.state.manualReloginUntil = 0;
      const detail = error instanceof Error ? error.message : String(error);
      if (detail.includes('HTTP 409')) {
        this.state.qrRefreshable = false;
        this.state.qrHint = '被动模式：请在该 QQ 窗口内刷新二维码，本控制台会同步显示';
        this.publishQr();
        return this.composeQr();
      }
      if (detail.includes('HTTP 404') || detail.includes('HTTP 503')) {
        this.state.qrHint = `运行时暂时无法生成二维码：${detail}`;
        this.publishQr();
        return this.composeQr();
      }
      throw error;
    }
  }
  qrInfo(): {
    refreshable: boolean;
    loginMode: 'active' | 'passive' | 'unknown';
  } {
    return { refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode };
  }
  async fetchQr(): Promise<void> {
    try {
      const response = await this.transport.request<{
        picture?: string;
        image?: string;
        expires_at?: number;
        seq?: number;
        available?: boolean;
        phase?: string;
        login_mode?: 'active' | 'passive';
        state?: string;
        hint?: string;
        refreshable?: boolean;
      }>('/api/qr');
      if (response?.phase)
        this.state.phase = response.phase;
      if (response?.login_mode)
        this.applyLoginMode(response.login_mode);
      if (response?.state === 'none' && response?.hint) {
        // Authorised: the runtime intentionally returns no picture, only a hint.
        this.state.qr = {
          state: 'none',
          seq: Number(response.seq ?? this.state.qr.seq),
          refreshable: response.refreshable === true,
          loginMode: this.state.loginMode,
          hint: String(response.hint),
        };
      }
      else {
        const next = this.qrFromPayload(response);
        if (next.image !== this.state.qr.image)
          this.state.qr = next;
      }
      this.publishQr();
    }
    catch (error) {
      // A 404 means the runtime has no code right now (async request pending),
      // which is a state, not a transport failure.
      if (!(error instanceof Error && error.message.includes('HTTP 404')))
        throw error;
      this.publishQr();
    }
  }
  qrFromPayload(payload: {
    picture?: string;
    image?: string;
    expires_at?: number;
    seq?: number;
    available?: boolean;
    mode?: string;
  } | null): QrPayload {
    if (payload && typeof payload.mode === 'string')
      this.state.simulated = payload.mode === 'sim';
    const picture = payload?.picture ?? payload?.image;
    if (!payload || payload.available === false || !picture) {
      return { state: this.state.status.online ? 'none' : 'expired', seq: this.state.qr.seq };
    }
    const image = picture.startsWith('data:') ? picture : `data:image/png;base64,${picture}`;
    if (image !== this.state.qr.image)
      this.state.qrSeenAt = Date.now();
    const expires = payload.expires_at
      ? payload.expires_at * (payload.expires_at < 1e12 ? 1000 : 1)
      : (this.state.qrSeenAt || Date.now()) + 120000;
    return {
      state: 'waiting',
      image,
      expiresAt: expires,
      seq: Math.max(this.state.qr.seq, payload.seq ?? 0) || 1,
      refreshable: this.state.qrRefreshable,
      loginMode: this.state.loginMode,
    };
  }
  /**
     * Map the native login phase onto the console's QR states.
     *
     * The native runtime is the source of truth: it knows whether a code is on
     * screen (`scan_qr`), already scanned (`confirm_on_phone`), failed
     * (`qr_failed`) or irrelevant because the session is authenticated.
     */
  composeQr(): QrPayload {
    const seq = this.state.qr.seq;
    // Logged in: a previously cached picture is stale, never show it again.
    if ((this.state.status.online || (this.state.status.sessionState === 'authorized' && this.state.status.messageReady)) &&
      Date.now() >= this.state.manualReloginUntil) {
      return { state: 'none', seq, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode };
    }
    if (Date.now() < this.state.manualReloginUntil && this.state.qr.image) {
      return this.state.qr.expiresAt && Date.now() > this.state.qr.expiresAt
        ? { ...this.state.qr, state: 'expired', hint: '二维码已过期，请重新取码' }
        : { ...this.state.qr, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode };
    }
    // Authorised: keep the runtime's explanation instead of falling back to QR.
    if (this.state.qr.state === 'none' && this.state.qr.hint)
      return this.state.qr;
    // The runtime phase is authoritative: a cached picture must not hide
    // "already scanned" / "authenticated" / "failed" transitions.
    if (this.state.phase === 'confirm_on_phone') {
      return { state: 'scanned', seq, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode, hint: '已扫码，请在手机上确认登录' };
    }
    if (this.state.phase === 'authenticated') {
      return { state: 'confirmed', seq, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode };
    }
    if (this.state.phase === 'qr_failed' && !this.state.qr.image) {
      return { state: 'expired', seq, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode, hint: this.state.qrHint || '二维码会话失败，请刷新重试' };
    }
    if (this.state.qr.image && this.state.qr.expiresAt && Date.now() > this.state.qr.expiresAt) {
      return { ...this.state.qr, state: 'expired', hint: '二维码已过期，请刷新' };
    }
    if (this.state.qr.image) {
      return { ...this.state.qr, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode };
    }
    if (this.state.status.online)
      return { state: 'none', seq, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode };
    switch (this.state.phase) {
      case 'confirm_on_phone':
        return { state: 'scanned', seq, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode, hint: '已扫码，请在手机上确认登录' };
      case 'qr_failed':
        return { state: 'expired', seq, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode, hint: this.state.qrHint || '二维码会话失败，请刷新重试' };
      case 'authenticated':
        return { state: 'confirmed', seq, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode };
      case 'waiting_official_qq_login':
        return {
          state: 'unavailable',
          seq,
          refreshable: this.state.qrRefreshable,
          loginMode: this.state.loginMode,
          hint: this.state.qrHint ||
            '运行时处于被动模式：需要在 QQ 客户端窗口点开“扫码登录”，二维码会自动同步到这里',
        };
      case 'starting':
      case 'checking_session':
        return {
          state: 'unavailable',
          seq,
          refreshable: this.state.qrRefreshable,
          loginMode: this.state.loginMode,
          hint: '运行时正在初始化登录服务，请稍候',
        };
      case 'error':
        return { state: 'unavailable', seq, refreshable: this.state.qrRefreshable, loginMode: this.state.loginMode, hint: this.state.qrHint || '运行时报告登录错误' };
      default:
        return {
          state: 'unavailable',
          seq,
          refreshable: this.state.qrRefreshable,
          loginMode: this.state.loginMode,
          hint: this.state.qrHint || '尚未获取到可扫描的二维码',
        };
    }
  }
  /** Emit a QR update only when the console would actually see a change. */
  publishQr(): void {
    const next = this.composeQr();
    if (JSON.stringify(next) === JSON.stringify(this.state.qr))
      return;
    this.state.qr = next;
    this.state.context.emit({ type: 'qr', qr: next });
  }
  /** Poll GET /api/qr until a (new) picture arrives or the timeout elapses. */
  async awaitQr(previous: string | undefined, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await this.fetchQr();
      if (this.state.qr.image && this.state.qr.image !== previous)
        return;
      if (this.state.phase === 'qr_failed' || this.state.phase === 'error')
        return;
    }
  }
  /**
     * Passive runtimes can only mirror the code the QQ window asks for, so the
     * console must not offer a refresh button that can never work.
     */
  applyLoginMode(mode?: 'active' | 'passive'): void {
    if (!mode)
      return;
    this.state.loginMode = mode;
    this.state.qrRefreshable = mode === 'active';
    if (mode === 'passive') {
      this.state.qrHint = '被动模式：需要在 QQ 客户端窗口里打开“扫码登录”，二维码会自动同步到这里';
    }
    else {
      this.state.qrHint = '';
    }
  }
}
