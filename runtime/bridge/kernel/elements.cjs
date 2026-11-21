'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */
const { ELEMENT_TEXT, ELEMENT_REPLY, replyId, nativeForwardId } = require('./shared.cjs');

const CQ_KIND = { image: 'image', face: 'face', at: 'at', reply: 'reply', record: 'record', video: 'video' };

/** Stable per-element locator, shared by pushed messages and forward nodes. */
function mediaLocator(native, element, kind) {
  const index = native.elements.indexOf(element);
  return 'dfm:' + Buffer.from(JSON.stringify([
    String(native.msgId || ''), kind, String(element.elementId || ('index:' + index)),
  ])).toString('base64url');
}

/** Prefer numeric QQ IDs, retaining the explicit @all discriminator. */
function pickAtTarget(atUid, resolved, rawUid, atType) {
  for (const candidate of [atUid, resolved, rawUid]) {
    if (/^[1-9]\d*$/.test(candidate)) return candidate;
  }
  return atType === 1 ? 'all' : '';
}

/** native kernel message -> OneBot message segments. */
function toOb11Segments(native, helpers = {}) {
  const segments = [];
  const uinOfUid = typeof helpers.uinOfUid === 'function' ? helpers.uinOfUid : null;
  for (const element of Array.isArray(native.elements) ? native.elements : []) {
    const text = element?.textElement;
    if (text) {
      // @ 是 textElement 的变体：atType 非 0 且带 atNtUid/atUid。
      const atType = Number(text.atType ?? 0);
      const atNtUid = String(text.atNtUid ?? '');
      const atUid = String(text.atUid ?? '');
      const rawUid = [atNtUid, atUid].find((uid) => uid && uid !== '0') || '';
      const isAt = atType > 0 || Boolean(rawUid);
      if (isAt) {
        const resolved = rawUid && uinOfUid ? uinOfUid(rawUid) : '';
        if (rawUid) {
          // 这里是模块级函数，拿不到 createBridgeServer 里的 kernel/logger：
          // 之前直接引用它们会抛 ReferenceError，带 @ 的消息会被整条丢掉。
          if (typeof helpers.onAt === 'function') helpers.onAt(rawUid, String(atUid && atUid !== '0' ? atUid : resolved));
          if (!resolved && !/^\d+$/.test(atUid) && rawUid !== '0' && typeof helpers.warn === 'function') {
            helpers.warn('[bridge] @ 目标暂时无法解析成 QQ 号：' + rawUid.slice(0, 20));
          }
        }
        const content = String(text.content ?? '');
        // 实机里 atUid 存的就是 QQ 号：优先直接用，不再依赖 uid→uin 映射是否命中。
        // 之前优先用 atNtUid(uid) 做映射，缓存没命中就退化成文本，导致普通用户 @ 机器人时事件里没有 at 段。
        const target = pickAtTarget(atUid, resolved, rawUid, atType);
        if (!target) {
          if (content) segments.push({ type: 'text', data: { text: content } });
          continue;
        }
        segments.push({ type: 'at', data: { qq: target } });
        const rest = content.startsWith('@') ? '' : content;
        if (rest.trim()) segments.push({ type: 'text', data: { text: rest } });
        continue;
      }
      segments.push({ type: 'text', data: { text: String(text.content ?? '') } });
      continue;
    }
    if (element?.picElement) {
      const pic = element.picElement;
      const rawUrl = String(pic.originImageUrl || pic.thumbImageUrl || '');
      const url = rawUrl.startsWith('/') ? 'https://gchat.qpic.cn' + rawUrl : rawUrl;
      segments.push({
        type: 'image',
        data: {
          file: String(pic.fileName ?? pic.md5HexStr ?? ''),
          file_id: mediaLocator(native, element, 'image'),
          ...(url ? { url } : {}),
        },
      });
      continue;
    }
    if (element?.pttElement) {
      // 语音在 QQ 里是 pttElement。它没有可直接播放的 HTTP 地址：音频以客户端
      // RichMedia 目录里的落盘文件为准，由 /api/media?kind=record（OneBot
      // get_record）按消息 id 取，所以这里只给文件名和确实存在的 url。
      const ptt = element.pttElement;
      // QQ 的 pttElement 没有 originUrl：http 链接要拿 fileUuid 走 GetPttUrl，
      // 拿不到就只保留客户端给的文件名与本地路径（与 NapCat 一致）。
      // 路径属于 QQ 容器，不是 Fox 宿主机。
      const filePath = String(ptt.filePath || '');
      const size = Number(ptt.fileSize);
      // pttElement 本身没有 originUrl（NapCat 的 PttElement 定义里也没有）；只有
      // 运行时真的用 GetPttUrl 换到了 http 链接才会带 url。
      const rawUrl = String(ptt.pttUrl || ptt.url || '');
      const url = rawUrl.startsWith('http') ? rawUrl : '';
      segments.push({
        type: 'record',
        data: {
          file: String(ptt.fileName || ptt.fileUuid || ptt.md5HexStr || ''),
          file_id: mediaLocator(native, element, 'record'),
          ...(filePath ? { path: filePath } : {}),
          ...(url ? { url } : {}),
          ...(Number.isFinite(size) && size > 0 ? { file_size: String(ptt.fileSize) } : {}),
        },
      });
      continue;
    }
    if (Number(element?.elementType) === 3 || element?.fileElement) {
      // 08 真机实测：普通文件元素 elementType=3，键 fileElement；无该元素时其它元素位为 null。
      // 路径属于 QQ 容器，跨容器只能走 /api/media 取 base64。
      const file = element.fileElement;
      if (!file) continue;
      segments.push({
        type: 'file',
        data: {
          file: String(file.fileName || file.fileMd5 || ''),
          file_id: mediaLocator(native, element, 'file'),
          ...(file.fileUuid ? { file_uuid: String(file.fileUuid) } : {}),
          ...(file.fileId ? { native_file_id: String(file.fileId) } : {}),
          file_name: String(file.fileName || ''),
          ...(file.filePath ? { path: String(file.filePath) } : {}),
          ...(file.fileName ? { name: String(file.fileName) } : {}),
          ...(file.fileSize ? { file_size: String(file.fileSize) } : {}),
        },
      });
      continue;
    }
    if (Number(element?.elementType) === 5 || element?.videoElement) {
      // 真机实测 elementType=5，键 videoElement；fileTime 单位未从值侧确认，按秒透出并标注待测。
      const video = element.videoElement;
      if (!video) continue;
      const seconds = Number(video.fileTime) || 0;
      segments.push({
        type: 'video',
        data: {
          file: String(video.fileName || video.videoMd5 || ''),
          file_id: mediaLocator(native, element, 'video'),
          ...(video.filePath ? { path: String(video.filePath) } : {}),
          ...(video.fileName ? { file_name: String(video.fileName) } : {}),
          ...(video.fileSize ? { file_size: String(video.fileSize) } : {}),
          ...(seconds > 0 ? { duration: seconds } : {}),
        },
      });
      continue;
    }
    if (Number(element?.elementType) === 16 || element?.multiForwardMsgElement) {
      // 真机实测 elementType=16，键 multiForwardMsgElement{xmlContent,resId,fileName}；
      // 真机**没有 forwardElement** 这个键，别再用它兜底。
      const forward = element.multiForwardMsgElement;
      if (!forward) continue;
      const id = String(forward.resId || forward.msgId || native.msgId || '');
      segments.push({ type: 'forward', data: { id } });
      continue;
    }
    if (element?.arkElement) {
      const id = nativeForwardId(element, String(native.msgId || ''));
      if (id) segments.push({ type: 'forward', data: { id } });
      continue;
    }
    if (element?.faceElement) {
      segments.push({ type: 'face', data: { id: String(element.faceElement.faceIndex ?? '') } });
      continue;
    }
    if (element?.atElement) {
      const uid = String(element.atElement.atNtUid ?? '');
      const qq = String(element.atElement.qq ?? '') || (uinOfUid && uid ? uinOfUid(uid) : '');
      if (/^\d+$/.test(qq)) segments.push({ type: 'at', data: { qq } });
      continue;
    }
    if (element?.replyElement) {
      // 实机形状：replayMsgId 常为 "0"，真正能对上消息的是 sourceMsgIdInRecords。
      // replayMsgSeq 是会话内序号而不是消息 id，框架拿它调 get_msg 只会 404，不能当兜底。
      const reply = element.replyElement;
      const id = replyId(native, reply);
      // 无原生 id 时使用带源会话上下文的引用句柄，由 get_msg 回查实际消息。
      if (id) segments.push({ type: 'reply', data: { id } });
      continue;
    }
  }
  return segments;
}

