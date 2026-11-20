'use strict';
const { logoutMarkerPath } = require('./meta.cjs');

/** All native mutable data is allocated here, once per kernel. */
function createNativeState() {
  const state = {};

  state.uin = '';
  state.nick = '';
  state.avatar = '';
  /** 官方 QQ 确认账号身份后，才绑定消息服务。 */
  state.loginSucceeded = false;
  state.invalidatedSession = null;
  state.sessionAccount = null;
  /** getMsfStatus(): 1=断开, 2=已连接。 */
  state.msfStatus = 0;
  /** 最近一条真实入站消息的时间（毫秒），在线判据的活性来源。 */
  state.lastMsgAt = 0;
  state.qrState = 'none';
  state.qrSeq = 0;
  state.loggedOut = (() => { try { return require('node:fs').existsSync(logoutMarkerPath()); } catch (error) { return false; } })();
  state.qr = null;
  state.emit = () => { };
  state.session = null;
  state.loginService = null;
  state.msgService = null;
  state.listenerReady = false;
  state.loginListener = null;
  state.messageBinding = null;
  /** 软重启标志：stop() 到 start() 之间不建立新绑定（M7）。 */
  state.stopped = false;
  state.probe = {
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
  state.peerByMsgId = new Map();
  /** msgId -> 原生元信息（msgSeq/msgTime/sender）：构造引用回复时必须回填这些字段。 */
  state.metaByMsgId = new Map();
  /** resId -> { nativeId, chatType, peerUid }：收到转发时记下，保证按 resId 也能展开。 */
  state.forwardOwners = new Map();
  /** Original messages and expanded nodes retain their media elements for downloads. */
  state.nativeMessages = new Map();
  /** Referenced id -> source peer/root/sequence, even when the target was never received. */
  state.replySources = new Map();
  /** el:<elementId> / msg:<msgId> -> RichMedia 落盘路径：语音/图片下载完成时记下。 */
  state.mediaPaths = new Map();
  /** 等 RichMedia 下载完成的回调（同一个 key 可能有多路等待）。 */
  state.mediaWaiters = new Map();
  /** 最近若干条原生消息的结构摘要，用于核对元素字段名（状态接口里可见）。 */
  state.recentNative = [];
  /** uid -> uin，@ 与群成员解析共用。 */
  state.uinByUid = new Map();
  /** uin -> 昵称（好友/群成员），@ 文案与发送者昵称兜底。 */
  state.nickByUin = new Map();
  /** group|uin -> uid：群内 @ 需要 uid，而不是 QQ 号。 */
  state.uidByGroupKey = new Map();
  /** uin -> uid，来自好友列表；私聊发送必须用 uid。 */
  state.uidByUin = new Map();
  /** 群列表事件缓存（NapCat 通过事件等待 getGroupList 的结果）。 */
  state.groupListCache = null;
  /** 群号 -> 群名：内核不推列表时用它兜底（群名可能为空）。 */
  state.groupsSeen = new Map();
  /** 群号 -> { at, list }：群成员列表缓存（getAllMemberList 一次 126 项，别每次都拉）。 */
  state.memberListCache = new Map();
  /** 群号 -> 上次预热时间：避免每条消息都拉成员表。 */
  state.memberWarmAt = new Map();
  /** 本次登录的起始时间（毫秒），落盘以便重启后仍显示连续在线时长。 */
  state.loginAt = 0;
  /** 消息元数据落盘：重启后仍能引用/撤回旧消息。 */
  state.metaPath = null;
  state.metaTimer = null;

  state.groupListenerReady = false;
  /** 好友/加群请求缓存：OneBot 的 flag 由 seq/reqTime 拼出。 */
  state.friendRequests = new Map();
  state.groupNotices = new Map();
  state.requestListenerReady = false;
  /**
   * 发送哪些消息段由实机验证状态决定：图片发送代码已实现，但 RichMedia
   * 行为未在真实客户端确认，默认不对外声明；设 QQ_BRIDGE_IMAGE_SEND=1 再打开。
   */
  const mediaSend = process.env.QQ_BRIDGE_IMAGE_SEND === '1';
  // 语音出站同样依赖 RichMedia 复制，未实机确认前默认不对外声明；
  // 设 QQ_BRIDGE_RECORD_SEND=1 再打开。入站解析（pttElement）始终可用。
  const recordSend = process.env.QQ_BRIDGE_RECORD_SEND === '1';
  // 文件出站默认开启；视频发送沿用原有开关。
  const fileSend = process.env.QQ_BRIDGE_FILE_SEND !== '0';
  const videoSend = process.env.QQ_BRIDGE_VIDEO_SEND === '1';
  state.sendSegments = [
    'text',
    ...(mediaSend ? ['image'] : []),
    ...(recordSend ? ['record'] : []),
    // 文件复用 RichMedia 元素；视频发送保留独立开关。
    ...(fileSend ? ['file'] : []),
    ...(videoSend ? ['video'] : []),
    ...(process.env.QQ_BRIDGE_FORWARD_SEND !== '0' ? ['forward'] : []),
    'at',
    'reply',
  ];
  /** 能解析进来的段：ptt/file/video/multiForward 在 onRecvMsg 里归一化。 */
  state.recvSegments = ['text', 'image', 'face', 'at', 'reply', 'record', 'file', 'video', 'forward'];
  /** 能按消息 id 取回字节的媒体类型。 */
  state.downloadSegments = ['image', 'record', 'file', 'video'];
  // 默认启用密码登录；显式设置 QQ_BRIDGE_PASSWORD_LOGIN=0 可关闭。
  state.passwordLoginEnabled = process.env.QQ_BRIDGE_PASSWORD_LOGIN !== '0';
  state.pendingNative = [
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
    '请求事件：buddyReqs 信封与 isInitiator/isDecide/isUnread 过滤是否与实机一致',
    '请求事件：resolveUin 的三条回退（UixConvert / Profile / Group）返回形状',
    '请求事件：operateSysNotify 的 doubt 与 targetMsg 字段',
  ];
  state.attachTimer = null;

  state.buddyListenerReady = false;
  return state;
}

module.exports = { createNativeState };
