/**
 * Simulated QQ kernel.
 *
 * The event/message shapes deliberately mirror what the native kernel returns
 * (seen in local runtime observations): messages are
 *   { chatType, peerUid, senderUid, senderUin, msgId, msgSeq, msgTime,
 *     sendNickName, elements: [{ elementType, textElement } | { elementType, picElement }] }
 * and are normalised to OneBot shapes by the bridge server, i.e. the exact code
 * path the native kernel will use. This file is test infrastructure only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ELEMENT_TEXT = 1;
const ELEMENT_PIC = 2;
const ELEMENT_PTT = 4;

function svgAvatar(text) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="#0d0d0d"/><text x="32" y="42" font-family="Arial" font-size="24" font-weight="bold" fill="#df7f43" text-anchor="middle">' + text + '</text></svg>';
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

/** Tiny valid PNG (1x1) so images are real bytes, not fake success. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
export function pngDataUrl() {
  return 'data:image/png;base64,' + TINY_PNG.toString('base64');
}

/** Minimal AMR header so the simulated voice is real bytes, not a fake success. */
export const TINY_AMR = Buffer.concat([Buffer.from('#!AMR\n', 'latin1'), Buffer.alloc(16)]);

/**
 * 收到的语音在 QQ 侧是 RichMedia 落盘文件，pttElement.filePath 指向它。
 * 模拟内核落一份真文件，好让 record 段的 path 字段与 get_record 都是真的。
 */
const SIM_VOICE_PATH = (() => {
  try {
    const dir = path.join(os.tmpdir(), 'duskfox-sim');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'voice.amr');
    if (!fs.existsSync(file)) fs.writeFileSync(file, TINY_AMR);
    return file;
  } catch (error) {
    return '';
  }
})();

const FRIENDS = [
  { uid: 'u_20001', uin: '20001', nick: '好友甲', remark: '甲', category: 0 },
  { uid: 'u_20002', uin: '20002', nick: '好友乙', remark: '', category: 0 },
  { uid: 'u_20003', uin: '20003', nick: '好友丙', remark: '', category: 1 },
];
const GROUPS = [
  { code: '30001', name: 'duskfox 测试群', memberCount: 4, maxMemberCount: 200 },
  { code: '30002', name: 'OneBot 联调群', memberCount: 2, maxMemberCount: 500 },
];
const MEMBERS = {
  '30001': [
    { uid: 'u_10001', uin: '10001', nick: '模拟测试号', card: '测试号', role: 4 },
    { uid: 'u_20001', uin: '20001', nick: '好友甲', card: '甲', role: 3 },
    { uid: 'u_20002', uin: '20002', nick: '好友乙', card: '', role: 2 },
    { uid: 'u_20003', uin: '20003', nick: '好友丙', card: '', role: 2 },
  ],
  '30002': [
    { uid: 'u_10001', uin: '10001', nick: '模拟测试号', card: '', role: 4 },
    { uid: 'u_20002', uin: '20002', nick: '好友乙', card: '', role: 2 },
  ],
};

export class SimKernel {
  constructor(options = {}) {
    this.mode = 'sim';
    this.version = 'sim-kernel-1.0';
    this.sendSegments = ['text', 'image', 'record'];
    this.recvSegments = ['text', 'image', 'face', 'at', 'reply', 'record'];
    this.passwordLoginEnabled = true;
    this.uin = '10001';
    this.nick = '模拟测试号';
    this.avatar = svgAvatar('DQ');
    this.online = Boolean(options.autoLogin);
    this.qrTtlMs = Number(options.qrTtlMs ?? 120_000);
    this.qr = null;
    this.qrSeq = 0;
    this.qrState = 'none';
    this.seq = 0;
    this.emit = () => {};
    this.sent = [];
    this.requests = [];
    this.fault = null;
    /** uid -> QQ 号：模拟原生内核的好友/群成员缓存，用来验证请求事件的身份解析。 */
    this.uidToUin = new Map();
    /** msgId -> native message, exactly the shape the listener would emit. */
    this.messages = new Map();
  }

  async start(emit) {
    this.emit = emit;
  }