/** raw_message 按 NapCat 习惯给 CQ 字符串，而不是把所有非文本都写成 [图片]。 */
function textOf(segments) {
  return segments
    .map((segment) => {
      const data = segment.data ?? {};
      if (segment.type === 'text') return String(data.text ?? '');
      if (segment.type === 'image') return '[CQ:image,file=' + String(data.file ?? '') + ']';
      if (segment.type === 'at') return '[CQ:at,qq=' + String(data.qq ?? '') + ']';
      if (segment.type === 'reply') return '[CQ:reply,id=' + String(data.id ?? '') + ']';
      if (segment.type === 'face') return '[CQ:face,id=' + String(data.id ?? '') + ']';
      return '[' + (CQ_KIND[segment.type] ?? segment.type) + ']';
    })
    .join('');
}

/**
   * Shared normaliser for "one native message -> OneBot message payload", used
   * both by the live event stream and by the on-demand /api/message lookup, so
   * a queried message looks exactly like the one that was pushed.
   */
function normalizeMessage(nativeMessage, kernel, logger = console) {
  const segments = toOb11Segments(nativeMessage, {
    uinOfUid: (uid) => (typeof kernel.uinOfUid === 'function' ? kernel.uinOfUid(uid) : ''),
    onAt: (uid, uin) => { if (typeof kernel.atProbe === 'function') kernel.atProbe(uid, uin); },
    warn: (message) => logger.warn?.(message),
  });
  // 群消息判定：chatType=2 是常规形状；peerUid 全数字（群号）作为兜底，
  // 避免某些版本 chatType 缺失时把群消息当私聊、事件里丢掉 group_id。
  const peerUid = String(nativeMessage.peerUid ?? '');
  const isGroup =
    nativeMessage.chatType === 2 ||
    Boolean(nativeMessage.groupCode) ||
    /^\d{5,}$/.test(peerUid);
  return {
    time: Number(nativeMessage.msgTime || Math.floor(Date.now() / 1000)),
    self_id: Number(kernel.uin),
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    message_id: String(nativeMessage.msgId ?? ''),
    ...(isGroup
      ? { group_id: Number(nativeMessage.groupCode || peerUid || 0) || 0 }
      : { user_id: Number(nativeMessage.senderUin || peerUid || 0) || 0 }),
    message: segments,
    raw_message: textOf(segments),
    font: 14,
    // NapCat 同款：nickname 是昵称、card 是群名片；另外带上原生 msgSeq 供框架 real_seq 使用。
    message_seq: String(nativeMessage.msgSeq ?? ''),
    ...(isGroup && typeof kernel.groupNameOf === 'function'
      ? { group_name: String(kernel.groupNameOf(nativeMessage.groupCode || peerUid) || '') }
      : {}),
    sender: {
      user_id: Number(nativeMessage.senderUin ?? 0),
      nickname: String(
        nativeMessage.sendNickName || nativeMessage.sendMemberName || nativeMessage.sendRemarkName || '',
      ),
      card: String(nativeMessage.sendMemberName ?? ''),
      ...(isGroup && typeof kernel.memberRoleOf === 'function'
        ? { role: kernel.memberRoleOf(nativeMessage.groupCode || peerUid, nativeMessage.senderUin) }
        : {}),
    },
    ...(nativeMessage.self ? { self: true } : {}),
  };
}

