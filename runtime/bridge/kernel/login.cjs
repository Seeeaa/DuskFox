'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */
const { logoutMarkerPath, clearLogoutMarker, readLoginAt, writeLoginAt, rememberAccount } = require('./meta.cjs');

class LoginDomain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  get quickLoginSupported() {
    // NC 用的是 quickLoginWithUin；quickLogin 是旧命名，存在兼容差异。
    return Boolean(
      this.ctx.state.loginService &&
      (typeof this.ctx.state.loginService.quickLoginWithUin === 'function' ||
        typeof this.ctx.state.loginService.quickLogin === 'function'),
    );
  }

  /** 本机已登录账号（快速登录列表）。 */
  async quickList() {
    if (!this.ctx.state.loginService) return [];
    let raw = null;
    for (const attempt of [
      () => this.ctx.state.loginService.getLoginList(),
      () => this.ctx.state.loginService.getLoginList(''),
    ]) {
      try { raw = await attempt(); } catch (error) { raw = null; }
      if (raw) break;
    }
    const list = raw && (raw.LocalLoginInfoList || raw.localLoginInfoList || raw.list || raw);
    return (Array.isArray(list) ? list : []).filter((item) => item && (item.isQuickLogin === undefined || item.isQuickLogin)).map((item) => ({
      uin: String(item.uin || item.uid || ''),
      nickname: String(item.nickName || item.nick || item.name || ''),
      avatar: String(item.avatarUrl || item.avatar || ''),
    })).filter((item) => item.uin);
  }

  /** 快速登录：失败时明确报错，由上层回退扫码。 */
  async quickLogin(uin) {
    if (!this.ctx.state.loginService) throw new Error('登录服务尚未就绪');
    if (!this.quickLoginSupported) throw new Error('当前客户端未提供快速登录接口');
    const call = this.ctx.state.loginService.quickLoginWithUin || this.ctx.state.loginService.quickLogin;
    const res = await call.call(this.ctx.state.loginService, String(uin));
    const code = String((res && res.result) ?? '');
    const errMsg = res && res.loginErrorInfo && res.loginErrorInfo.errMsg;
    if ((code && code !== '0' && code !== 'undefined') || errMsg) {
      throw new Error('快速登录失败：' + (errMsg || code));
    }
    if (code !== '0') return { accepted: true };
    this.ctx.state.uin = String(uin);
    this.ctx.state.loggedOut = false;
    rememberAccount(this.ctx.state.uin);
    this.ctx.state.loginAt = 0;
    this.markOnline();
    clearLogoutMarker();
    this.ctx.state.loginSucceeded = true;
    this.ctx.state.invalidatedSession = null;
    // 消息服务稍后由 attach 循环补上；旧绑定先作废。
    this.ctx.kernel.invalidateBinding();
    // 消息服务稍后由 attach 循环补上。
    this.ctx.state.probe.reconnects = (this.ctx.state.probe.reconnects || 0) + 1;
    return { accepted: true };
  }

  /**
     * 直接 require wrapper.node 注册登录监听：不再依赖 dlopen 观测门控。
     * 【待实机验证】如果 QQ 尚未加载 wrapper.node，require 会抛错，这里退避重试。
     */
  attach() {
    if (this.ctx.state.listenerReady) return;
    if (this.ctx.options.wrapperObserved && !this.ctx.options.wrapperObserved()) return;
    let native;
    try {
      native = require('../wrapper.node');
    } catch (error) {
      return;
    }
    try {
      this.ctx.state.loginService = native.NodeIKernelLoginService.get();
      const self = this;
      const listener = new Proxy(
        {
          onQRCodeGetPicture(value) {
            const data = value && value.pngBase64QrcodeData;
            if (typeof data !== 'string') return;
            const base64 = data.replace(/^data:image\/png;base64,/, '');
            if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return;
            self.ctx.state.probe.qrPictures += 1;
            self.ctx.state.qrSeq += 1;
            self.ctx.state.qr = { picture: base64, seq: self.ctx.state.qrSeq, expiresAt: Date.now() + 120_000 };
            self.ctx.state.qrState = 'waiting';
          },
          onQRCodeSessionUserScaned() {
            self.ctx.state.probe.qrScans += 1;
            self.ctx.state.qrState = 'scanned';
          },
          onQRCodeLoginSucceed(result) {
            self.ctx.state.probe.qrSuccesses += 1;
            const uin = String((result && result.uin) || '');
            if (!/^[1-9]\d{4,11}$/.test(uin)) return;
            self.ctx.state.uin = uin;
            self.ctx.state.qrState = 'confirmed';
            self.ctx.state.qr = null;
            self.ctx.state.loginSucceeded = true;
            self.ctx.state.invalidatedSession = null;
            // 同一会话可能被复用，登录成功后旧监听一律作废，下一轮 attach 重绑。
            self.ctx.kernel.invalidateBinding();
            // 扫码成功后清掉登出标记：否则下次重启会被判定为已登出，逼用户重新扫码。
            self.ctx.state.loggedOut = false;
            rememberAccount(uin);
            self.ctx.state.loginAt = 0;
            self.markOnline();
            clearLogoutMarker();
            self.ctx.kernel.refreshMsf();
          },
          onQRCodeSessionFailed() {
            if (self.ctx.kernel.online) return;
            self.ctx.state.qrState = 'expired';
            self.ctx.state.qr = null;
          },
          onLoginFailed() {
            if (!self.ctx.kernel.online) self.ctx.state.qrState = 'expired';
          },
          onUserLoggedIn(userId) {
            const uin = String(userId ?? '');
            if (!/^[1-9]\d{4,11}$/.test(uin)) return;
            if (self.ctx.state.uin !== uin || !self.ctx.kernel.authorized) {
              self.ctx.state.loginAt = 0;
              self.ctx.kernel.invalidateBinding();
            }
            self.ctx.state.uin = uin;
            self.ctx.state.loginSucceeded = true;
            self.ctx.state.invalidatedSession = null;
            if (self.ctx.state.msgService) self.markOnline();
          },
          onLoginConnected() { self.ctx.state.probe.loginConnected += 1; },
          onLoginDisConnected() {
            // 只清 msgService 会让重连后复用旧监听（客户端可能已丢弃它），必须让绑定一起失效。
            self.ctx.kernel.invalidateBinding();
            self.ctx.kernel.refreshMsf();
          },
          onLogoutSucceed() { self.ctx.kernel.invalidateSession(); },
        },
        {
          get(target, key) {
            if (key in target) return target[key];
            if (typeof key === 'string' && key.startsWith('on')) return () => { };
            return undefined;
          },
        },
      );
      this.ctx.state.loginService.addKernelLoginListener(listener);
      this.ctx.state.loginListener = listener;
      this.ctx.state.listenerReady = true;
    } catch (error) {
      this.ctx.state.probe.lastAttachError = String(error?.stack || error);
      console.error('[bridge] login listener attachment failed:', error);
      // 登录服务尚未可用：保持未就绪，下一轮重试。
    }
  }

  /**
     * 主动请求二维码。旧桥接的 SIGABRT 无法归因，这里只在拿到 loginService 后调用，
     * 并把串行/冷却交给 server（single-flight + 90s），本函数只做一次调用。
     * 【待实机验证】调用时机是否安全。
     */
  async requestQr() {
    if (!this.ctx.state.loginService) throw new Error('登录服务尚未就绪');
    this.ctx.state.loginService.getQRCodePicture();
    return true;
  }

  currentQr() {
    if (!this.ctx.state.qr) return null;
    if (Date.now() > this.ctx.state.qr.expiresAt) return { picture: null, seq: this.ctx.state.qr.seq, expiresAt: this.ctx.state.qr.expiresAt, expired: true };
    return { picture: this.ctx.state.qr.picture, seq: this.ctx.state.qr.seq, expiresAt: this.ctx.state.qr.expiresAt, expired: false };
  }

  /**
     * 标记账号在线并记录登录起始时间。
     * 有落盘记录且是同一个号就沿用（QQ 容器重启不等于重新登录），否则从现在开始计时。
     */
  markOnline() {
    if (!this.ctx.state.loginAt && this.ctx.state.uin) {
      const saved = readLoginAt();
      this.ctx.state.loginAt = saved && saved.uin && saved.uin === String(this.ctx.state.uin || '') ? saved.at : Date.now();
      writeLoginAt(this.ctx.state.loginAt, String(this.ctx.state.uin || ''));
    }
  }

  /**
     * 密码登录。密码只在运行时内存里转成 md5，不落盘、不写日志。
     * 【待实机验证】passwordLogin 的参数、错误码与后续 onLoginConnected 时序。
     */
  async login({ method, uin, password }) {
    if (method !== 'password') throw new Error('原生内核仅实现密码登录');
    if (!this.ctx.state.loginService) throw new Error('登录服务尚未就绪');
    if (!/^\d{5,12}$/.test(String(uin || ''))) throw new Error('QQ 号格式不正确');
    if (typeof password !== 'string' || password.length === 0) throw new Error('密码不能为空');
    const crypto = require('node:crypto');
    const passwordMd5 = crypto.createHash('md5').update(password, 'utf8').digest('hex');
    const res = await this.ctx.state.loginService.passwordLogin({
      uin: String(uin),
      passwordMd5,
      step: 0,
      newDeviceLoginSig: new Uint8Array(),
      proofWaterSig: new Uint8Array(),
      proofWaterRand: new Uint8Array(),
      proofWaterSid: new Uint8Array(),
      unusualDeviceCheckSig: new Uint8Array(),
    });
    const code = String((res && res.result) ?? '');
    if (code === '140022008') throw new Error('需要验证码（proofWaterUrl），当前版本未实现验证码流程');
    if (code === '140022010') throw new Error('新设备需要扫码验证（jumpUrl），请先用扫码登录一次');
    if (code && code !== '0' && code !== 'undefined') throw new Error('密码登录失败：' + code);
    if (code === '0' && !res?.loginErrorInfo?.errMsg) {
      this.ctx.state.uin = String(uin);
      this.ctx.state.loginSucceeded = true;
      this.ctx.state.loginAt = 0;
      this.ctx.kernel.invalidateBinding();
    }
    this.ctx.state.invalidatedSession = null;
    return { accepted: true };
  }

  /** 退出登录：客户端只提供了 destroy/cancel，没有正式 logout 接口。 */
  async logout() {
    // 客户端没有真正的 logout：写标记并结束进程，由容器 restart 策略拉回登录页。
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    this.ctx.state.loggedOut = true;
    this.ctx.kernel.invalidateSession();
    try { fs.writeFileSync(logoutMarkerPath(), String(Date.now())); } catch (error) { /* 忽略 */ }
    this.ctx.state.session = null;
    setTimeout(() => process.exit(0), 800);
    return { accepted: true };
  }

  get logoutSupported() {
    return Boolean(this.ctx.state.loginService && (typeof this.ctx.state.loginService.destroy === 'function' || typeof this.ctx.state.loginService.cancel === 'function'));
  }
}

module.exports = { LoginDomain };