  async stop() {}

  status() {
    return { uin: this.online ? this.uin : '', nick: this.online ? this.nick : '', avatar: this.online ? this.avatar : '', online: this.online };
  }

  /** Simulate the QQ window asking the login service for a QR. */
  issueQr(ttlMs) {
    this.qrSeq += 1;
    this.qrState = 'waiting';
    const expiresAt = Date.now() + (ttlMs ?? this.qrTtlMs);
    this.qr = { picture: TINY_PNG.toString('base64'), seq: this.qrSeq, expiresAt };
    this.emit({ type: 'qr', qr: { state: 'waiting', seq: this.qrSeq, expiresAt } });
    return true;
  }

  currentQr() {
    if (!this.qr) return null;
    if (Date.now() > this.qr.expiresAt) {
      this.qrState = 'expired';
      return { picture: null, seq: this.qr.seq, expiresAt: this.qr.expiresAt, expired: true };
    }
    return { picture: this.qr.picture, seq: this.qr.seq, expiresAt: this.qr.expiresAt, expired: false };
  }

  async requestQr() {
    return this.issueQr();
  }

  /**
   * Simulated password login: only the fixed test password works, mirroring
   * the "wrong password must fail" behaviour of the real client.
   */
  async login({ method, uin, password }) {
    if (method !== 'password') throw new Error('模拟内核仅支持密码登录');
    if (String(uin) !== this.uin) throw new Error('模拟内核只接受测试号 ' + this.uin);
    if (password !== 'sim-password') throw new Error('密码错误（模拟内核）');
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.qr = null;
    this.qrState = 'confirmed';
    this.online = true;
    return { accepted: true };
  }

  scanQr() {
    this.qrState = 'scanned';
  }

  confirmQr() {
    this.qrState = 'confirmed';
    this.qr = null;
    this.online = true;
  }

  setOnline(next) {
    this.online = Boolean(next);
    if (this.online) this.qr = null;
  }

  async send({ scene, peerId, segments }) {
    if (!this.online) throw new Error('账号未登录');
    const elements = [];
    const normalized = [];
    for (const segment of segments) {
      if (segment.type === 'text') {
        elements.push({ elementType: ELEMENT_TEXT, elementId: '', textElement: { content: segment.data.text } });
        normalized.push({ type: 'text', data: { text: segment.data.text } });
      } else if (segment.type === 'image') {
        const file = String(segment.data.file ?? '');
        if (!file) throw new Error('图片段缺少 file');
        elements.push({
          elementType: ELEMENT_PIC,
          elementId: '',
          picElement: {
            fileName: file.split(/[\\/]/).pop() || 'image.png',
            fileSize: String(file.startsWith('data:') ? file.length : 1024),
            filePath: file.startsWith('data:') ? file : file,
            md5HexStr: 'sim-md5',
          },
        });
        normalized.push({ type: 'image', data: { file, url: file.startsWith('data:') || file.startsWith('http') ? file : '' } });
      } else if (segment.type === 'record') {
        const file = String(segment.data.file ?? segment.data.url ?? '');
        if (!file) throw new Error('语音段缺少 file');
        elements.push({
          elementType: ELEMENT_PTT,
          elementId: '',
          pttElement: {
            // base64:// 与 data: 不是路径，不能拿整段载荷当文件名。
            fileName: /^(base64:\/\/|data:)/.test(file) ? 'voice.amr' : (file.split(/[\\/]/).pop() || 'voice.amr'),
            fileSize: String(TINY_AMR.length),
            md5HexStr: 'sim-ptt-md5',
            sourcePath: file.startsWith('data:') || file.startsWith('base64://') ? '(sim-media)' : file,
          },
        });
        normalized.push({ type: 'record', data: { file, url: file.startsWith('http') ? file : '' } });
      } else {
        elements.push({ elementType: ELEMENT_TEXT, elementId: '', textElement: { content: '[' + segment.type + ']' } });
        normalized.push(segment);
      }
    }
    const msgId = 'sim-out-' + (++this.seq);
    const record = { scene, peerId, elements, segments: normalized, msgId };
    this.sent.push(record);
    this.messages.set(msgId, {
      chatType: scene === 'group' ? 2 : 1,
      peerUid: scene === 'group' ? 'g_' + peerId : 'u_' + peerId,
      groupCode: scene === 'group' ? String(peerId) : '',
      senderUid: 'u_10001',
      senderUin: this.uin,
      self: true,
      msgId,
      msgSeq: String(this.seq),
      msgTime: Math.floor(Date.now() / 1000),
      sendNickName: this.nick,
      elements,
    });
    // Echo our own message back through the listener, exactly like QQ does.
    this.emit({
      type: 'message',
      native: {
        chatType: scene === 'group' ? 2 : 1,
        peerUid: scene === 'group' ? 'g_' + peerId : 'u_' + peerId,
        groupCode: scene === 'group' ? String(peerId) : '',
        senderUid: 'u_10001',
        senderUin: this.uin,
        self: true,
        msgId,
        msgSeq: String(this.seq),
        msgTime: Math.floor(Date.now() / 1000),
        sendNickName: this.nick,
        elements,
      },
    });
    return { messageId: msgId };
  }

