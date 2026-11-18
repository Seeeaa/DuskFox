'use strict';
/**
 * 真实 QQ 内核适配（在 QQ 进程内运行）。
 *
 * 这里所有调用都来自官方 wrapper.node 的 NodeIKernel*Service，形状参考本地
 * napcat-core/apis 与旧桥接源码；凡是未在实机上确认过的调用都标了
 * 【待实机验证】，并通过 /api/status.pending_native 暴露给框架与控制台。
 *
 * 不修改 QQ 文件、不改变入口行为以外的东西；失败一律降级成状态，不让异常冒泡。
 */

const ELEMENT_TEXT = 1;
const ELEMENT_PIC = 2;
/** 语音元素（QQ NT ElementType.PTT = 4，与 NapCat 的 ElementType 枚举一致）。 */
const ELEMENT_PTT = 4;
/** pttElement 需要一段固定波形占位；QQ 只把它当展示数据。取自 NapCat 的实测定值。 */
const SILK_WAVE = [0, 18, 9, 23, 4, 12, 7, 15, 3, 20, 11, 6, 17, 8, 13];
/** 引用回复的元素类型（QQ NT ElementType.REPLY）。 */
const ELEMENT_REPLY = 7;
const CHAT_PRIVATE = 1;
const CHAT_GROUP = 2;

class NativeKernel {
  constructor(options = {}) {
    this.mode = 'native';
    this.version = 'qq-native-bridge/2.0';
    this.uin = '';
    this.nick = '';
    this.avatar = '';
    this.online = false;
    /** 扫码授权完成与消息网络可用是两件事，分开记录。 */
    this.loginSucceeded = false;
    /** getMsfStatus(): 1=断开, 2=已连接。 */
    this.msfStatus = 0;
    this.qrState = 'none';
    this.qrSeq = 0;
    this.lastReconnectAt = 0;
    this.loggedOut = (() => { try { return require('node:fs').existsSync(logoutMarkerPath()); } catch (error) { return false; } })();
    this.qr = null;
    this.emit = () => {};
    this.session = null;
    this.loginService = null;
    this.msgService = null;
    this.listenerReady = false;
    this.loginListener = null;
    this.messageListener = null;
    this.probe = {
      qrPictures: 0,
      qrScans: 0,
      qrSuccesses: 0,
      loginConnected: 0,
      sessionCaptured: false,
      messageServiceSeen: false,
      msfStatus: null,
      lastAttachError: '',
    };
    /** msgId -> Peer，用于按 ID 查询消息与撤回。 */
    this.peerByMsgId = new Map();
    /** msgId -> 原生元信息（msgSeq/msgTime/sender）：构造引用回复时必须回填这些字段。 */
    this.metaByMsgId = new Map();
    /** el:<elementId> / msg:<msgId> -> RichMedia 落盘路径：语音/图片下载完成时记下。 */
    this.mediaPaths = new Map();
    /** 等 RichMedia 下载完成的回调（同一个 key 可能有多路等待）。 */
    this.mediaWaiters = new Map();
    /** 最近若干条原生消息的结构摘要，用于核对元素字段名（状态接口里可见）。 */
    this.recentNative = [];
    /** uid -> uin，@ 与群成员解析共用。 */
    this.uinByUid = new Map();
    /** uin -> 昵称（好友/群成员），@ 文案与发送者昵称兜底。 */
    this.nickByUin = new Map();
    /** group|uin -> uid：群内 @ 需要 uid，而不是 QQ 号。 */
    this.uidByGroupKey = new Map();
    /** uin -> uid，来自好友列表；私聊发送必须用 uid。 */
    this.uidByUin = new Map();
    /** 群列表事件缓存（NapCat 通过事件等待 getGroupList 的结果）。 */
    this.groupListCache = null;
    /** 群号 -> 群名：内核不推列表时用它兜底（群名可能为空）。 */
    this.groupsSeen = new Map();
    /** 群号 -> { at, list }：群成员列表缓存（getAllMemberList 一次 126 项，别每次都拉）。 */
    this.memberListCache = new Map();
    /** 群号 -> 上次预热时间：避免每条消息都拉成员表。 */
    this.memberWarmAt = new Map();
    /** 本次登录的起始时间（毫秒），落盘以便重启后仍显示连续在线时长。 */
    this.loginAt = 0;
    /** 消息元数据落盘：重启后仍能引用/撤回旧消息。 */
    this.metaPath = null;
    this.metaTimer = null;
    try {
      this.metaPath = require('node:path').join(require('node:os').homedir(), '.duskfox-msg-meta.json');
      this.loadMetaCache();
    } catch (error) {
      this.metaPath = null;
    }
    this.groupListenerReady = false;
    /** 好友/加群请求缓存：OneBot 的 flag 由 seq/reqTime 拼出。 */
    this.friendRequests = new Map();
    this.groupNotices = new Map();
    this.requestListenerReady = false;
    /**
     * 发送哪些消息段由实机验证状态决定：图片发送代码已实现，但 RichMedia
     * 行为未在真实客户端确认，默认不对外声明；设 QQ_BRIDGE_IMAGE_SEND=1 再打开。
     */
    const mediaSend = process.env.QQ_BRIDGE_IMAGE_SEND === '1';
    // 语音出站同样依赖 RichMedia 复制，未实机确认前默认不对外声明；
    // 设 QQ_BRIDGE_RECORD_SEND=1 再打开。入站解析（pttElement）始终可用。
    const recordSend = process.env.QQ_BRIDGE_RECORD_SEND === '1';
    this.sendSegments = [
      'text',
      ...(mediaSend ? ['image'] : []),
      ...(recordSend ? ['record'] : []),
      'at',
      'reply',
    ];
    /** 能解析进来的段：语音在 onRecvMsg 里由 pttElement 归一化。 */
    this.recvSegments = ['text', 'image', 'face', 'at', 'reply', 'record'];
    /** 密码登录默认关闭，需显式开启（参数与回调仍待实机验证）。 */
    // 默认启用密码登录；显式设置 QQ_BRIDGE_PASSWORD_LOGIN=0 可关闭。
    this.passwordLoginEnabled = process.env.QQ_BRIDGE_PASSWORD_LOGIN !== '0';
    this.pendingNative = [
      'recallMsg(peer,[msgId])',
      'getBuddyListV2 返回结构',
      'getGroupService().getGroupList(false) 直接返回',
      'getAllMemberList(groupCode,false) 返回 .result.infos',
      '群会话 peerUid = 群号',
      'picElement 发送（filePath/md5HexStr 由客户端补全）',
      'getMsfStatus()===2 作为在线判据',
      'getMsgsByMsgId(peer,[msgId]) 的返回结构',
      'uin -> uid 解析（好友列表）',
      '图片发送：RichMedia 目录 + picElement(picWidth/picHeight/picType/picSubType)',
      '语音入站：downloadRichMedia 参数与 onRichMediaDownloadComplete 回调字段',
      '语音出站：ffmpeg 转 ntsilk_s16le 后的 pttElement 是否被客户端接受（需 QQ_BRIDGE_RECORD_SEND=1）',
      '语音 url：GetPttUrl 未实现，record 段通常只有 path，没有 http 链接',
      'passwordLogin 的参数（uin/passwordMd5/空 Uint8Array）与回调时序',
      'onBuddyReqChange / onGroupNotifiesUpdated 的事件形状与 flag 映射',
    ];
    this.attachTimer = null;
    this.msgTimer = null;
    this.options = options;
  }

  // ---------------------------------------------------------------- 生命周期

  async start(emit) {
    this.emit = emit;
    this.attach();
    this.attachTimer = setInterval(() => this.attach(), 2000);
    this.attachTimer.unref?.();
    this.msgTimer = setInterval(() => this.attachMessages(), 2000);
    this.msgTimer.unref?.();
  }

  async stop() {
    clearInterval(this.attachTimer);
    clearInterval(this.msgTimer);
  }

  refreshMsf() {
    try {
      if (!this.loginService) return;
      const value = this.loginService.getMsfStatus();
      if (typeof value === 'number') {
        this.msfStatus = value;
        this.probe.msfStatus = value;
      }
    } catch (error) {
      // 待实机：该方法在部分版本不存在，保留上一次值。
    }
    // 与 NapCat 一致：会话就绪即在线；MSF 只作为诊断字段，不再作为在线前提。
    this.online = Boolean(this.loginSucceeded && this.msgService);
  }

  get quickLoginSupported() {
    // NC 用的是 quickLoginWithUin；quickLogin 是旧命名，存在兼容差异。
    return Boolean(
      this.loginService &&
        (typeof this.loginService.quickLoginWithUin === 'function' ||
          typeof this.loginService.quickLogin === 'function'),
    );
  }

