'use strict';

const ELEMENT_TEXT = 1;
const ELEMENT_PIC = 2;
const ELEMENT_FILE = 3;
/** QQ NT ElementType.PTT = 4。 */
const ELEMENT_PTT = 4;
const ELEMENT_VIDEO = 5;
/** pttElement 需要一段固定波形占位；QQ 只把它当展示数据。取自 NapCat 的实测定值。 */
const SILK_WAVE = [0, 18, 9, 23, 4, 12, 7, 15, 3, 20, 11, 6, 17, 8, 13];
/** 引用回复的元素类型（QQ NT ElementType.REPLY）。 */
const ELEMENT_REPLY = 7;
const CHAT_PRIVATE = 1;
const CHAT_GROUP = 2;
/** GroupNotifyMsgType：1 = 群成员邀请我入群（处理 user2），5/7 = 需管理员审批的入群申请（处理 user1）。 */
const GROUP_NOTIFY_INVITED_BY_MEMBER = 1;
/** GroupNotifyMsgStatus.KUNHANDLE：只有未处理的通知才是待办请求。 */
const GROUP_NOTIFY_KUNHANDLE = 1;
/** 设置/取消管理员（8/12/13）不是入群请求，NapCat 也是整批跳过。 */
const GROUP_NOTIFY_SKIP = [8, 12, 13];

/** 原生回调可能永远不回来：给它加个上限，避免整个 OneBot 动作卡到框架超时。 */
function withTimeout(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error((label || '原生调用') + ' 超时（' + ms + 'ms）')), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** 群成员缓存 key：group|uin。 */
function peerKey(groupId, uin) {
  return String(groupId) + '|' + String(uin);
}

/** 原生消息元素 -> 段类型名；认发送回执时用来比对"这条到底是不是刚发的那种消息"。 */
function elementKind(element) {
  if (!element) return '';
  if (element.textElement) return 'text';
  if (element.picElement) return 'image';
  if (element.pttElement) return 'record';
  if (element.fileElement) return 'file';
  if (element.videoElement) return 'video';
  // 08 真机实测：转发只有一个键 multiForwardMsgElement（elementType=16），没有 forwardElement。
  if (element.multiForwardMsgElement) return 'forward';
  if (element.arkElement?.bytesData) {
    try { if (JSON.parse(element.arkElement.bytesData).app === 'com.tencent.multimsg') return 'forward'; } catch {}
  }
  if (element.faceElement) return 'face';
  if (element.replyElement) return 'reply';
  return '';
}

function nativeForwardId(element, fallback = '') {
  if (element?.multiForwardMsgElement) return String(element.multiForwardMsgElement.resId || fallback);
  if (element?.arkElement?.bytesData) {
    try {
      const card = JSON.parse(element.arkElement.bytesData);
      if (card.app === 'com.tencent.multimsg') return String(card.meta?.detail?.resid || fallback);
    } catch {}
  }
  return '';
}

/** 日志里只留短标识：base64 图片可能有几 MB，整段进日志会把磁盘和日志通道打爆。 */
function shortOf(value, limit = 96) {
  const text = String(value ?? '');
  return text.length > limit ? text.slice(0, limit) + '…(' + text.length + ' 字符)' : text;
}

/** QQ queries normally return { result, msgList }, not a bare array. */
function messageList(raw) {
  if (Array.isArray(raw)) return raw;
  for (const value of [raw, raw?.result]) {
    if (Array.isArray(value?.msgList)) return value.msgList;
    if (Array.isArray(value?.messages)) return value.messages;
  }
  return [];
}

function replyId(message, reply) {
  const id = [reply.sourceMsgIdInRecords, reply.replyMsgId, reply.replayMsgId]
    .map(value => String(value || '')).find(value => value && value !== '0');
  if (id) return id;
  const seq = String(reply.replayMsgSeq || '');
  const clientSeq = String(reply.replyMsgClientSeq || '');
  if ((!seq || seq === '0') && (!clientSeq || clientSeq === '0')) return '';
  // A reference handle is resolved using its source context; a sequence is never a msgId.
  return 'dfr:' + Buffer.from(JSON.stringify([
    String(message.msgId || ''), seq, clientSeq, String(reply.replyMsgTime || ''),
  ])).toString('base64url');
}

function parseReplyHandle(id) {
  try {
    const encoded = String(id).slice(4);
    if (!String(id).startsWith('dfr:') || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
    const parts = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!Array.isArray(parts) || parts.length !== 4 || !parts.every(value => typeof value === 'string')) return null;
    const [rootId, seq, clientSeq, time] = parts;
    if (!/^[1-9]\d*$/.test(rootId) || ![seq, clientSeq, time].every(value => value === '' || /^\d+$/.test(value))) return null;
    if ((!seq || seq === '0') && (!clientSeq || clientSeq === '0')) return null;
    return { rootId, seq, clientSeq, time };
  } catch {
    return null;
  }
}

module.exports = { ELEMENT_TEXT, ELEMENT_PIC, ELEMENT_FILE, ELEMENT_PTT, ELEMENT_VIDEO, ELEMENT_REPLY, SILK_WAVE, CHAT_PRIVATE, CHAT_GROUP, GROUP_NOTIFY_INVITED_BY_MEMBER, GROUP_NOTIFY_KUNHANDLE, GROUP_NOTIFY_SKIP, withTimeout, peerKey, elementKind, shortOf, messageList, replyId, parseReplyHandle, nativeForwardId };