  async recall(msgId) {
    const hit = this.sent.find((item) => item.msgId === msgId);
    if (!hit) throw new Error('消息不存在或不可撤回（' + msgId + '）');
    hit.recalled = true;
    return true;
  }

  async friends() {
    return FRIENDS.map((friend) => ({ user_id: Number(friend.uin), nickname: friend.nick, remark: friend.remark || friend.nick, uid: friend.uid }));
  }

  async groups() {
    return GROUPS.map((group) => ({
      group_id: Number(group.code),
      group_name: group.name,
      member_count: group.memberCount,
      max_member_count: group.maxMemberCount,
    }));
  }

  async groupMember(groupId, userId) {
    const members = MEMBERS[String(groupId)] ?? [];
    const hit = members.find((member) => member.uin === String(userId));
    if (!hit) throw new Error('群成员不存在');
    return { group_id: Number(groupId), user_id: Number(hit.uin), nickname: hit.nick, card: hit.card, role: hit.role === 4 ? 'owner' : hit.role === 3 ? 'admin' : 'member' };
  }

  async groupMembers(groupId) {
    const members = MEMBERS[String(groupId)] ?? [];
    return members.map((member) => ({
      group_id: Number(groupId),
      user_id: Number(member.uin),
      nickname: member.nick,
      card: member.card,
      role: member.role === 4 ? 'owner' : member.role === 3 ? 'admin' : 'member',
    }));
  }

  async handleRequest(input) {
    this.requests.push(input);
    return true;
  }