  /** 本机已登录账号（快速登录列表）。 */
  async quickList() {
    if (!this.loginService) return [];
    let raw = null;
    for (const attempt of [
      () => this.loginService.getLoginList(),
      () => this.loginService.getLoginList(''),
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
    if (!this.loginService) throw new Error('登录服务尚未就绪');
    if (!this.quickLoginSupported) throw new Error('当前客户端未提供快速登录接口');
    const call = this.loginService.quickLoginWithUin || this.loginService.quickLogin;
    const res = await call.call(this.loginService, String(uin));
    const code = String((res && res.result) ?? '');
    const errMsg = res && res.loginErrorInfo && res.loginErrorInfo.errMsg;
    if ((code && code !== '0' && code !== 'undefined') || errMsg) {
      throw new Error('快速登录失败：' + (errMsg || code));
    }
    this.uin = String(uin);
    this.loggedOut = false;
    rememberAccount(this.uin);
    this.loginAt = 0;
    this.markOnline();
    clearLogoutMarker();
    this.loginSucceeded = true;
    // 消息服务稍后由 attach 循环补上。
    this.probe.reconnects = (this.probe.reconnects || 0) + 1;
    return { accepted: true };
  }

  /** 掉线后自动快速重连（15s 节流，失败不影响状态查询）。 */
  #maybeReconnect() {
    if (this.loggedOut) return;
    if (this.msgService) return;
    if (Date.now() - this.lastReconnectAt < 20000) return;
    this.lastReconnectAt = Date.now();
    if (!this.quickLoginSupported) return;
    if (this.loginSucceeded) {
      Promise.resolve()
        .then(() => this.quickLogin(this.uin))
        .catch((error) => { this.probe.lastReconnectError = String(error && error.message ? error.message : error); });
      return;
    }
    // 进程刚重启：登录态丢了，但本机有保存的账号时直接快速登录（NC 行为）。
    Promise.resolve()
      .then(() => this.quickList())
      .then((list) => {
        const items = Array.isArray(list) ? list : [];
        const remembered = rememberedAccount();
        if (remembered) {
          // 只允许自动登录上次那个机器人号：换成别的号（比如个人的主号）宁可不登录。
          const hit = items.find((item) => String(item && item.uin) === remembered);
          this.probe.rememberedAccount = remembered;
          if (!hit) {
            this.probe.lastReconnectError = '上次登录的账号 ' + remembered + ' 不在快速登录列表里，等待扫码';
            return null;
          }
          return this.quickLogin(remembered);
        }
        const hit = items[0];
        if (hit && hit.uin) return this.quickLogin(hit.uin);
        return null;
      })
      .catch((error) => { this.probe.lastReconnectError = String(error && error.message ? error.message : error); });
  }

  status() {
    this.#maybeReconnect();
    this.refreshMsf();
    return {
      uin: this.loginSucceeded ? this.uin : '',
      loginAt: this.loginSucceeded ? this.loginAt : 0,
      nick: this.loginSucceeded ? this.nick : '',
      // 与 NapCat 一致：头像用 QQ 官方 qlogo 地址，由运行时（原生侧）生成。
      avatar: this.loginSucceeded && /^\d+$/.test(String(this.uin))
        ? 'https://q1.qlogo.cn/g?b=qq&nk=' + this.uin + '&s=640'
        : this.avatar,
      online: this.online,
      authorized: this.loginSucceeded,
      msf: this.msfStatus,
    };
  }

  diagnostics() {
    let groupService = null;
    try {
      groupService = this.session ? this.session.getGroupService() : null;
    } catch (error) {
      groupService = null;
    }
    return {
      ...this.probe,
      loginListenerReady: this.listenerReady,
      messageListenerReady: Boolean(this.messageListener),
      // 客户端各版本方法名不完全一样：把可用方法列出来，便于按实机能力降级。
      msgServiceMethods: this.methodsOf(this.msgService),
      groupServiceMethods: this.methodsOf(groupService),
    };
  }

  /** 列出对象（含原型链）上的方法名，只用于诊断。 */
  methodsOf(object) {
    if (!object) return [];
    const names = new Set();
    let current = object;
    for (let depth = 0; depth < 4 && current && current !== Object.prototype; depth += 1) {
      for (const name of Object.getOwnPropertyNames(current)) {
        if (name === 'constructor') continue;
        try {
          if (typeof object[name] === 'function') names.add(name);
        } catch (error) { /* getter 抛错就跳过 */ }
      }
      current = Object.getPrototypeOf(current);
    }
    return [...names].sort();
  }

  /**
   * 直接 require wrapper.node 注册登录监听：不再依赖 dlopen 观测门控。
   * 【待实机验证】如果 QQ 尚未加载 wrapper.node，require 会抛错，这里退避重试。
   */
  attach() {
    if (this.listenerReady) return;
    if (this.options.wrapperObserved && !this.options.wrapperObserved()) return;
    let native;
    try {
      native = require('./wrapper.node');
    } catch (error) {
      return;
    }
    try {
      this.loginService = native.NodeIKernelLoginService.get();
      const self = this;
      const listener = new Proxy(
        {
          onQRCodeGetPicture(value) {
            const data = value && value.pngBase64QrcodeData;
            if (typeof data !== 'string') return;
            const base64 = data.replace(/^data:image\/png;base64,/, '');
            if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return;
            self.probe.qrPictures += 1;
            self.qrSeq += 1;
            self.qr = { picture: base64, seq: self.qrSeq, expiresAt: Date.now() + 120_000 };
            self.qrState = 'waiting';
          },
          onQRCodeSessionUserScaned() {
            self.probe.qrScans += 1;
            self.qrState = 'scanned';
          },
          onQRCodeLoginSucceed(result) {
            self.probe.qrSuccesses += 1;
            const uin = String((result && result.uin) || '');
            if (/^\d+$/.test(uin)) self.uin = uin;
            self.qrState = 'confirmed';
            self.qr = null;
            // 授权完成 ≠ 消息网络可用；online 由 MSF=2 决定。
            self.loginSucceeded = true;
            // 扫码成功后清掉登出标记：否则下次重启会被判定为已登出，逼用户重新扫码。
            self.loggedOut = false;
            rememberAccount(uin);
            self.loginAt = 0;
            self.markOnline();
            clearLogoutMarker();
            self.refreshMsf();
          },
          onQRCodeSessionFailed() {
            if (self.online) return;
            self.qrState = 'expired';
            self.qr = null;
          },
          onLoginFailed() {
            if (!self.online) self.qrState = 'expired';
          },
          onLoginConnected() { self.probe.loginConnected += 1; },
          onLoginDisConnected() {},
        },
        {
          get(target, key) {
            if (key in target) return target[key];
            if (typeof key === 'string' && key.startsWith('on')) return () => {};
            return undefined;
          },
        },
      );
      this.loginService.addKernelLoginListener(listener);
      this.loginListener = listener;
      this.listenerReady = true;
    } catch (error) {
      this.probe.lastAttachError = String(error?.name || 'Error');
      // 登录服务尚未可用：保持未就绪，下一轮重试。
    }
  }

  /**
   * 主动请求二维码。旧桥接的 SIGABRT 无法归因，这里只在拿到 loginService 后调用，
   * 并把串行/冷却交给 server（single-flight + 90s），本函数只做一次调用。
   * 【待实机验证】调用时机是否安全。
   */
  async requestQr() {
    if (!this.loginService) throw new Error('登录服务尚未就绪');
    this.loginService.getQRCodePicture();
    return true;
  }

  currentQr() {
    if (!this.qr) return null;
    if (Date.now() > this.qr.expiresAt) return { picture: null, seq: this.qr.seq, expiresAt: this.qr.expiresAt, expired: true };
    return { picture: this.qr.picture, seq: this.qr.seq, expiresAt: this.qr.expiresAt, expired: false };
  }

  // ---------------------------------------------------------------- 会话

  /** 抓取 QQ 自己创建的会话引用（只读）。 */
  attachMessages() {
    if (this.msgService) return;
    try {
      const wrapper = require('./wrapper.node');
      const type = wrapper.NodeIQQNTWrapperSession;
      if (!type) return;
      const session = this.options.sessionProvider?.() ||
        (typeof type.getNTWrapperSession === 'function' ? type.getNTWrapperSession('nt_1') : null);
      this.probe.sessionCaptured = Boolean(session);
      if (!session || typeof session.getMsgService !== 'function') return;
      this.session = session;
      const candidate = session.getMsgService();
      this.probe.messageServiceSeen = Boolean(candidate);
      if (!candidate) return;
      const self = this;
      const listener = new Proxy({
        onRecvMsg(messages) {
          if (!Array.isArray(messages)) return;
          for (const message of messages) self.onNativeMessage(message);
        },
        onRichMediaDownloadComplete(info) {
          self.onRichMediaDownloadComplete(info);
        },
      }, {
        get(target, key) {
          if (key in target) return target[key];
          if (typeof key === 'string' && key.startsWith('on')) return () => {};
          return undefined;
        },
      });
      candidate.addKernelMsgListener(listener);
      this.msgService = candidate;
      this.messageListener = listener;
      // 扫码授权后会话已建立，直接进入在线（NC 行为），不等 MSF=2。
      this.loginSucceeded = true;
      this.online = true;
      this.markOnline();
      this.attachRequestListeners(session);
      // 登录后立刻拉一次好友列表，把“自己”的昵称补上（UI 的昵称延迟主要来自这里）。
      Promise.resolve().then(() => this.friends()).catch(() => {});
      // 会话捕获不等于可收发；online 由 MSF=2 决定。
      this.refreshMsf();
    } catch (error) {
      this.probe.lastAttachError = String(error?.name || 'Error');
      // 会话尚未建立：下一轮重试。
    }
  }

  /**
   * 好友/加群请求的监听与缓存。
   * OneBot 的 flag 是运行时自己生成的标识，确认时要用它找回原生通知对象。
   * 【待实机验证】onBuddyReqChange / onGroupNotifiesUpdated 的事件字段。
   */
  attachRequestListeners(session) {
    // 好友与群监听分开注册：任一失败不拖累另一个（此前一次抛错会让群监听永远缺失）。
    if (!this.buddyListenerReady) {
      try {
        session.getBuddyService().addKernelBuddyListener({
          onBuddyReqChange: (data) => {
            const list = data && (data.RequestList || data.requestList || []);
            for (const item of Array.isArray(list) ? list : []) {
              if (!item || !item.friendUid) continue;
              const flag = 'friend|' + item.friendUid + '|' + (item.reqTime || '');
              this.friendRequests.set(flag, { friendUid: String(item.friendUid), reqTime: String(item.reqTime || '') });
              // 【待实机验证】请求事件的字段；flag 与 handleRequest 使用同一编码。
              this.emit({
                type: 'request',
                request: {
                  kind: 'friend',
                  time: Math.floor(Date.now() / 1000),
                  scene: 'private',
                  peer: { id: String(item.friendUid) },
                  user: { id: String(item.friendUid) },
                  comment: String(item.msg || item.comment || ''),
                  flag,
                },
              });
            }
          },
        });
        this.buddyListenerReady = true;
      } catch (error) {
        this.probe.lastBuddyListenerError = String(error?.message || error?.name || error);
      }
    }
    if (!this.groupListenerReady) {
      try {
        session.getGroupService().addKernelGroupListener({
          // 不同版本回调签名不同：可能是 (list)、({ groupList }) 或 (isRefresh, list)。
          onGroupListUpdate: (...args) => this.captureGroupListUpdate(args),
          onGroupNotifiesUpdated: (_doubt, notifications) => {
            for (const item of Array.isArray(notifications) ? notifications : []) {
              if (!item || !item.seq) continue;
              const flag = 'group|' + item.seq + '|' + item.type + '|' + (item.group && item.group.groupCode);
              this.groupNotices.set(flag, item);
              this.emit({
                type: 'request',
                request: {
                  kind: 'group',
                  time: Math.floor(Date.now() / 1000),
                  scene: 'group',
                  peer: { id: String((item.group && item.group.groupCode) || '') },
                  user: { id: String(item.uin || item.userUin || '') },
                  comment: String(item.postscript || ''),
                  flag,
                  detail: { sub_type: 'add' },
                },
              });
            }
          },
        });
        this.groupListenerReady = true;
      } catch (error) {
        this.probe.lastGroupListenerError = String(error?.message || error?.name || error);
      }
    }
  }

  /** 重启后恢复最近消息的 msgId -> 元数据，引用/撤回旧消息才不会丢。 */
  loadMetaCache() {
    const fs = require('node:fs');
    if (!this.metaPath || !fs.existsSync(this.metaPath)) return;
    const data = JSON.parse(fs.readFileSync(this.metaPath, 'utf8'));
    const messages = Array.isArray(data && data.messages) ? data.messages : [];
    for (const item of messages) {
      if (!item || !item.msgId) continue;
      const meta = {
        msgId: String(item.msgId),
        msgSeq: String(item.msgSeq ?? ''),
        msgTime: String(item.msgTime ?? ''),
        senderUid: String(item.senderUid ?? ''),
        senderUidStr: String(item.senderUidStr ?? ''),
        senderUin: String(item.senderUin ?? ''),
        peerUid: String(item.peerUid ?? ''),
        chatType: item.chatType,
      };
      this.metaByMsgId.set(meta.msgId, meta);
      if (meta.peerUid) {
        this.peerByMsgId.set(meta.msgId, { chatType: meta.chatType, peerUid: meta.peerUid, guildId: '' });
      }
    }
    this.probe.metaRestored = this.metaByMsgId.size;
  }

  /** 合并写盘：每条消息都写太吵，2 秒一次；只管最近 400 条。 */
  scheduleMetaFlush() {
    if (this.metaTimer) return;
    this.metaTimer = setTimeout(() => {
      this.metaTimer = null;
      try {
        const fs = require('node:fs');
        if (!this.metaPath) return;
        const messages = [];
        for (const [, meta] of this.metaByMsgId) messages.push(meta);
        // 保留更多消息元数据：Fox 重启后 get_msg/引用要在更长窗口内仍能反查。
      const recent = messages.slice(-2000);
        fs.writeFileSync(this.metaPath, JSON.stringify({ at: Date.now(), messages: recent }));
        this.probe.metaSaved = recent.length;
      } catch (error) {
        this.probe.metaSaveError = String(error?.message || error);
      }
    }, 2000);
    if (typeof this.metaTimer.unref === 'function') this.metaTimer.unref();
  }

  /** 归一化 onGroupListUpdate 的各种回调形态，并记录原始签名供排障。 */
  captureGroupListUpdate(args) {
    const candidates = [];
    const shape = [];
    for (const arg of args) {
      if (!arg) {
        shape.push(typeof arg);
        continue;
      }
      if (Array.isArray(arg)) {
        shape.push('array(' + arg.length + ')');
        candidates.push(arg);
        continue;
      }
      if (typeof arg === 'object') {
        shape.push('{' + Object.keys(arg).slice(0, 12).join(',') + '}');
        const nested = [arg.groupList, arg.data, arg.result];
        if (arg.data && typeof arg.data === 'object') nested.push(arg.data.groupList);
        if (arg.result && typeof arg.result === 'object') nested.push(arg.result.groupList);
        for (const value of nested) {
          if (Array.isArray(value)) candidates.push(value);
        }
        continue;
      }
      shape.push(typeof arg + ':' + String(arg).slice(0, 40));
    }
    const list = candidates.find((item) => item.length > 0) || candidates[0] || null;
    this.probe.groupListUpdate = { shape, count: list ? list.length : -1, at: Date.now() };
    if (list && list.length > 0) {
      this.groupListCache = list;
    } else if (list === null && !this.groupListCache) {
      this.probe.groupListEmpty = true;
    }
    // 内核会反复推同一个列表，只在数量变化时记一行，别把日志刷满。
    if (this.probe.groupListLoggedCount !== (list ? list.length : -1)) {
      this.probe.groupListLoggedCount = list ? list.length : -1;
      console.log('[bridge] onGroupListUpdate', JSON.stringify(shape), 'count=', list ? list.length : -1);
    }
  }

  /** 从 getGroupList 的返回里挑出群数组。 */
  pickGroupArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return null;
    const nested = [value.groupList, value.data, value.result];
    if (value.data && typeof value.data === 'object') nested.push(value.data.groupList);
    if (value.result && typeof value.result === 'object') nested.push(value.result.groupList);
    for (const candidate of nested) {
      if (Array.isArray(candidate)) return candidate;
    }
    return null;
  }

