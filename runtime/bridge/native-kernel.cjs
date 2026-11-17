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
    this.qrState = 'none';
    this.qrSeq = 0;
    this.qr = null;
    this.emit = () => {};
    this.session = null;
    this.loginService = null;
    this.msgService = null;
    this.listenerReady = false;
    /** msgId -> Peer，用于按 ID 查询消息与撤回。 */
    this.peerByMsgId = new Map();
    /** uin -> uid，来自好友列表；私聊发送必须用 uid。 */
    this.uidByUin = new Map();
    /** 群列表事件缓存（NapCat 通过事件等待 getGroupList 的结果）。 */
    this.groupListCache = null;
    this.groupListenerReady = false;
    /** 好友/加群请求缓存：OneBot 的 flag 由 seq/reqTime 拼出。 */
    this.friendRequests = new Map();
    this.groupNotices = new Map();
    this.requestListenerReady = false;
    /**
     * 发送哪些消息段由实机验证状态决定：图片发送代码已实现，但 RichMedia
     * 行为未在真实客户端确认，默认不对外声明；设 QQ_BRIDGE_IMAGE_SEND=1 再打开。
     */
    this.sendSegments = process.env.QQ_BRIDGE_IMAGE_SEND === '1' ? ['text', 'image'] : ['text'];
    /** 密码登录默认关闭，需显式开启（参数与回调仍待实机验证）。 */
    this.passwordLoginEnabled = process.env.QQ_BRIDGE_PASSWORD_LOGIN === '1';
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

  status() {
    return { uin: this.online ? this.uin : '', nick: this.nick, avatar: this.avatar, online: this.online };
  }

  /**
   * 直接 require wrapper.node 注册登录监听：不再依赖 dlopen 观测门控。
   * 【待实机验证】如果 QQ 尚未加载 wrapper.node，require 会抛错，这里退避重试。
   */
  attach() {
    if (this.listenerReady) return;
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
            self.qrSeq += 1;
            self.qr = { picture: base64, seq: self.qrSeq, expiresAt: Date.now() + 120_000 };
            self.qrState = 'waiting';
          },
          onQRCodeSessionUserScaned() {
            self.qrState = 'scanned';
          },
          onQRCodeLoginSucceed(result) {
            const uin = String((result && result.uin) || '');
            if (/^\d+$/.test(uin)) self.uin = uin;
            self.qrState = 'confirmed';
            self.qr = null;
            self.online = true;
          },
          onQRCodeSessionFailed() {
            if (self.online) return;
            self.qrState = 'expired';
            self.qr = null;
          },
          onLoginFailed() {
            if (!self.online) self.qrState = 'expired';
          },
          onLoginConnected() {},
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
      this.listenerReady = true;
    } catch (error) {
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
      const session =
        typeof type.getNTWrapperSession === 'function' ? type.getNTWrapperSession('nt_1') : null;
      if (!session || typeof session.getMsgService !== 'function') return;
      this.session = session;
      this.msgService = session.getMsgService();
      const self = this;
      this.msgService.addKernelMsgListener({
        onRecvMsg(messages) {
          if (!Array.isArray(messages)) return;
          for (const message of messages) self.onNativeMessage(message);
        },
      });
      this.attachRequestListeners(session);
      this.online = true;
      try {
        const msf = this.loginService && this.loginService.getMsfStatus();
        if (typeof msf === 'number' && msf !== 2) this.online = false;
      } catch (error) {
        // 【待实机验证】getMsfStatus 语义；拿不到时按在线处理已有会话。
      }
    } catch (error) {
      // 会话尚未建立：下一轮重试。
    }
  }

  /**
   * 好友/加群请求的监听与缓存。
   * OneBot 的 flag 是运行时自己生成的标识，确认时要用它找回原生通知对象。
   * 【待实机验证】onBuddyReqChange / onGroupNotifiesUpdated 的事件字段。
   */
  attachRequestListeners(session) {
    if (this.requestListenerReady) return;
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
      session.getGroupService().addKernelGroupListener({
        onGroupListUpdate: (list) => {
          if (Array.isArray(list)) this.groupListCache = list;
        },
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
      this.requestListenerReady = true;
    } catch (error) {
      // 监听器注册失败不影响主链路；下一轮 attachMessages 再试。
    }
  }

  onNativeMessage(message) {
    if (!message || message.isImportMsg === true) return;
    if (message.msgId) {
      this.peerByMsgId.set(String(message.msgId), {
        chatType: message.chatType,
        peerUid: String(message.peerUid ?? ''),
        guildId: '',
      });
    }
    this.emit({ type: 'message', native: message });
  }

  /**
   * 按 ID 查询消息（get_msg 的运行时回退）。
   * 【待实机验证】getMsgsByMsgId 的返回结构与 peer 是否必需。
   */
  async getMessage(msgId) {
    if (!this.msgService) throw new Error('消息服务未就绪');
    const peer = this.peerByMsgId.get(String(msgId));
    if (!peer) throw new Error('该消息不属于当前会话缓存，无法查询（需先收到该消息）');
    const list = await this.msgService.getMsgsByMsgId(peer, [String(msgId)]);
    return Array.isArray(list) && list.length > 0 ? list[0] : null;
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

  async send({ scene, peerId, segments }) {
    if (!this.msgService) throw new Error('消息服务未就绪');
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
        elements.push(await this.buildPicElement(String(segment.data.file ?? '')));
      } else {
        throw new Error('原生内核暂不支持该消息段：' + segment.type);
      }
    }
    const peer = { chatType: scene === 'group' ? CHAT_GROUP : CHAT_PRIVATE, peerUid, guildId: '' };
    const result = await this.msgService.sendMsg('0', peer, elements, new Map());
    if (!result || result.result !== 0) throw new Error('sendMsg 返回 ' + JSON.stringify(result));
    // 【待实机验证】sendMsg 的返回是否直接含 msgId；旧桥接用自增游标占位。
    const messageId = String(result.msgId || result.msgSeq || Date.now());
    this.peerByMsgId.set(messageId, peer);
    return { messageId };
  }

  /**
   * 图片发送：把文件按客户端的 RichMedia 约定复制到它要求的路径，再发 picElement。
   * 与 NapCat 的做法一致（md5 + getRichMediaFilePathForGuild + copy）。
   * 【待实机验证】字段齐全性（picWidth/picHeight/picType/picSubType）与复制目录。
   */
  async buildPicElement(file) {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    if (!file || !fs.existsSync(file)) throw new Error('图片文件不存在：' + file);
    const buffer = fs.readFileSync(file);
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const fileName = path.basename(file);
    const fileSize = buffer.length;
    const extension = path.extname(fileName).toLowerCase();
    const picType =
      extension === '.gif'
        ? 2000
        : extension === '.png'
          ? 1001
          : extension === '.webp'
            ? 1002
            : extension === '.bmp'
              ? 1005
              : 1000;
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
    // 【待实机验证】getBuddyListV2 的参数与返回结构。
    const result = await buddy.getBuddyListV2('0', true, 0);
    const list = (result && (result.data || result.buddyList || [])) || [];
    return list.map((item) => {
      const uin = Number(item.uin || item.userUin || 0);
      const uid = String(item.uid || '');
      if (uin && uid) this.uidByUin.set(String(uin), uid);
      return {
        user_id: uin,
        nickname: String(item.nick || item.coreInfo?.nick || ''),
        remark: String(item.remark || ''),
        uid,
      };
    });
  }

  async groups() {
    const session = this.session || this.requireSession();
    this.attachRequestListeners(session);
    const groupService = session.getGroupService();
    // 【待实机验证】NapCat 用事件等待 onGroupListUpdate；这里先取直接返回，
    // 拿不到就等监听器缓存，避免返回空列表冒充成功。
    let list = null;
    try {
      list = await groupService.getGroupList(false);
    } catch (error) {
      list = null;
    }
    if (!Array.isArray(list)) {
      const deadline = Date.now() + 3000;
      while (!this.groupListCache && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      list = this.groupListCache;
    }
    if (!Array.isArray(list)) throw new Error('群列表尚未就绪（等待 onGroupListUpdate 超时）');
    return list.map((item) => ({
      group_id: Number(item.groupCode || 0),
      group_name: String(item.groupName || ''),
      member_count: Number(item.memberCount || 0),
      max_member_count: Number(item.maxMemberCount || 0),
    }));
  }

  async groupMember(groupId, userId) {
    const session = this.session || this.requireSession();
    // 【待实机验证】getAllMemberList 的返回结构。
    const result = await session.getGroupService().getAllMemberList(String(groupId), false);
    const infos = (result && result.result && result.result.infos) || [];
    const hit = infos.find((item) => String(item.uin) === String(userId));
    if (!hit) throw new Error('群成员不存在');
    return {
      group_id: Number(groupId),
      user_id: Number(hit.uin),
      nickname: String(hit.nick || ''),
      card: String(hit.cardName || ''),
      role: hit.role === 4 ? 'owner' : hit.role === 3 ? 'admin' : 'member',
    };
  }

  async groupMembers(groupId) {
    const session = this.session || this.requireSession();
    const result = await session.getGroupService().getAllMemberList(String(groupId), false);
    const infos = (result && result.result && result.result.infos) || [];
    return infos.map((item) => ({
      group_id: Number(groupId),
      user_id: Number(item.uin),
      nickname: String(item.nick || ''),
      card: String(item.cardName || ''),
      role: item.role === 4 ? 'owner' : item.role === 3 ? 'admin' : 'member',
    }));
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

/** Minimal PNG/JPEG dimension reader; returns 0x0 for unknown formats. */
function imageSizeOf(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
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
