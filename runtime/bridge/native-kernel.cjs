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
        const file = String(segment.data.file ?? '');
        const path = require('node:path');
        const fs = require('node:fs');
        if (!fs.existsSync(file)) throw new Error('图片文件不存在：' + file);
        // 【待实机验证】客户端是否接受本地 filePath 并自行上传到 RichMedia。
        elements.push({
          elementType: ELEMENT_PIC,
          elementId: '',
          picElement: {
            fileName: path.basename(file),
            fileSize: String(fs.statSync(file).size),
            filePath: path.resolve(file),
            md5HexStr: '',
          },
        });
      } else {
        throw new Error('原生内核暂不支持该消息段：' + segment.type);
      }
    }
    const peer = { chatType: scene === 'group' ? CHAT_GROUP : CHAT_PRIVATE, peerUid, guildId: '' };
    const result = await this.msgService.sendMsg('0', peer, elements, new Map());
    if (!result || result.result !== 0) throw new Error('sendMsg 返回 ' + JSON.stringify(result));
    // 【待实机验证】sendMsg 的返回是否直接含 msgId；旧桥接用自增游标占位。
    return { messageId: String(result.msgId || result.msgSeq || Date.now()) };
  }

  async recall(messageId) {
    if (!this.msgService) throw new Error('消息服务未就绪');
    // 【待实机验证】Peer 需要原始会话；这里按私聊会话尝试，群消息撤回需补 peer 缓存。
    const peer = { chatType: CHAT_PRIVATE, peerUid: '', guildId: '' };
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
    const groupService = session.getGroupService();
    // 【待实机验证】直接调用是否返回数组（NapCat 用事件等待）。
    const list = await groupService.getGroupList(false);
    return (Array.isArray(list) ? list : []).map((item) => ({
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
    // 【待实机验证】好友/加群请求的确认接口名与参数。
    if (input.type === 'friend') {
      await session.getBuddyService().approvalFriendRequest({
        friendUid: input.flag,
        reqTime: '',
        accept: input.approve ? 1 : 0,
      });
    } else {
      await session.getGroupService().operateGroupJoinRequest(0, {
        groupCode: input.flag,
        type: input.subType === 'invite' ? 1 : 0,
        isReject: !input.approve,
        msg: '',
      });
    }
    return true;
  }

  requireSession() {
    if (this.session) return this.session;
    throw new Error('会话尚未就绪');
  }
}

module.exports = { NativeKernel, ELEMENT_TEXT, ELEMENT_PIC };