  /** 把返回值压成一行摘要，写进错误信息便于远程排障。 */
  summarizeGroupValue(value) {
    if (Array.isArray(value)) return 'array(' + value.length + ')';
    if (!value) return String(value);
    if (typeof value === 'object') return '{' + Object.keys(value).slice(0, 12).join(',') + '}';
    return typeof value + ':' + String(value).slice(0, 60);
  }

  onNativeMessage(message) {
    if (!message || message.isImportMsg === true) return;
    const elements = Array.isArray(message.elements) ? message.elements : [];
    // 发送回显：QQ 会把自己刚发出去的消息再回调一次，但元素为空、senderUin=0。
    // 这种回声既解析不出内容，还会被框架当成新消息重复触发指令，直接丢弃。
    if (elements.length === 0) return;
    if (String(this.uin || '') && String(message.senderUin ?? '') === String(this.uin)) return;
    const msgId = String(message.msgId ?? '');
    if (msgId) {
      // 同一条消息可能经多个回调重复到达：只发一次，避免机器人重复回复。
      if (this.metaByMsgId.has(msgId)) return;
      const meta = {
        msgId,
        msgSeq: String(message.msgSeq ?? ''),
        msgTime: String(message.msgTime ?? ''),
        senderUid: String(message.senderUid ?? ''),
        senderUidStr: String(message.senderUidStr ?? ''),
        senderUin: String(message.senderUin ?? ''),
        peerUid: String(message.peerUid ?? ''),
        chatType: message.chatType,
      };
      this.metaByMsgId.set(msgId, meta);
      this.peerByMsgId.set(msgId, { chatType: message.chatType, peerUid: meta.peerUid, guildId: '' });
      this.scheduleMetaFlush();
      if (this.metaByMsgId.size > 600) {
        const oldest = this.metaByMsgId.keys().next();
        if (!oldest.done) {
          this.metaByMsgId.delete(oldest.value);
          this.peerByMsgId.delete(oldest.value);
        }
      }
      const uin = String(message.senderUin ?? '');
      const uid = String(message.senderUid ?? '');
      if (uin && uid) this.uinByUid.set(uid, uin);
      // 记录见过的群：内核 onGroupListUpdate 不推数据时，群列表退回这份缓存。
      if (Number(message.chatType) === 2 && /^\d{5,}$/.test(meta.peerUid)) {
        this.groupsSeen.set(meta.peerUid, this.groupsSeen.get(meta.peerUid) || '');
        this.warmGroupMembers(meta.peerUid);
      }
      const nick = String(message.sendMemberName || message.sendNickName || '');
      if (uin && nick) this.nickByUin.set(uin, nick);
    }
    this.rememberNativeShape(message);
    // 收到真实消息即证明消息通道可用（与 NapCat 一致），不再等 MSF=2。
    this.loginSucceeded = this.loginSucceeded || Boolean(this.session);
    this.online = true;
    this.markOnline();
    // 自己发出的消息会回显：记录元素类型，用来确认引用/@/图片是否真的进了原生包。
    if (String(this.uin || '') && String(message.senderUin ?? '') === String(this.uin)) {
      const types = (Array.isArray(message.elements) ? message.elements : [])
        .map((element) => String(element?.elementType ?? '?'))
        .join(',');
      console.log(
        '[bridge] self-echo mid=' + String(message.msgId ?? '') +
        ' seq=' + String(message.msgSeq ?? '') +
        ' clientSeq=' + String(message.clientSeq ?? '') +
        ' types=' + types,
      );
    }
    this.emit({ type: 'message', native: message });
  }

