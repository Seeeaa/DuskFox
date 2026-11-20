'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */
const { clearLogoutMarker, clearLoginAt } = require('./meta.cjs');

class SessionDomain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  // ---------------------------------------------------------------- 生命周期

  async start(emit) {
    this.ctx.state.emit = emit;
    if (this.ctx.state.attachTimer) return;
    this.ctx.state.stopped = false;
    const observe = () => {
      this.ctx.kernel.attach();
      this.refreshMsf();
      this.attachMessages();
    };
    observe();
    this.ctx.state.attachTimer = setInterval(observe, 2000);
    this.ctx.state.attachTimer.unref?.();
  }

  async stop() {
    clearInterval(this.ctx.state.attachTimer);
    this.ctx.state.attachTimer = null;
    // 软重启：停止期间不再新增绑定；旧绑定置为待重绑，
    // 期间到达的消息允许丢弃（emit 已置空），start 后必然重绑一次。
    this.ctx.state.stopped = true;
    this.invalidateBinding();
    this.ctx.state.emit = () => { };
  }

  get authorized() {
    return this.ctx.state.loginSucceeded && /^[1-9]\d{4,11}$/.test(this.ctx.state.uin);
  }

  get online() {
    return this.authorized && this.bindingValid();
  }

  refreshMsf() {
    try {
      const value = this.ctx.state.loginService ? this.ctx.state.loginService.getMsfStatus() : undefined;
      if (typeof value === 'number') {
        this.ctx.state.msfStatus = value;
        this.ctx.state.probe.msfStatus = value;
      }
    } catch (error) {
      // 待实机：该方法在部分版本不存在，保留上一次值。
    }
  }

  /**
     * 让消息绑定失效，但账号本身不一定失效。
     * 重登/换号/断开后必须走这里，下一次 attach 才会重新装监听。
     */
  invalidateBinding() {
    this.ctx.state.messageBinding = null;
    this.ctx.state.msgService = null;
  }

  invalidateSession() {
    this.ctx.state.invalidatedSession = this.ctx.state.session;
    this.ctx.state.sessionAccount = this.ctx.options.sessionAccount?.(this.ctx.state.session) ?? this.ctx.state.sessionAccount;
    this.ctx.state.loginSucceeded = false;
    this.ctx.state.messageBinding = null;
    this.ctx.state.msgService = null;
    this.ctx.state.loginAt = 0;
    this.ctx.state.qr = null;
    this.ctx.state.qrState = 'none';
    clearLoginAt();
  }

  /**
     * 绑定是否真的有效：会话、服务对象、监听 id 三者必须同时匹配。
     * 缓存对象存在不能单独作证（会话可能已换、监听可能已被客户端丢弃）。
     */
  bindingValid() {
    const binding = this.ctx.state.messageBinding;
    if (!binding || !this.ctx.state.session || !this.ctx.state.msgService) return false;
    return binding.session === this.ctx.state.session && binding.service === this.ctx.state.msgService && binding.id != null;
  }

  status() {
    const authorized = this.authorized;
    return {
      uin: authorized ? this.ctx.state.uin : '',
      loginAt: authorized ? this.ctx.state.loginAt : 0,
      nick: authorized ? this.ctx.state.nick : '',
      // 与 NapCat 一致：头像用 QQ 官方 qlogo 地址，由运行时（原生侧）生成。
      avatar: authorized ? 'https://q1.qlogo.cn/g?b=qq&nk=' + this.ctx.state.uin + '&s=640' : this.ctx.state.avatar,
      online: this.online,
      // 原始服务位：来自当前绑定，不是"曾经拿到过对象"。
      messageReady: this.bindingValid(),
      authorized,
      accountState: authorized ? 'authorized' : this.ctx.state.loggedOut || this.ctx.state.invalidatedSession ? 'signed_out' : 'unknown',
      msf: this.ctx.state.msfStatus,
      // 空闲时长单独暴露，只供控制台显示，不作为在线判据。
      idleMs: this.ctx.state.lastMsgAt > 0 ? Date.now() - this.ctx.state.lastMsgAt : 0,
      lastMsgAt: this.ctx.state.lastMsgAt,
    };
  }

  // ---------------------------------------------------------------- 会话

  /** 在 QQ 自己创建的会话上维持消息服务绑定。 */
  attachMessages() {
    // 软重启停止期间不建立新绑定（M7）。
    if (this.ctx.state.stopped) return;
    try {
      const captured = this.ctx.options.sessionProvider?.() || this.ctx.state.session;
      if (!captured && this.ctx.options.wrapperObserved && !this.ctx.options.wrapperObserved()) return;
      const session = captured ||
        require('../wrapper.node').NodeIQQNTWrapperSession?.getNTWrapperSession?.('nt_1');
      this.ctx.state.probe.sessionCaptured = Boolean(session);
      if (!session) return;
      const account = this.ctx.options.sessionAccount?.(session);
      const newAccount = Boolean(account && account !== this.ctx.state.sessionAccount);
      if (session === this.ctx.state.invalidatedSession && !newAccount) return;
      const sessionChanged = this.ctx.state.session !== null && this.ctx.state.session !== session;
      if (newAccount) {
        this.ctx.state.sessionAccount = account;
        if (this.ctx.state.uin !== account.uin || !this.authorized) {
          this.ctx.state.uin = account.uin;
          this.ctx.state.nick = '';
          this.ctx.state.loginAt = 0;
        }
        this.ctx.state.loginSucceeded = true;
        this.ctx.state.invalidatedSession = null;
        if (this.ctx.state.loggedOut) {
          this.ctx.state.loggedOut = false;
          clearLogoutMarker();
        }
        this.ctx.state.qr = null;
        this.ctx.state.qrState = 'confirmed';
      }
      if (!this.authorized || (account && account.uin !== this.ctx.state.uin) || (sessionChanged && !account)) {
        this.ctx.state.msgService = null;
        return;
      }
      const previous = this.ctx.state.messageBinding;
      this.ctx.state.session = session;
      const candidate = session.getMsgService();
      this.ctx.state.probe.messageServiceSeen = Boolean(candidate);
      if (!candidate) {
        // 服务对象消失：绑定一并作废，等它回来时重绑，避免复用可能已被丢弃的监听（M3）。
        this.invalidateBinding();
        return;
      }
      // 唯一复用判据：同一 session + 同一个 service 对象 + 已拿到监听 id。
      // 以前这里还有一条"同会话且有旧 msgService 就复用"的提前返回，它会把同一会话下
      // 客户端换出来的新 service 对象丢掉，导致监听仍留在旧对象上、消息静默丢失。
      if (!newAccount && previous?.session === session && previous.service === candidate && previous.id != null) {
        this.ctx.state.msgService = candidate;
        this.ctx.kernel.attachRequestListeners(session);
        return;
      }
      const self = this;
      const binding = { session, service: candidate, id: undefined };
      const active = () => self.online && self.ctx.state.messageBinding === binding;
      const listener = new Proxy({
        onRecvMsg(messages) {
          if (!active() || !Array.isArray(messages)) return;
          for (const message of messages) self.ctx.kernel.onNativeMessage(message);
        },
        onRichMediaDownloadComplete(info) {
          if (active()) self.ctx.kernel.onRichMediaDownloadComplete(info);
        },
        onKickedOffLine() {
          if (self.ctx.state.messageBinding === binding && self.ctx.state.session === session) self.invalidateSession();
        },
      }, {
        get(target, key) {
          if (key in target) return target[key];
          if (typeof key === 'string' && key.startsWith('on')) return () => { };
          return undefined;
        },
      });
      binding.id = candidate.addKernelMsgListener(listener);
      this.ctx.state.messageBinding = binding;
      this.ctx.state.msgService = candidate;
      if (sessionChanged) {
        // 客户端没有成对的 removeKernel*Listener 时接受"每会话一代"，
        // 旧代回调由 this.session 守卫抑制；代数计数进 diagnostics 便于发现泄漏（M6）。
        this.ctx.state.buddyListenerReady = false;
        this.ctx.state.groupListenerReady = false;
        this.ctx.state.probe.listenerGenerations = (this.ctx.state.probe.listenerGenerations || 0) + 1;
      }
      this.ctx.kernel.markOnline();
      this.ctx.kernel.attachRequestListeners(session);
      if (newAccount || previous?.session !== session) {
        Promise.resolve().then(() => this.ctx.kernel.friends()).catch(() => { });
      }
      if (previous?.id != null) {
        try {
          previous.service.removeKernelMsgListener?.(String(previous.id));
        } catch (error) {
          // 卸载 API 的真实签名未实机验证；失败允许，但必须能被诊断看到（M5）。
          this.ctx.state.probe.lastListenerCleanupError = String(error?.name || 'Error');
          this.ctx.state.probe.listenerCleanupFailures = (this.ctx.state.probe.listenerCleanupFailures || 0) + 1;
        }
      }
    } catch (error) {
      this.ctx.state.msgService = null;
      this.ctx.state.probe.lastAttachError = String(error?.stack || error);
      console.error('[bridge] message attachment failed:', error);
    }
  }

  requireSession() {
    if (this.ctx.state.session) return this.ctx.state.session;
    throw new Error('会话尚未就绪');
  }
}

module.exports = { SessionDomain };