class ElementsDomain {
  constructor(ctx) {
    this.ctx = ctx;
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
    const uid = await this.ctx.kernel.resolveAtUid(target, scene, peerId);
    const nick = this.ctx.kernel.nickOfUin(target) || String(data.name ?? '') || target;
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
    let meta = this.ctx.state.metaByMsgId.get(wanted) || null;
    if (!meta) {
      try {
        const msg = await this.ctx.kernel.getMessage(wanted);
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
    const actualId = String(meta?.msgId || wanted);
    const seq = meta ? String(meta.msgSeq ?? '') : '';
    const time = meta ? String(meta.msgTime ?? '') : '';
    // 字段名与实机 replyElement 对齐（replay* 是客户端的拼写，不要改成 reply*）。
    return {
      elementType: ELEMENT_REPLY,
      elementId: '',
      replyElement: {
        replayMsgId: actualId,
        replayMsgSeq: seq,
        replayMsgRootSeq: '0',
        replayMsgRootMsgId: '0',
        replayMsgRootCommentCnt: '0',
        sourceMsgIdInRecords: actualId,
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

  async toNativeElements(segments, scene, peerId) {
    const elements = [];
    for (const segment of segments) {
      if (segment.type === 'text') {
        elements.push({
          elementType: ELEMENT_TEXT,
          elementId: '',
          textElement: { content: String(segment.data.text ?? ''), atType: 0, atUid: '', atTinyId: '', atNtUid: '' },
        });
      } else if (segment.type === 'image') {
        elements.push(await this.ctx.kernel.buildPicElement(String(segment.data?.file ?? segment.data?.url ?? '')));
      } else if (segment.type === 'record') {
        // 收到的语音只有 path（QQ 容器内落盘路径），回传时同样要能用。
        elements.push(await this.ctx.kernel.buildPttElement(
          String(segment.data?.file ?? segment.data?.path ?? segment.data?.url ?? ''), Number(segment.data?.duration || 0),
        ));
      } else if (segment.type === 'file') {
        elements.push(await this.ctx.kernel.buildFileElement(
          String(segment.data?.file ?? segment.data?.path ?? segment.data?.url ?? ''),
          String(segment.data?.name ?? segment.data?.file_name ?? ''),
        ));
      } else if (segment.type === 'video') {
        elements.push(await this.ctx.kernel.buildVideoElement(
          String(segment.data?.file ?? segment.data?.path ?? segment.data?.url ?? ''),
          String(segment.data?.file_name ?? segment.data?.name ?? ''),
          Number(segment.data?.duration ?? 0) || 0,
        ));
      } else if (segment.type === 'at') {
        elements.push(await this.buildAtElement(segment.data || {}, scene, peerId));
      } else if (segment.type === 'reply') {
        elements.push(await this.buildReplyElement(segment.data || {}, scene, peerId));
      } else {
        throw new Error('原生内核暂不支持该消息段：' + segment.type);
      }
    }
    return elements;
  }
}

module.exports = { ElementsDomain, toOb11Segments, normalizeMessage };