  /** 把一条原生消息的元素结构压成小摘要，供 /api/status 核对字段名。 */
  rememberNativeShape(message) {
    const shapeOf = (element) => {
      if (!element || typeof element !== 'object') return null;
      const fields = {};
      for (const [key, value] of Object.entries(element)) {
        if (typeof value === 'string') fields[key] = shortOf(value, 40);
        else if (value && typeof value === 'object') fields[key] = Object.keys(value).slice(0, 14);
        else if (value !== undefined) fields[key] = value;
      }
      return fields;
    };
    const elements = (Array.isArray(message.elements) ? message.elements : []).slice(0, 4).map((element) => ({
      elementType: element?.elementType,
      fields: shapeOf(element),
    }));
    const entry = {
      chatType: message.chatType,
      peerUid: shortOf(message.peerUid, 40),
      msgSeq: String(message.msgSeq ?? ''),
      msgTime: String(message.msgTime ?? ''),
      senderUin: String(message.senderUin ?? ''),
      senderUid: shortOf(message.senderUid, 40),
      names: {
        sendMemberName: shortOf(message.sendMemberName, 24),
        sendNickName: shortOf(message.sendNickName, 24),
        sendRemarkName: shortOf(message.sendRemarkName, 24),
      },
      elements,
      keys: Object.keys(message).slice(0, 24),
    };
    this.recentNative.push(entry);
    while (this.recentNative.length > 4) this.recentNative.shift();
    this.probe.recentNative = this.recentNative;
    for (const element of Array.isArray(message.elements) ? message.elements : []) {
      if (element && element.replyElement) {
        this.probe.lastReplyElement = shapeOf(element.replyElement);
        this.probe.lastReplyKeys = Object.keys(element.replyElement).slice(0, 20);
      }
      if (element && element.textElement && Number(element.textElement.atType) > 0) {
        this.probe.lastAtElement = shapeOf(element.textElement);
      }
    }
  }

  /**
   * 标记账号在线并记录登录起始时间。
   * 有落盘记录且是同一个号就沿用（QQ 容器重启不等于重新登录），否则从现在开始计时。
   */
  markOnline() {
    if (!this.loginAt) {
      const saved = readLoginAt();
      this.loginAt = saved && saved.uin && saved.uin === String(this.uin || '') ? saved.at : Date.now();
      writeLoginAt(this.loginAt, String(this.uin || ''));
    }
  }

  /** uid -> QQ 号；@ 段与群成员解析都靠它。 */
  uinOfUid(uid) {
    if (!uid) return '';
    const key = String(uid);
    const direct = this.uinByUid.get(key);
    if (direct) return direct;
    // 没见过这个人的消息时，从已缓存的群成员列表里找（成员对象带 uin）。
    for (const entry of this.memberListCache.values()) {
      const hit = (entry.list || []).find((item) => String(item && item.uid) === key);
      if (hit && hit.uin) {
        this.uinByUid.set(key, String(hit.uin));
        if (hit.nick) this.nickByUin.set(String(hit.uin), String(hit.nick));
        return String(hit.uin);
      }
    }
    return '';
  }

  /**
   * 群消息到达时后台补一次成员表，把 uid -> uin 映射填满。
   * @ 段的 qq 必须是数字 QQ 号；没有这层预热，新群里第一次 @ 会退化成 uid，框架直接解析失败。
   */
  warmGroupMembers(groupId) {
    if (!groupId || typeof this.groupMembers !== 'function') return;
    const key = String(groupId);
    const last = this.memberWarmAt.get(key) || 0;
    if (Date.now() - last < 60_000) return;
    this.memberWarmAt.set(key, Date.now());
    Promise.resolve()
      .then(() => this.groupMembers(key))
      .catch((error) => { this.probe.memberWarmError = String(error && error.message ? error.message : error); });
  }

  /** 群号 -> 群名（来自 onGroupListUpdate 缓存），消息事件里补 group_name 用。 */
  groupNameOf(groupId) {
    const code = String(groupId ?? '');
    if (!code) return '';
    for (const item of Array.isArray(this.groupListCache) ? this.groupListCache : []) {
      if (String(item && item.groupCode) === code) return String(item.groupName || '');
    }
    return '';
  }

  /** 群号+QQ号 -> 成员角色（owner/admin/member），消息事件 sender.role 用。 */
  memberRoleOf(groupId, uin) {
    const key = String(groupId ?? '');
    const target = String(uin ?? '');
    if (!key || !target) return '';
    const entry = this.memberListCache.get(key);
    const hit = (entry && Array.isArray(entry.list) ? entry.list : []).find((item) => String(item && item.uin) === target);
    if (!hit) return '';
    return hit.role === 4 ? 'owner' : hit.role === 3 ? 'admin' : 'member';
  }

  /** 诊断用：记下最近一次 @ 解析结果，/api/status 里能看到 uid -> QQ 号是否成功。 */
  atProbe(uid, uin) {
    this.probe.lastAtResolved = { uid: String(uid).slice(0, 16), uin: String(uin || ''), at: Date.now() };
    this.probe.uinByUidSize = this.uinByUid.size;
  }

  /** 收到群消息时把成员表准备好（60 秒缓存），保证 @ 能映射成数字 QQ 号。 */
  async warmGroup(message) {
    const chatType = Number(message?.chatType);
    const peerUid = String(message?.peerUid ?? '');
    if (chatType !== 2 || !/^\d{5,}$/.test(peerUid)) return;
    await this.groupMembers(peerUid);
  }

  /** uin -> 昵称（好友或群成员），@ 文案用。 */
  nickOfUin(uin) {
    if (!uin) return '';
    return this.nickByUin.get(String(uin)) || '';
  }

  /** 记住一个群成员的 uid/昵称，后续 @ 直接用。 */
  cacheMember(key, info) {
    if (!info) return;
    const uid = String(info.uid ?? '');
    const uin = String(info.uin ?? '');
    const nick = String(info.cardName || info.nick || '');
    if (uid && uin) this.uinByUid.set(uid, uin);
    if (uin && nick) this.nickByUin.set(uin, nick);
    if (uid && key) this.uidByGroupKey.set(key, uid);
  }

  /** uin -> uid；群聊优先用成员列表，私聊用好友列表。 */
  async resolveAtUid(uin, scene, peerId) {
    const key = String(uin);
    const groupKey = peerKey(peerId, key);
    const cached = this.uidByGroupKey.get(groupKey) || this.uidByUin.get(key);
    if (cached) return cached;
    try { await this.friends(); } catch (error) { /* 好友列表失败不致命 */ }
    if (this.uidByUin.has(key)) return this.uidByUin.get(key);
    if (scene === 'group') {
      try {
        const members = await this.groupMembers(peerId);
        const hit = members.find((member) => String(member.user_id) === key);
        if (hit && hit.uid) return hit.uid;
      } catch (error) { /* 成员列表失败则落到报错 */ }
    }
    throw new Error('无法解析 @ 目标的 uid：' + key);
  }

  /**
   * 按 ID 查询消息（get_msg 的运行时回退）。
   * 【待实机验证】getMsgsByMsgId 的返回结构与 peer 是否必需。
   */
  async getMessage(msgId) {
    if (!this.msgService) throw new Error('消息服务未就绪');
    const key = String(msgId);
    const peer = this.peerByMsgId.get(key);
    if (!peer) {
      // 重启后缓存被清空：不知道 peer 就在常见群/私聊里按 id 找一遍（最多 12 个，失败即返回）。
      const candidates = [...this.groupsSeen.keys()].slice(0, 12).map((groupId) => this.peerOf('group', groupId));
      for (const candidate of candidates) {
        const probeList = await withTimeout(this.msgService.getMsgsByMsgId(candidate, [key]), 2000, 'getMsgsByMsgId')
          .catch(() => null);
        if (Array.isArray(probeList) && probeList.length > 0) {
          this.peerByMsgId.set(key, candidate);
          return probeList[0];
        }
      }
      throw new Error('该消息不属于当前会话缓存，无法查询（需先收到该消息）');
    }
    let list = await withTimeout(this.msgService.getMsgsByMsgId(peer, [key]), 4000, 'getMsgsByMsgId').catch((error) => {
      this.probe.byMsgIdError = String(error?.message || error);
      return null;
    });
    if (!Array.isArray(list) || list.length === 0) {
      // 自己发出的消息 getMsgsByMsgId 查不到：先在会话首屏里找（发送后 1 分钟内必然在）。
      if (typeof this.msgService.getAioFirstViewLatestMsgs === 'function') {
        const view = await withTimeout(this.msgService.getAioFirstViewLatestMsgs(peer, 20), 1500, 'getAioFirstViewLatestMsgs').catch(() => null);
        const items = Array.isArray(view)
          ? view
          : Array.isArray(view?.messages)
            ? view.messages
            : Array.isArray(view?.msgList)
              ? view.msgList
              : Array.isArray(view?.result)
                ? view.result
                : Array.isArray(view?.result?.messages)
                  ? view.result.messages
                  : null;
        const hit = Array.isArray(items) ? items.find((item) => String(item?.msgId ?? '') === key) : null;
        if (hit) {
          this.probe.byAioHit = true;
          return hit;
        }
      }
      // 再退：按 msgSeq 翻一页（内核要求 5 个参数）。
      const meta = this.metaByMsgId.get(key);
      if (meta && meta.msgSeq && typeof this.msgService.getMsgsBySeqAndCount === 'function') {
        const page = await withTimeout(this.msgService.getMsgsBySeqAndCount(peer, String(meta.msgSeq), 1, true, false), 3000, 'getMsgsBySeqAndCount').catch((error) => {
          this.probe.bySeqError = String(error?.message || error);
          return null;
        });
        list = Array.isArray(page)
          ? page
          : Array.isArray(page?.messages)
            ? page.messages
            : Array.isArray(page?.result?.messages)
              ? page.result.messages
              : null;
        if (Array.isArray(list) && list.length > 0) this.probe.bySeqHit = true;
      }
    }
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
  }