  /** Test hook: push an inbound message (optionally with an image or a voice note). */
  incoming({ scene = 'private', peerId, userId, nick, text, imageUrl, voice, time = Date.now() }) {
    const peer = String(peerId ?? (scene === 'group' ? '30001' : '20001'));
    const sender = String(userId ?? (scene === 'group' ? '20001' : peer));
    const elements = [];
    if (text) elements.push({ elementType: ELEMENT_TEXT, elementId: '', textElement: { content: String(text) } });
    if (imageUrl) {
      elements.push({
        elementType: ELEMENT_PIC,
        elementId: '',
        picElement: {
          fileName: 'received.png',
          fileSize: '1024',
          originImageUrl: String(imageUrl),
          thumbImageUrl: String(imageUrl),
          md5HexStr: 'sim-in-md5',
        },
      });
    }
    if (voice) {
      // 语音在 QQ 里是 RichMedia 落盘文件；voice 传 http(s) 时再模拟拿到 pttUrl。
      elements.push({
        elementType: ELEMENT_PTT,
        elementId: 'sim-el-voice-' + (this.seq + 1),
        pttElement: {
          fileName: 'voice-' + (this.seq + 1) + '.amr',
          filePath: SIM_VOICE_PATH,
          fileSize: String(TINY_AMR.length),
          md5HexStr: 'sim-ptt-' + (this.seq + 1),
          duration: 3,
          formatType: 1,
          ...(/^https?:\/\//i.test(String(voice)) ? { pttUrl: String(voice) } : {}),
        },
      });
    }
    const msgId = 'sim-in-' + (++this.seq);
    const native = {
      chatType: scene === 'group' ? 2 : 1,
      peerUid: scene === 'group' ? 'g_' + peer : 'u_' + peer,
      groupCode: scene === 'group' ? peer : '',
      senderUid: 'u_' + sender,
      senderUin: sender,
      self: false,
      msgId,
      msgSeq: String(this.seq),
      msgTime: Math.floor(time / 1000),
      sendNickName: String(nick ?? (scene === 'group' ? '群成员' + sender : '好友' + sender)),
      elements,
    };
    this.messages.set(msgId, native);
    this.emit({ type: 'message', native });
  }

  /**
   * Test hook: push a friend/group request with the exact shape native-kernel emits
   * (`{ type: 'request', request: { kind, time, scene, peer, user, comment, flag, detail } }`).
   * Returns the flag a bot would echo back to set_friend_add_request / set_group_add_request.
   */
  request({ kind = 'friend', userId, uid, groupId, comment = '', subType = 'add', flag, time = Date.now() } = {}) {
    const type = kind === 'group' ? 'group' : 'friend';
    const user = String(userId ?? (type === 'group' ? '20010' : '20009'));
    const group = String(groupId ?? '30001');
    const finalFlag = String(flag ?? type + '|' + (uid || user) + '|' + Math.floor(time / 1000));
    this.emit({
      type: 'request',
      request: {
        kind: type,
        time: Math.floor(time / 1000),
        scene: type === 'group' ? 'group' : 'private',
        peer: { id: type === 'group' ? group : user },
        // 与真机一致：好友申请只有字母数字 uid，群申请给 uin，拿不到 uin 时只有 uid。
        user: { id: user, ...(uid ? { uid: String(uid) } : {}) },
        comment: String(comment),
        flag: finalFlag,
        ...(type === 'group' ? { detail: { sub_type: subType } } : {}),
      },
    });
    return finalFlag;
  }

  /** 测试钩子：登记一个 uid -> QQ 号映射，模拟原生内核的好友/群成员缓存。 */
  mapUid(uid, uin) {
    this.uidToUin.set(String(uid), String(uin));
  }

  /** uid -> QQ 号；与原生内核同名，服务端用它兜底解析请求身份。 */
  uinOfUid(uid) {
    return this.uidToUin.get(String(uid)) || '';
  }

  /** Simulated media fetch behind /api/media (image or voice). */
  async media(msgId, kind) {
    const msg = this.messages.get(String(msgId));
    if (!msg || !Array.isArray(msg.elements)) throw new Error('消息不存在或不可读');
    const key = kind === 'record' ? 'pttElement' : 'picElement';
    const element = msg.elements.map((item) => item && item[key]).find(Boolean);
    if (!element) throw new Error('该消息不包含' + (kind === 'record' ? '语音' : '图片'));
    let payload = kind === 'record' ? TINY_AMR : TINY_PNG;
    if (kind === 'record' && element.filePath && fs.existsSync(element.filePath)) {
      payload = fs.readFileSync(element.filePath);
    }
    return {
      base64: payload.toString('base64'),
      name: String(element.fileName || (kind === 'record' ? 'voice.amr' : 'image.png')),
      size: payload.length,
    };
  }

  /** Native-style lookup used by /api/message and the framework's get_msg. */
  async getMessage(msgId) {
    return this.messages.get(String(msgId)) ?? null;
  }
}

export function createSimKernelFromEnv() {
  const autoLogin = process.env.QQ_BRIDGE_SIM_ONLINE === '1';
  const ttl = Number(process.env.QQ_BRIDGE_SIM_QR_TTL ?? 0) || 120_000;
  return new SimKernel({ autoLogin, qrTtlMs: ttl });
}

export function simLog(line) {
  if (process.env.QQ_BRIDGE_SIM_LOG === '0') return;
  process.stdout.write('[sim] ' + line + '\n');
}

// Keep fs imported for callers that want to persist the tiny PNG on disk.
export { fs };