  /**
   * 媒体下载（get_image / get_record 的运行时回退）。
   * 从原生消息元素里取 RichMedia 落盘路径并转 base64；不依赖网络。
   * 【待实机验证】picElement/pttElement 的 sourcePath/filePath 哪个可用。
   */
  async media(msgId, kind) {
    const fs = require('node:fs');
    const path = require('node:path');
    const msg = await this.getMessage(String(msgId));
    if (!msg || !Array.isArray(msg.elements)) throw new Error('消息不存在或不可读');
    const key = kind === 'record' ? 'pttElement' : 'picElement';
    const element = msg.elements.map((item) => item && item[key]).find(Boolean);
    if (!element) throw new Error('该消息不包含' + (kind === 'record' ? '语音' : '图片'));
    // 收到的语音 filePath 常常是空串：先让客户端把 RichMedia 下载到本地，
    // 结果通过 onRichMediaDownloadComplete 回来（与 NapCat 的 downloadMedia 同一条链路）。
    const candidates = [element.filePath, element.sourcePath]
      .map((value) => String(value ?? ''))
      .filter(Boolean);
    let file = candidates.find((value) => fs.existsSync(value)) || '';
    if (!file && typeof this.downloadRichMedia === 'function') {
      file = await this.downloadRichMedia(msg, element).catch(() => '');
    }
    if (!file || !fs.existsSync(file)) {
      throw new Error('媒体文件尚未落到本地（' + (candidates[0] || '无路径字段') + '），请先在 QQ 里播放一次或改用 url');
    }
    const data = fs.readFileSync(file);
    const name = path.basename(String(element.fileName || file));
    return { base64: data.toString('base64'), name, size: data.length };
  }

  /**
   * 媒体下载完成回调：记下客户端落盘的路径，get_record 才能读到真实文件。
   * 【待实机验证】回调字段名（msgElementId / elementId、msgId、filePath）。
   */
  onRichMediaDownloadComplete(info) {
    const filePath = String(info?.filePath || info?.path || '');
    if (!filePath) return;
    const keys = [];
    const elementId = String(info?.msgElementId || info?.elementId || '');
    const msgId = String(info?.msgId || '');
    if (elementId) keys.push('el:' + elementId);
    if (msgId) keys.push('msg:' + msgId);
    const entry = { path: filePath, at: Date.now() };
    for (const key of keys) {
      this.mediaPaths.set(key, entry);
      const waiters = this.mediaWaiters.get(key);
      if (!waiters) continue;
      this.mediaWaiters.delete(key);
      for (const resolve of waiters) resolve(filePath);
    }
  }

  /**
   * 让客户端把消息里的媒体落到本地，并等 onRichMediaDownloadComplete 给出路径。
   * 【待实机验证】downloadRichMedia 的参数形状与回调时序。
   */
  async downloadRichMedia(msg, element) {
    const service = this.msgService;
    if (!service || typeof service.downloadRichMedia !== 'function') return '';
    const elementId = String(element.elementId || '');
    const msgId = String(msg.msgId || '');
    const keys = [];
    if (elementId) keys.push('el:' + elementId);
    if (msgId) keys.push('msg:' + msgId);
    for (const key of keys) {
      const cached = this.mediaPaths.get(key);
      if (cached && Date.now() - cached.at < 120_000) return cached.path;
    }
    const wait = new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const key of keys) this.mediaWaiters.delete(key);
        resolve('');
      }, 8000);
      timer.unref?.();
      for (const key of keys) {
        const set = this.mediaWaiters.get(key) || new Set();
        set.add((value) => {
          clearTimeout(timer);
          resolve(value);
        });
        this.mediaWaiters.set(key, set);
      }
    });
    Promise.resolve()
      .then(() =>
        service.downloadRichMedia({
          msgId,
          chatType: Number(msg.chatType ?? 0),
          peerUid: String(msg.peerUid ?? ''),
          elementId,
          downloadType: 1,
          thumbSize: 0,
          filePath: '',
        }),
      )
      .catch((error) => {
        this.probe.mediaDownloadError = String(error?.message || error);
      });
    return wait;
  }

  /**
   * 陌生人/任意 QQ 号的基本资料。
   * 拿不到原生资料就退化成缓存里的昵称，绝不因为查不到而抛错——
   * 框架会周期性轮询这个接口，抛错只会把日志刷满。
   */
  async stranger(uin) {
    const key = String(uin || '');
    if (!/^\d{5,12}$/.test(key)) throw new Error('QQ 号格式不正确');
    const session = this.session || this.requireSession();
    let detail = null;
    try {
      const profile = typeof session.getProfileService === 'function' ? session.getProfileService() : null;
      if (profile && typeof profile.getUserDetailInfoByUin === 'function') {
        const raw = await withTimeout(profile.getUserDetailInfoByUin(key), 5000, 'getUserDetailInfoByUin');
        detail = (raw && (raw.detail || raw.result || raw)) || null;
        this.probe.strangerKeys = detail && typeof detail === 'object' ? Object.keys(detail).slice(0, 12) : null;
      }
    } catch (error) {
      this.probe.strangerError = String(error?.message || error);
    }
    const core = (detail && detail.simpleInfo && detail.simpleInfo.coreInfo) || {};
    const base = (detail && detail.simpleInfo && detail.simpleInfo.baseInfo) || {};
    let nickname = String(core.nick || (detail && detail.nick) || '');
    if (!nickname) nickname = this.nickOfUin(key);
    if (!nickname && detail && detail.uin) nickname = this.nickOfUin(String(detail.uin));
    const sex = base.sex === 1 ? 'male' : base.sex === 2 ? 'female' : 'unknown';
    return {
      user_id: Number(key),
      nickname,
      sex,
      age: Number(base.age || 0) || 0,
      qid: String((detail && detail.qid) || ''),
      level: Number((detail && detail.commonExt && detail.commonExt.qqLevel) || 0) || 0,
      uid: String((detail && detail.uid) || this.uidByUin.get(key) || ''),
    };
  }

  /** uin -> uid：发送私聊时必须用 uid。 */
  async resolveUid(uin) {
    const key = String(uin);
    if (this.uidByUin.has(key)) return this.uidByUin.get(key);
    await this.friends();
    const hit = this.uidByUin.get(key);
    if (!hit) throw new Error('好友列表中没有 QQ ' + key + '，无法确定私聊会话');
    return hit;
  }

  // ---------------------------------------------------------------- 发送

  peerOf(scene, peerId) {
    return scene === 'group'
      ? { chatType: CHAT_GROUP, peerUid: String(peerId), guildId: '' }
      : { chatType: CHAT_PRIVATE, peerUid: String(peerId), guildId: '' };
  }

  /**
   * sendMsg 只回 { result }，没有 msgId；发完立刻问会话首屏最新消息，用发送者+文本认出自己那条，
   * 这样 OneBot 返回的 message_id 才能真用于撤回/引用。
   */
  async latestSentRecord(peer, textHint) {
    const service = this.msgService;
    if (!service || typeof service.getAioFirstViewLatestMsgs !== 'function') return null;
    const selfUin = String(this.uin || '');
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      let raw = null;
      try {
        raw = await withTimeout(service.getAioFirstViewLatestMsgs(peer, 10), 1200, 'getAioFirstViewLatestMsgs');
      } catch (error) {
        this.probe.aioLatestError = String(error?.message || error);
        return null;
      }
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.messages)
          ? raw.messages
          : Array.isArray(raw?.msgList)
            ? raw.msgList
            : Array.isArray(raw?.result)
              ? raw.result
              : Array.isArray(raw?.result?.messages)
                ? raw.result.messages
                : Array.isArray(raw?.result?.msgList)
                  ? raw.result.msgList
                  : null;
      if (list && list.length > 0) {
        const hit = [...list].reverse().find((item) => {
          if (!item || !item.msgId) return false;
          if (selfUin && String(item.senderUin ?? '') && String(item.senderUin) !== selfUin) return false;
          if (textHint) {
            const text = (Array.isArray(item.elements) ? item.elements : [])
              .map((element) => String(element?.textElement?.content ?? ''))
              .join('');
            if (text && !text.includes(textHint.slice(0, 12))) return false;
          }
          return true;
        });
        if (hit) return hit;
        this.probe.aioLatestKeys = Object.keys(list[0] || {}).slice(0, 16);
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    return null;
  }

  async send({ scene, peerId, segments }) {
    if (!this.msgService) throw new Error('消息服务未就绪');
    // 安全阀：万一客户端的自动登录落到别的账号上，绝不代它发消息。
    const remembered = rememberedAccount();
    if (remembered && this.uin && String(this.uin) !== remembered) {
      throw new Error('当前登录账号 ' + this.uin + ' 与既定机器人 ' + remembered + ' 不符，已拒绝发送');
    }
    // 【待实机验证】群聊 peerUid 用群号；私聊 peerUid 必须换成 uid。
    const peerUid = scene === 'group' ? String(peerId) : await this.resolveUid(peerId);
    const elements = [];
    for (const segment of segments) {
      if (segment.type === 'text') {
        elements.push({
          elementType: ELEMENT_TEXT,
          elementId: '',
          textElement: { content: String(segment.data.text ?? ''), atType: 0, atUid: '', atTinyId: '', atNtUid: '' },
        });
      } else if (segment.type === 'image') {
        elements.push(await this.buildPicElement(String(segment.data?.file ?? segment.data?.url ?? '')));
      } else if (segment.type === 'record') {
        elements.push(await this.buildPttElement(String(segment.data?.file ?? segment.data?.url ?? '')));
      } else if (segment.type === 'at') {
        elements.push(await this.buildAtElement(segment.data || {}, scene, peerId));
      } else if (segment.type === 'reply') {
        elements.push(await this.buildReplyElement(segment.data || {}, scene, peerId));
      } else {
        throw new Error('原生内核暂不支持该消息段：' + segment.type);
      }
    }
    const peer = { chatType: scene === 'group' ? CHAT_GROUP : CHAT_PRIVATE, peerUid, guildId: '' };
    // 图片要先上传到腾讯 CDN：3MB 的图实测就能超过 12 秒，别把正常发送当超时掐掉。
    const result = await withTimeout(this.msgService.sendMsg('0', peer, elements, new Map()), 120_000, 'sendMsg');
    if (!result || result.result !== 0) throw new Error('sendMsg 返回 ' + JSON.stringify(result));
    this.probe.sendResultKeys = Object.keys(result).slice(0, 12);
    const textHint = segments
      .filter((segment) => segment?.type === 'text')
      .map((segment) => String(segment?.data?.text ?? ''))
      .join('');
    const record = await this.latestSentRecord(peer, textHint).catch(() => null);
    let messageId = String(result.msgId || result.msgSeq || '');
    if (record) {
      messageId = String(record.msgId);
      const meta = {
        msgId: messageId,
        msgSeq: String(record.msgSeq ?? ''),
        msgTime: String(record.msgTime ?? ''),
        senderUid: String(record.senderUid ?? ''),
        senderUidStr: String(record.senderUidStr ?? ''),
        senderUin: String(record.senderUin ?? this.uin ?? ''),
        peerUid: String(peer.peerUid ?? ''),
        chatType: peer.chatType,
      };
      this.metaByMsgId.set(messageId, meta);
      this.scheduleMetaFlush();
    }
    if (!messageId || messageId === 'undefined') messageId = String(Date.now());
    this.peerByMsgId.set(messageId, peer);
    this.peerByMsgId.set('last:' + scene + ':' + String(peerId), peer);
    return { messageId };
  }

  /**
   * 图片发送：把文件按客户端的 RichMedia 约定复制到它要求的路径，再发 picElement。
   * 与 NapCat 的做法一致（md5 + getRichMediaFilePathForGuild + copy）。
   * 【待实机验证】字段齐全性（picWidth/picHeight/picType/picSubType）与复制目录。
   */
  async buildPicElement(rawFile) {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const file = await materializeImage(rawFile);
    if (!file || !fs.existsSync(file)) throw new Error('图片文件不存在：' + shortOf(rawFile));
    const buffer = fs.readFileSync(file);
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const fileName = path.basename(file);
    const fileSize = buffer.length;
    const extension = path.extname(fileName).toLowerCase();
    // 与 NC 一致：非 gif 一律用 NEWPIC_JPEG(1000)，不是按扩展名细分。
    const picType = extension === '.gif' ? 2000 : 1000;
    const size = imageSizeOf(buffer);
    const service = this.msgService || (this.session && this.session.getMsgService());
    if (!service || typeof service.getRichMediaFilePathForGuild !== 'function') {
      throw new Error('客户端未提供 RichMedia 路径接口，图片发送待实机验证');
    }
    const mediaPath = service.getRichMediaFilePathForGuild({
      md5HexStr: md5,
      fileName,
      elementType: ELEMENT_PIC,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.copyFileSync(file, mediaPath);
    return {
      elementType: ELEMENT_PIC,
      elementId: '',
      picElement: {
        md5HexStr: md5,
        fileSize: String(fileSize),
        picWidth: size.width,
        picHeight: size.height,
        fileName,
        sourcePath: mediaPath,
        original: true,
        picType,
        picSubType: 0,
        fileUuid: '',
        fileSubId: '',
        thumbFileSize: 0,
        summary: '',
      },
    };
  }

  /**
   * 语音发送：与图片同一条 RichMedia 路径（md5 + getRichMediaFilePathForGuild + 复制），
   * 元素换成 pttElement。
   * 【待实机验证】pttElement 的必需字段（duration/formatType/fileUuid）与 QQ 是否接受
   * 非 silk/amr 编码；未确认前 sendSegments 默认不含 record。
   */
  async buildPttElement(rawFile) {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const source = await materializeAudio(rawFile);
    if (!source || !fs.existsSync(source)) throw new Error('语音文件不存在：' + shortOf(rawFile));
    // QQ 只接受 silk 编码，非 silk 先用 ffmpeg 转（与 NapCat 的 encodeSilk 一致）。
    const silk = await ensureSilk(source);
    const buffer = fs.readFileSync(silk);
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const fileName = path.basename(silk);
    const service = this.msgService || (this.session && this.session.getMsgService());
    if (!service || typeof service.getRichMediaFilePathForGuild !== 'function') {
      throw new Error('客户端未提供 RichMedia 路径接口，语音发送待实机验证');
    }
    const mediaPath = service.getRichMediaFilePathForGuild({
      md5HexStr: md5,
      fileName,
      elementType: ELEMENT_PTT,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.copyFileSync(silk, mediaPath);
    return {
      elementType: ELEMENT_PTT,
      elementId: '',
      // 字段集合参照 NapCat createValidSendPttElement 的实机值。
      // 【待实机验证】duration/voiceType/waveAmplitudes 等是否被客户端严格校验。
      pttElement: {
        fileName,
        filePath: mediaPath,
        md5HexStr: md5,
        fileSize: String(buffer.length),
        duration: 1,
        formatType: 1,
        voiceType: 1,
        voiceChangeType: 0,
        canConvert2Text: true,
        waveAmplitudes: [...SILK_WAVE],
        fileSubId: '',
        fileUuid: '',
        playState: 1,
        autoConvertText: 0,
        storeID: 0,
        otherBusinessInfo: { aiVoiceType: 0 },
      },
    };
  }

  /**
   * @ 段：QQ 里它就是 textElement + atNtUid，不是独立元素。
   * 群聊必须用成员 uid（uin 会被忽略），昵称只影响展示。
   */
  async buildAtElement(data, scene, peerId) {
    const target = String(data.qq ?? '').trim();
    if (!target) throw new Error('at 段缺少 qq');
    if (target === 'all') {
      return {
        elementType: ELEMENT_TEXT,
        elementId: '',
        textElement: { content: '@全体成员 ', atType: 1, atUid: '', atTinyId: '', atNtUid: '0' },
      };
    }
    const uid = await this.resolveAtUid(target, scene, peerId);
    const nick = this.nickOfUin(target) || String(data.name ?? '') || target;
    return {
      elementType: ELEMENT_TEXT,
      elementId: '',
      textElement: { content: '@' + nick + ' ', atType: 2, atUid: '', atTinyId: '', atNtUid: uid },
    };
  }

  /**
   * 引用回复：QQ 需要被引消息的 msgSeq/msgTime/senderUid 才能渲染成“引用”。
   * 这些值在收消息时已缓存；缓存未命中再按 msgId 回查一次。
   */
  async buildReplyElement(data, scene, peerId) {
    const wanted = String(data.id ?? '').trim();
    if (!wanted) throw new Error('reply 段缺少 id');
    let meta = this.metaByMsgId.get(wanted) || null;
    if (!meta) {
      try {
        const msg = await this.getMessage(wanted);
        if (msg) {
          meta = {
            msgId: String(msg.msgId ?? wanted),
            msgSeq: String(msg.msgSeq ?? ''),
            msgTime: String(msg.msgTime ?? ''),
            senderUid: String(msg.senderUid ?? ''),
            senderUidStr: String(msg.senderUidStr ?? ''),
            senderUin: String(msg.senderUin ?? ''),
          };
        }
      } catch (error) { /* 回查失败：用空值兜底，QQ 会降级成普通消息 */ }
    }
    const seq = meta ? String(meta.msgSeq ?? '') : '';
    const time = meta ? String(meta.msgTime ?? '') : '';
    // 字段名与实机 replyElement 对齐（replay* 是客户端的拼写，不要改成 reply*）。
    return {
      elementType: ELEMENT_REPLY,
      elementId: '',
      replyElement: {
        replayMsgId: wanted,
        replayMsgSeq: seq,
        replayMsgRootSeq: '0',
        replayMsgRootMsgId: '0',
        replayMsgRootCommentCnt: '0',
        sourceMsgIdInRecords: wanted,
        sourceMsgText: '',
        sourceMsgTextElems: ['0'],
        // 实机里 senderUid 放的是被引者的 QQ 号，senderUidStr 才是 u_ 开头的 uid。
        senderUid: meta ? String(meta.senderUin ?? '') : '',
        senderUidStr: meta ? String(meta.senderUid ?? '') : '',
        replyMsgClientSeq: '0',
        replyMsgTime: time,
        replyMsgRevokeType: 0,
        sourceMsgIsIncPic: false,
        sourceMsgExpired: false,
        anonymousNickName: null,
        originalMsgState: null,
      },
    };
  }

  /**
   * 密码登录。密码只在运行时内存里转成 md5，不落盘、不写日志。
   * 【待实机验证】passwordLogin 的参数、错误码与后续 onLoginConnected 时序。
   */
  async login({ method, uin, password }) {
    if (method !== 'password') throw new Error('原生内核仅实现密码登录');
    if (!this.loginService) throw new Error('登录服务尚未就绪');
    if (!/^\d{5,12}$/.test(String(uin || ''))) throw new Error('QQ 号格式不正确');
    if (typeof password !== 'string' || password.length === 0) throw new Error('密码不能为空');
    const crypto = require('node:crypto');
    const passwordMd5 = crypto.createHash('md5').update(password, 'utf8').digest('hex');
    const res = await this.loginService.passwordLogin({
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
    return { accepted: true };
  }

  /** 退出登录：客户端只提供了 destroy/cancel，没有正式 logout 接口。 */
  async logout() {
    // 客户端没有真正的 logout：写标记并结束进程，由容器 restart 策略拉回登录页。
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    this.loggedOut = true;
    this.loginAt = 0;
    clearLoginAt();
    try { fs.writeFileSync(logoutMarkerPath(), String(Date.now())); } catch (error) { /* 忽略 */ }
    this.loginSucceeded = false;
    this.online = false;
    this.msgService = null;
    this.session = null;
    this.qrState = 'none';
    setTimeout(() => process.exit(0), 800);
    return { accepted: true };
  }

  get logoutSupported() {
    return Boolean(this.loginService && (typeof this.loginService.destroy === 'function' || typeof this.loginService.cancel === 'function'));
  }

  async recall(messageId) {
    if (!this.msgService) throw new Error('消息服务未就绪');
    // 撤回必须带原始 Peer；收消息和发消息时都会写入 peerByMsgId。
    const peer = this.peerByMsgId.get(String(messageId));
    if (!peer) throw new Error('该消息不属于当前会话缓存，无法撤回');
    // 【待实机验证】recallMsg 的返回与确认事件。
    const result = await this.msgService.recallMsg(peer, [String(messageId)]);
    if (result && result.result !== undefined && result.result !== 0) throw new Error('recallMsg 返回 ' + result.result);
    return true;
  }

  // ---------------------------------------------------------------- 资料

  async friends() {
    const session = this.session || this.requireSession();
    const buddy = session.getBuddyService();
    // getBuddyListV2 返回的是分组（category + buddyUids），不是用户行；
    // 必须再用资料服务把 uid 映射成 uin/nick（与 NC 一致）。
    const result = await withTimeout(buddy.getBuddyListV2('0', true, 0), 6000, 'getBuddyListV2');
    const categories = Array.isArray(result && result.data) ? result.data : [];
    const uids = [...new Set(categories.flatMap((item) =>
      Array.isArray(item && item.buddyUids) ? item.buddyUids.map(String) : []))];
    if (uids.length === 0) return [];
    const profile = session.getProfileService();
    const infos = await withTimeout(profile.getCoreAndBaseInfo('nodeStore', uids), 6000, 'getCoreAndBaseInfo');
    if (!(infos instanceof Map)) throw new Error('好友资料服务未返回 UID 映射');
    return uids.flatMap((uid) => {
      const item = infos.get(uid);
      if (!item) return [];
      const core = item.coreInfo || {};
      const uin = Number(item.uin || core.uin || 0);
      if (uin && uid) this.uidByUin.set(String(uin), uid);
      // 好友列表里也包含自己，顺手补上昵称，避免控制台显示空昵称。
      if (uin && String(uin) === String(this.uin)) this.nick = String(core.nick || this.nick || '');
      return [{
        user_id: uin,
        nickname: String(core.nick || ''),
        remark: String(core.remark || ''),
        uid,
      }];
    });
  }

  async groups() {
    const session = this.session || this.requireSession();
    this.attachRequestListeners(session);
    const groupService = session.getGroupService();
    const returns = [];
    // 直接返回值在不同客户端版本里可能是 void / 数组 / { groupList }：逐个试并留证据。
    for (const args of [[false], [true], []]) {
      try {
        const value = await groupService.getGroupList(...args);
        returns.push(this.summarizeGroupValue(value));
        const direct = this.pickGroupArray(value);
        if (direct && direct.length > 0) this.groupListCache = direct;
      } catch (error) {
        returns.push('throw:' + String(error?.message || error?.name || error).slice(0, 80));
      }
    }
    if (!this.probe.groupListReturnsLogged) {
      this.probe.groupListReturnsLogged = true;
      console.log('[bridge] getGroupList returns', JSON.stringify(returns));
    }
    let list = Array.isArray(this.groupListCache) && this.groupListCache.length > 0 ? this.groupListCache : null;
    // 群列表在登录后由内核异步推送：等到非空或超时（冷启动时可能落后十几秒）。
    let deadline = Date.now() + 4000;
    while (!list && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (Array.isArray(this.groupListCache) && this.groupListCache.length > 0) list = this.groupListCache;
    }
    if (!list && this.groupsSeen && this.groupsSeen.size > 0) {
      // 内核一直不推列表时，退化成“从实际群消息里见过的群”，至少保证控制台可用。
      list = [...this.groupsSeen.keys()].map((code) => ({ groupCode: code, groupName: this.groupsSeen.get(code) || '', memberCount: 0, maxMemberCount: 0 }));
      console.log('[bridge] getGroupList fallback groupsSeen=', list.length);
    }
    if (!Array.isArray(list)) {
      const detail = JSON.stringify({
        update: this.probe.groupListUpdate ?? null,
        returns,
        error: this.probe.lastGroupListenerError ?? null,
      });
      console.log('[bridge] groups probe', detail.slice(0, 400));
      throw new Error('群列表尚未就绪：' + detail.slice(0, 700));
    }
    return list.map((item) => ({
      group_id: Number(item.groupCode || 0),
      group_name: String(item.groupName || ''),
      member_count: Number(item.memberCount || 0),
      max_member_count: Number(item.maxMemberCount || 0),
    }));
  }

  /** getAllMemberList 的返回结构在不同版本里是数组 / { infos } / 嵌套 result，这里统一成数组。 */
  memberArrayOf(value, depth = 0) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object' || depth > 3) return null;
    const direct = [value.infos, value.memberList, value.members, value.memberInfos, value.list];
    for (const candidate of direct) {
      if (Array.isArray(candidate)) return candidate;
    }
    const nested = [value.result, value.data, value.payload];
    for (const candidate of nested) {
      const found = this.memberArrayOf(candidate, depth + 1);
      if (found) return found;
    }
    // 兜底：uin -> 成员对象 的字典。
    const values = Object.values(value);
    if (values.length > 0 && values.every((item) => item && typeof item === 'object' && (item.uin != null || item.uid != null))) {
      return values;
    }
    return null;
  }

  async rawMemberArray(groupId) {
    const cacheKey = String(groupId);
    const cached = this.memberListCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) return cached.list;
    const session = this.session || this.requireSession();
    const result = await withTimeout(session.getGroupService().getAllMemberList(String(groupId), false), 8000, 'getAllMemberList');
    const core = result && typeof result === 'object' ? (result.result ?? result) : result;
    const infos = core && typeof core === 'object' ? core.infos : null;
    const ids = core && typeof core === 'object' ? core.ids : null;
    console.log('[bridge] getAllMemberList shape', JSON.stringify({
      type: Object.prototype.toString.call(infos),
      ids: Array.isArray(ids) ? ids.length : typeof ids,
      infosSize: infos instanceof Map ? infos.size : infos && typeof infos === 'object' ? Object.keys(infos).length : typeof infos,
      sample: infos instanceof Map ? [...infos.keys()].slice(0, 2) : infos && typeof infos === 'object' ? Object.keys(infos).slice(0, 2) : String(infos).slice(0, 30),
    }).slice(0, 300));
    let list = this.memberArrayOf(result);
    if (!list && infos instanceof Map) list = [...infos.values()];
    if (!list && infos && typeof infos === 'object') {
      const values = Object.values(infos).filter((item) => item && typeof item === 'object');
      if (values.length > 0) list = values;
    }
    if (!list && Array.isArray(ids) && infos && typeof infos === 'object') {
      list = ids.map((id) => infos[id]).filter((item) => item && typeof item === 'object');
    }
    if (!Array.isArray(list) || list.length === 0) {
      const shape = JSON.stringify({
        keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 10) : String(result).slice(0, 40),
        coreKeys: core && typeof core === 'object' ? Object.keys(core).slice(0, 10) : String(core).slice(0, 40),
      }).slice(0, 300);
      console.log('[bridge] getAllMemberList unknown shape', shape);
      throw new Error('群成员列表返回结构未知：' + shape);
    }
    this.memberListCache.set(cacheKey, { at: Date.now(), list });
    while (this.memberListCache.size > 32) {
      const oldest = this.memberListCache.keys().next();
      if (oldest.done) break;
      this.memberListCache.delete(oldest.value);
    }
    return list;
  }

  /** 原生成员对象 -> OneBot 成员视图。内核给的是 uid 键的 Map，uin 可能在对象里也可能不在。 */
  memberView(groupId, item) {
    const uid = String(item.uid || '');
    const uin = String(item.uin ?? item.memberUin ?? item.userUin ?? this.uinByUid.get(uid) ?? '');
    if (uin) this.cacheMember(peerKey(groupId, uin), item);
    return {
      group_id: Number(groupId),
      user_id: Number(uin || 0),
      nickname: String(item.nick || item.memberName || item.cardName || this.nickOfUin(uin) || ''),
      card: String(item.cardName || item.card || ''),
      role: item.role === 4 ? 'owner' : item.role === 3 ? 'admin' : 'member',
      uid,
    };
  }

  async groupMember(groupId, userId) {
    const infos = await this.rawMemberArray(groupId);
    const target = String(userId);
    let hit = infos.find((item) => String(item.uin ?? item.memberUin ?? item.userUin ?? '') === target);
    if (!hit) {
      // 调用方也可能给 uid（AstrBot 一般给 QQ 号）。
      hit = infos.find((item) => String(item.uid ?? '') === target);
    }
    if (!hit) {
      const uid = await this.resolveUid(target).catch(() => '');
      if (uid) hit = infos.find((item) => String(item.uid ?? '') === String(uid));
    }
    if (!hit) {
      console.log('[bridge] groupMember miss', target, infos[0] ? JSON.stringify(Object.keys(infos[0]).slice(0, 14)) : 'empty');
      throw new Error('群成员不存在');
    }
    return this.memberView(groupId, hit);
  }

  async groupMembers(groupId) {
    const infos = await this.rawMemberArray(groupId);
    return infos.map((item) => this.memberView(groupId, item));
  }

  async handleRequest(input) {
    const session = this.session || this.requireSession();
    if (input.type === 'friend') {
      const hit = this.friendRequests.get(input.flag);
      if (!hit) throw new Error('好友请求已失效（运行时未缓存该 flag）');
      // 【待实机验证】accept 期望 boolean。
      await session.getBuddyService().approvalFriendRequest({
        friendUid: hit.friendUid,
        reqTime: hit.reqTime,
        accept: Boolean(input.approve),
      });
      this.friendRequests.delete(input.flag);
      return true;
    }
    const notice = this.groupNotices.get(input.flag);
    if (!notice) throw new Error('加群请求已失效（运行时未缓存该 flag）');
    // 【待实机验证】operateSysNotify 的 operateType 取值。
    const operateType = input.approve ? 1 : 2;
    await session.getGroupService().operateSysNotify(Boolean(notice.doubt), {
      operateType,
      targetMsg: {
        seq: notice.seq,
        type: notice.type,
        groupCode: notice.group && notice.group.groupCode,
        postscript: ' ',
      },
    });
    this.groupNotices.delete(input.flag);
    return true;
  }

  requireSession() {
    if (this.session) return this.session;
    throw new Error('会话尚未就绪');
  }
}

/** 群成员缓存 key：group|uin。 */
/** 原生回调可能永远不回来：给它加个上限，避免整个 OneBot 动作卡到框架超时。 */
function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || '原生调用') + ' 超时（' + ms + 'ms）')), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function peerKey(groupId, uin) {
  return String(groupId) + '|' + String(uin);
}

function logoutMarkerPath() {
  const os = require('node:os');
  const path = require('node:path');
  return path.join(os.homedir(), '.duskfox-logged-out');
}

/** 清掉“已登出”标记：任意一次成功登录（扫码或快速）都意味着标记作废。 */
function clearLogoutMarker() {
  try { require('node:fs').rmSync(logoutMarkerPath(), { force: true }); } catch (error) { /* 忽略 */ }
}

function loginAtPath() {
  const os = require('node:os');
  const path = require('node:path');
  return path.join(os.homedir(), '.duskfox-login-at.json');
}

function readLoginAt() {
  try {
    const data = JSON.parse(require('node:fs').readFileSync(loginAtPath(), 'utf8'));
    const at = Number(data && data.at);
    return { at: Number.isFinite(at) && at > 0 ? at : 0, uin: String((data && data.uin) || '') };
  } catch (error) {
    return null;
  }
}

function writeLoginAt(at, uin) {
  try {
    require('node:fs').writeFileSync(loginAtPath(), JSON.stringify({ at, uin }));
  } catch (error) { /* 忽略 */ }
}

function clearLoginAt() {
  try { require('node:fs').rmSync(loginAtPath(), { force: true }); } catch (error) { /* 忽略 */ }
}

function accountPath() {
  const os = require('node:os');
  const path = require('node:path');
  return path.join(os.homedir(), '.duskfox-account.json');
}

/** 记住“这台机器上次登录的机器人账号”，避免重启后静默登录成另一个号。 */
function rememberAccount(uin) {
  try {
    if (!/^\d{5,12}$/.test(String(uin || ''))) return;
    require('node:fs').writeFileSync(accountPath(), JSON.stringify({ uin: String(uin), at: Date.now() }));
  } catch (error) { /* 忽略 */ }
}

function rememberedAccount() {
  try {
    const data = JSON.parse(require('node:fs').readFileSync(accountPath(), 'utf8'));
    const uin = String((data && data.uin) || '');
    return /^\d{5,12}$/.test(uin) ? uin : '';
  } catch (error) {
    return '';
  }
}

/** 日志里只留短标识：base64 图片可能有几 MB，整段进日志会把磁盘和日志通道打爆。 */
function shortOf(value, limit = 96) {
  const text = String(value ?? '');
  return text.length > limit ? text.slice(0, limit) + '…(' + text.length + ' 字符)' : text;
}

function mediaTmpDir() {
  const os = require('node:os');
  const path = require('node:path');
  return path.join(os.tmpdir(), 'duskfox-media');
}

function guessExt(buffer) {
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47) return '.png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg';
  if (buffer.length > 6 && buffer.toString('latin1', 0, 4) === 'GIF8') return '.gif';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WAVE') return '.wav';
  if (buffer.length > 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp';
  // 语音：QQ 侧常见 amr（#!AMR）、silk（#!SILK_V3）与 mp3。
  if (buffer.length > 6 && buffer.toString('latin1', 0, 6) === '#!AMR\n') return '.amr';
  if (buffer.length > 9 && buffer.toString('latin1', 0, 9) === '#!SILK_V3') return '.silk';
  if (buffer.length > 3 && buffer.toString('latin1', 0, 3) === 'ID3') return '.mp3';
  if (buffer.length > 2 && buffer[0] === 0xff && (buffer[1] === 0xfb || buffer[1] === 0xf3 || buffer[1] === 0xf2)) return '.mp3';
  if (buffer.length > 4 && buffer.toString('latin1', 0, 4) === 'OggS') return '.ogg';
  return '.bin';
}

let lastMediaPruneAt = 0;

/** 临时图片目录按 md5 命名（同一张图只存一份），并按小时清理，避免长期堆积。 */
function pruneMediaDir(dir) {
  const now = Date.now();
  if (now - lastMediaPruneAt < 10 * 60_000) return;
  lastMediaPruneAt = now;
  const fs = require('node:fs');
  const path = require('node:path');
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > 2 * 3600_000) fs.rmSync(full, { force: true });
      } catch (error) { /* 单文件失败忽略 */ }
    }
  } catch (error) { /* 目录不可读时忽略 */ }
}

/**
 * OneBot v11 的图片 file 有三种常见形态：本地路径、file:// URL、base64:// 负载。
 * AstrBot 默认把图片编码成 base64://，这里解码落地成临时文件，走后面的 RichMedia 流程。
 */
async function materializeImage(raw) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const value = String(raw ?? '').trim();
  if (!value) return '';

  // http(s) 链接：AstrBot 的图片插件（pixiv 等）给的就是外链，必须自己下载。
  if (/^https?:\/\//i.test(value)) {
    return saveMediaBuffer(await downloadMedia(value, 'image'));
  }
  if (value.startsWith('file://')) {
    return decodeURIComponent(value.slice('file://'.length));
  }
  if (!value.startsWith('base64://') && !(value.startsWith('data:') && value.includes(';base64,'))) {
    return value;
  }

  let payload = '';
  if (value.startsWith('base64://')) {
    payload = value.slice('base64://'.length);
  } else {
    payload = value.slice(value.indexOf(';base64,') + ';base64,'.length);
  }
  const cleaned = payload.replace(/\s+/g, '');
  if (!cleaned) throw new Error('图片 base64 数据为空');
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) throw new Error('图片 base64 解码失败：' + shortOf(cleaned));
  return saveMediaBuffer(buffer);
}

/**
 * QQ 语音只接受 silk（ntsilk_s16le，24kHz 单声道）。已经是 silk 就直接用，
 * 否则调 ffmpeg 转一次；面板/机器人常给 mp3、wav、amr，都必须转。
 * ffmpeg 需要在 PATH 里，或用 QQ_BRIDGE_FFMPEG 指定可执行文件。
 * 【待实机验证】转码参数与 QQ 客户端的接受度。
 */
async function ensureSilk(source) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFile } = require('node:child_process');
  const buffer = fs.readFileSync(source);
  if (buffer.length > 9 && buffer.toString('latin1', 0, 9) === '#!SILK_V3') return source;
  const dir = mediaTmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'ptt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.silk');
  const ffmpeg = process.env.QQ_BRIDGE_FFMPEG || 'ffmpeg';
  await new Promise((resolve, reject) => {
    execFile(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-ac', '1', '-ar', '24000', '-c:a', 'ntsilk_s16le', '-f', 'ntsilk_s16le', target],
      { timeout: 30_000, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error('语音转 silk 失败（需要 ffmpeg 在 PATH 里，可用 QQ_BRIDGE_FFMPEG 指定）：' + String(stderr || error.message).slice(0, 160)));
          return;
        }
        resolve(undefined);
      },
    );
  });
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw new Error('语音转 silk 后为空：' + shortOf(source));
  return target;
}

/**
 * 外链媒体下载：15 秒超时、12MB 上限。
 * 图片与语音共用这一条路径，`kind` 只决定提示文案和允许的内容类型。
 */
async function downloadMedia(url, kind) {
  const audio = kind === 'record';
  const label = audio ? '语音' : '图片';
  const accept = audio ? 'audio/*,*/*;q=0.8' : 'image/*,*/*;q=0.8';
  const MAX_BYTES = 12 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (duskfox)', accept },
    });
    if (!response.ok) throw new Error('下载' + label + '失败：HTTP ' + response.status);
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const ok = audio ? type.startsWith('audio/') : type.startsWith('image/');
    if (type && !ok && !type.includes('octet-stream')) {
      throw new Error('链接不是' + label + '：' + type);
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error(label + '过大：' + declared + ' 字节');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error(label + '过大：超过 ' + MAX_BYTES + ' 字节');
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks, size);
    if (buffer.length === 0) throw new Error('下载到的' + label + '为空');
    if (buffer.length > MAX_BYTES) throw new Error(label + '过大：' + buffer.length + ' 字节');
    return buffer;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('下载' + label + '超时：' + shortOf(url));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 语音文件落地：与图片共用「本地路径 / file:// / base64:// / data:」四种形态，
 * 外链改走音频类型校验，落盘扩展名由音频魔数决定（amr/silk/mp3/wav/ogg）。
 */
async function materializeAudio(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return saveMediaBuffer(await downloadMedia(value, 'record'));
  if (value.startsWith('file://')) return decodeURIComponent(value.slice('file://'.length));
  if (!value.startsWith('base64://') && !(value.startsWith('data:') && value.includes(';base64,'))) return value;
  const payload = value.startsWith('base64://')
    ? value.slice('base64://'.length)
    : value.slice(value.indexOf(';base64,') + ';base64,'.length);
  const cleaned = payload.replace(/\s+/g, '');
  if (!cleaned) throw new Error('语音 base64 数据为空');
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) throw new Error('语音 base64 解码失败：' + shortOf(cleaned));
  return saveMediaBuffer(buffer);
}

/** 图片落盘：按内容 md5 命名，供 RichMedia 复制使用。 */
function saveMediaBuffer(buffer) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const dir = mediaTmpDir();
  fs.mkdirSync(dir, { recursive: true });
  pruneMediaDir(dir);
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  const target = path.join(dir, md5 + guessExt(buffer));
  if (!fs.existsSync(target)) fs.writeFileSync(target, buffer);
  return target;
}

/** Minimal PNG/JPEG/GIF dimension reader; returns 0x0 for unknown formats. */
function imageSizeOf(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 10 && buffer.toString('latin1', 0, 4) === 'GIF8') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { width: 0, height: 0 };
}

module.exports = { NativeKernel, ELEMENT_TEXT, ELEMENT_PIC };
