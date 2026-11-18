/**
 * QQ 原生桥接 HTTP 服务（契约 v2）。
 *
 * 同一个服务同时用于：
 *  - 进程内（entry.cjs 在 QQ 里加载，kernel = native-kernel）；
 *  - 离线验收（offline-host.mjs，kernel = sim-kernel）。
 * 事件/动作的 OneBot 归一化只写在这里，避免两条路径行为不一致。
 */
import http from 'node:http';
import crypto from 'node:crypto';

const RING = 1024;
const QR_COOLDOWN_MS = 90_000;

function resultEnvelope(ok, extra = {}) {
  return { ok, ...extra };
}

/** native kernel message -> OneBot message segments. */
export function toOb11Segments(native, helpers = {}) {
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
        const qq = /^\d+$/.test(atUid) && atUid !== '0'
          ? atUid
          : /^\d+$/.test(resolved)
            ? resolved
            : /^\d+$/.test(rawUid) && rawUid !== '0'
              ? rawUid
              : '';
        // 只有 atType===1 才是 @全体；解析不出数字 QQ 号时退化成文本，
        // 绝不能把“未知的 @”当成 @全体发出去。
        const target = qq || (atType === 1 ? 'all' : '');
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
          ...(filePath ? { path: filePath } : {}),
          ...(url ? { url } : {}),
          ...(Number.isFinite(size) && size > 0 ? { file_size: String(ptt.fileSize) } : {}),
        },
      });
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
      const candidates = [reply.sourceMsgIdInRecords, reply.replyMsgId, reply.replayMsgId];
      const id = candidates
        .map((value) => String(value ?? ''))
        .find((value) => value && value !== '0') ?? '';
      // 空 id 会让框架 int('') 崩，宁可不带引用段。
      if (id) segments.push({ type: 'reply', data: { id } });
      continue;
    }
  }
  return segments;
}

const CQ_KIND = { image: 'image', face: 'face', at: 'at', reply: 'reply', record: 'record', video: 'video' };

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

export function createBridgeServer(options) {
  const kernel = options.kernel;
  const logger = options.logger ?? console;
  const token = options.token ?? '';
  const pumpEnabled = options.qrPump !== false;
  const qrCooldownMs = Number(options.qrCooldownMs ?? QR_COOLDOWN_MS);
  const ring = [];
  const instance = 'rt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  let cursor = 0;
  let phase = 'starting';
  let lastQrRequest = 0;
  let qrInFlight = false;
  let halted = false;
  let haltUntil = 0;
  let eventChain = Promise.resolve();
  let faultStatus = 0;
  let faultUntil = 0;

  const contractVersion = 2;
  /** Which segments this runtime can send / receive, direction is explicit. */
  const sendSegments = (kernel && kernel.sendSegments) || ['text', 'image'];
  const recvSegments = (kernel && kernel.recvSegments) || ['text', 'image', 'face', 'at', 'reply', 'record'];
  /** 段能力的方向必须如实分开报告：能收语音不等于能发语音。 */
  const canSend = (kind) => Array.isArray(sendSegments) && sendSegments.includes(kind);
  const canRecv = (kind) => Array.isArray(recvSegments) && recvSegments.includes(kind);
  const features = {
    privateMessage: true,
    groupMessage: true,
    mediaImage: true,
    recall: true,
    friendList: true,
    groupList: true,
    strangerInfo: typeof kernel.stranger === 'function',
    groupMemberInfo: true,
    groupMemberList: true,
    messageQuery: true,
    // 处理动作的能力要跟内核真实实现走：收得到申请和批不批是两件事，
    // 事件永远照传，能力位只决定 set_*_add_request 能不能用。
    requestHandle: typeof kernel.handleRequest === 'function',
    // 语音：入站由 pttElement 解析，出站需要客户端 RichMedia 路径接口。
    mediaRecord: canRecv('record') || canSend('record'),
    mediaVideo: false,
    mediaFile: false,
    // 运行时能否按消息 id 取回媒体字节（OneBot get_record 的后端）。
    mediaDownload: typeof kernel.media === 'function',
    passwordLogin: Boolean(kernel && kernel.passwordLoginEnabled),
    quickLogin: Boolean(kernel && kernel.quickLoginSupported),
    logout: false,
  };

  function note(message) {
    logger.log?.('[bridge] ' + message);
  }

  function currentQrPayload() {
    const qr = kernel.currentQr?.() ?? null;
    const loginMode = pumpEnabled ? 'active' : 'passive';
    if (!qr) {
      return { state: phase === 'qr_failed' ? 'expired' : 'unavailable', seq: kernel.qrSeq ?? 0, loginMode };
    }
    if (qr.expired) {
      phase = 'qr_failed';
      return { state: 'expired', seq: qr.seq, loginMode, hint: '二维码已过期，请刷新' };
    }
    if (kernel.qrState === 'scanned') {
      return { state: 'scanned', seq: qr.seq, loginMode, hint: '已扫码，请在手机上确认登录' };
    }
    return {
      state: kernel.qrState === 'confirmed' ? 'confirmed' : 'waiting',
      picture: qr.picture,
      seq: qr.seq,
      expiresAt: qr.expiresAt,
      loginMode,
      refreshable: pumpEnabled,
    };
  }

  function computePhase() {
    const status = kernel.status();
    if (status.online) return 'online';
    // Authorised but the message network is not up yet: never fall back to QR.
    if (status.authorized) return 'authenticated';
    if (kernel.qrState === 'scanned') return 'confirm_on_phone';
    if (kernel.qrState === 'waiting') return 'scan_qr';
    if (kernel.qrState === 'confirmed') return 'authenticated';
    if (kernel.qrState === 'expired') return 'qr_failed';
    return 'waiting_login';
  }

  async function noteEvents(native) {
    // The kernel pushes either a fully formed message or a notice.
    if (native.type === 'message') {
      // @ 段要数字 QQ 号；先把群成员表预热好，否则新群第一条 @ 会退化成 uid。
      if (typeof kernel.warmGroup === 'function') {
        await kernel.warmGroup(native.native).catch(() => {});
      }
      const normalized = normalizeMessage(native.native);
      // 群号解析不到时不要产出 group_id=0 的坏事件（AstrBot 会拿它回发并失败）。
      if (normalized.post_type === 'message' && normalized.message_type === 'group' && !normalized.group_id) {
        logger.warn?.('[bridge] 丢弃缺少群号的群消息');
        return;
      }
      note(
        'recv ' + (normalized.message_type === 'group' ? 'group' : 'private') +
        ' peer=' + String(normalized.group_id ?? normalized.user_id ?? '') +
        ' from=' + String(normalized.sender?.user_id ?? '') +
        ' segs=' + normalized.message.map((segment) => segment.type).join(',') +
        ' mid=' + String(normalized.message_id ?? ''),
      );
      cursor += 1;
      ring.push({ cursor, data: normalized });
      if (ring.length > RING) ring.shift();
      return;
    }
    if (native.type === 'request') {
      const request = native.request;
      const isGroup = request.kind === 'group';
      // 好友申请的 friendUid 是字母数字 uid，不是 QQ 号：Number('u_x') 会静默变成 0，
      // 机器人就会以为申请人 QQ 是 0 号。能换成 QQ 号就换，换不到就明确标成未解析。
      const rawId = String((request.user && request.user.id) ?? '');
      const uid = String((request.user && request.user.uid) || (/^\d+$/.test(rawId) ? '' : rawId));
      let userId = /^\d+$/.test(rawId) ? Number(rawId) : 0;
      if (!userId && uid && typeof kernel.uinOfUid === 'function') {
        const resolved = String(kernel.uinOfUid(uid) || '');
        if (/^\d+$/.test(resolved) && Number(resolved) > 0) userId = Number(resolved);
      }
      const unresolved = !userId;
      if (unresolved) {
        logger.warn?.(
          '[bridge] 请求事件的身份没能解析成 QQ 号（' +
          (uid ? 'uid=' + uid.slice(0, 24) : '无身份字段') +
          '），按 user_id=0 上报' + (uid ? '并附带 uid' : ''),
        );
      }
      const groupId = isGroup ? Number(request.peer && request.peer.id) || 0 : 0;
      if (isGroup && !groupId) logger.warn?.('[bridge] 群请求缺少群号，事件里 group_id 为 0');
      cursor += 1;
      ring.push({
        cursor,
        data: {
          time: request.time,
          self_id: Number(kernel.uin),
          post_type: 'request',
          request_type: isGroup ? 'group' : 'friend',
          ...(isGroup ? { sub_type: String((request.detail && request.detail.sub_type) || 'add') } : {}),
          comment: String(request.comment ?? ''),
          flag: request.flag,
          ...(isGroup ? { group_id: groupId, user_id: userId } : { user_id: userId }),
          // user_id=0 时把原始 uid 带上，机器人至少能显示是谁、并照 flag 处理申请。
          ...(unresolved && uid ? { uid } : {}),
        },
      });
      if (ring.length > RING) ring.shift();
      return;
    }

    if (native.type === 'notice') {
      cursor += 1;
      ring.push({ cursor, data: { time: Math.floor(Date.now() / 1000), self_id: Number(kernel.uin), ...native.notice } });
      if (ring.length > RING) ring.shift();
    }
  }

  /**
   * Shared normaliser for "one native message -> OneBot message payload", used
   * both by the live event stream and by the on-demand /api/message lookup, so
   * a queried message looks exactly like the one that was pushed.
   */
  function normalizeMessage(nativeMessage) {
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

  async function pumpQr() {
    if (halted) return;
    if (kernel.status().online) return;
    // Once the account is authorised there is nothing to scan; requesting more
    // codes only makes the console bounce back to the QR screen.
    if (kernel.status().authorized) return;
    if (kernel.currentQr() && !kernel.currentQr().expired) return;
    if (!pumpEnabled) return;
    if (qrInFlight) return;
    if (Date.now() - lastQrRequest < qrCooldownMs) return;
    qrInFlight = true;
    lastQrRequest = Date.now();
    try {
      const accepted = await kernel.requestQr();
      if (!accepted) note('主动取码未被接受');
    } catch (error) {
      note('主动取码失败（待实机验证）：' + (error instanceof Error ? error.message : String(error)));
    } finally {
      qrInFlight = false;
    }
  }

  async function handleApi(url, request, response, bodyText) {
    const send = (status, value) => {
      const payload = JSON.stringify(value);
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(payload);
    };

    if (faultStatus && Date.now() < faultUntil) return send(faultStatus, { error: 'injected fault' });
    if (halted && Date.now() < haltUntil) return send(503, { error: 'runtime temporarily offline' });

    if (request.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, mode: kernel.mode });

    if (url.pathname === '/api/status' && request.method === 'GET') {
      phase = computePhase();
      const status = kernel.status();
      return send(200, {
        message_ready: status.online,
        authorized: Boolean(status.authorized),
        msf_status: Number(status.msf ?? 0),
        self_id: status.authorized || status.online ? Number(kernel.uin) : 0,
        // 账号本次登录的起始时间（毫秒），控制台据此显示持续在线时长。
        login_at: Number((status && status.loginAt) || 0),
        nickname: status.nick,
        avatar: status.avatar,
        version: kernel.version,
        phase,
        login_mode: pumpEnabled ? 'active' : 'passive',
        qr_ready: Boolean(kernel.currentQr() && !kernel.currentQr().expired),
        mode: kernel.mode,
        contract: contractVersion,
        instance,
        send_segments: sendSegments,
        recv_segments: recvSegments,
        // 能力可能随登录状态变化（登录服务晚于进程启动），这里按当前状态重算。
        features: {
          ...features,
          quickLogin: Boolean(kernel && kernel.quickLoginSupported),
          passwordLogin: Boolean(kernel && kernel.passwordLoginEnabled),
          logout: Boolean(kernel && kernel.logoutSupported),
        },
        ...(typeof kernel.diagnostics === 'function' ? { native_probe: kernel.diagnostics() } : {}),
        ...(Array.isArray(kernel.pendingNative) && kernel.pendingNative.length > 0
          ? { pending_native: kernel.pendingNative }
          : {}),
      });
    }

    if (url.pathname === '/api/qr' && request.method === 'GET') {
      const live = kernel.status();
      if (live.authorized && !live.online) {
        return send(200, {
          state: 'none',
          seq: kernel.qrSeq ?? 0,
          refreshable: false,
          loginMode: pumpEnabled ? 'active' : 'passive',
          hint: '已授权，等待消息网络连接（MSF=' + Number(live.msf ?? 0) + '）；无需再次扫码',
          phase: 'authenticated',
        });
      }
      const payload = currentQrPayload();
      if (!payload.picture) {
        const hint = payload.state === 'scanned' ? payload.hint : payload.hint ?? '暂无二维码，运行时会在后台请求';
        return send(200, { ...payload, hint, phase: computePhase() });
      }
      return send(200, { ...payload, phase: computePhase(), login_mode: pumpEnabled ? 'active' : 'passive' });
    }

    if (url.pathname === '/api/login' && request.method === 'POST') {
      if (!kernel.login) return send(501, { error: '运行时未实现密码登录' });
      let body;
      try {
        body = JSON.parse(bodyText || '{}');
      } catch {
        return send(400, { error: '请求体不是合法 JSON' });
      }
      if (body.method === 'quick') {
        if (typeof kernel.quickLogin !== 'function') return send(501, { error: '运行时未实现快速登录' });
        try {
          await kernel.quickLogin(String(body.uin ?? ''));
          return send(202, { accepted: true });
        } catch (error) {
          return send(502, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (body.method !== 'password') return send(400, { error: 'method 只能是 password 或 quick' });
      try {
        await kernel.login({ method: 'password', uin: String(body.uin ?? ''), password: String(body.password ?? '') });
        return send(202, { accepted: true });
      } catch (error) {
        return send(502, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (url.pathname === '/api/qr/refresh' && request.method === 'POST') {
      if (kernel.status().authorized) return send(409, { error: '账号已授权，无需刷新二维码；等待消息网络连接' });
      if (!pumpEnabled) return send(409, { error: '被动模式：请在 QQ 窗口刷新二维码' });
      try {
        const accepted = await kernel.requestQr();
        lastQrRequest = Date.now();
        return send(202, { accepted: Boolean(accepted) });
      } catch (error) {
        return send(503, { error: '主动取码失败（待实机验证）：' + (error instanceof Error ? error.message : String(error)) });
      }
    }

    if (url.pathname === '/api/events' && request.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      const oldest = ring.length > 0 ? ring[0].cursor : cursor + 1;
      const lost = after + 1 < oldest ? oldest - (after + 1) : 0;
      const events = ring.filter((item) => item.cursor > after);
      return send(200, { cursor, instance, events, ...(lost > 0 ? { lost } : {}) });
    }

    if (url.pathname === '/api/send' && request.method === 'POST') {
      if (!kernel.send) return send(501, { error: '运行时未实现统一发送' });
      let body = {};
      let scene = 'private';
      let peerId = '';
      try {
        body = JSON.parse(bodyText || '{}');
        scene = body.scene === 'group' ? 'group' : 'private';
        peerId = String(body.peer_id ?? '');
        if (!peerId) return send(400, { error: '缺少 peer_id' });
        if (!Array.isArray(body.segments) || body.segments.length === 0) return send(400, { error: 'segments 不能为空' });
        for (const segment of body.segments) {
          if (segment?.type === 'image' && !segment?.data?.file) return send(400, { error: '图片段缺少 file' });
          if (segment?.type === 'record') {
            if (!canSend('record')) return send(501, { error: '运行时不支持语音发送' });
            if (!String(segment?.data?.file ?? '').trim()) return send(400, { error: '语音段缺少 file' });
            continue;
          }
          if (segment?.type === 'video' || segment?.type === 'file') {
            return send(501, { error: '运行时未实现 ' + segment.type + ' 发送' });
          }
        }
        const sent = await kernel.send({ scene, peerId, segments: body.segments });
        note(
          'send ' + scene + ' peer=' + peerId +
          ' segs=' + body.segments.map((segment) => String(segment?.type ?? '?')).join(',') +
          ' mid=' + String(sent.messageId ?? ''),
        );
        return send(200, { message_id: sent.messageId });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error('[bridge] send failed', detail, '\n', error instanceof Error ? error.stack : '');
        logger.warn?.('[bridge] send ' + scene + ' peer=' + peerId + ' 失败：' + detail);
        return send(502, { error: '原生发送失败：' + detail });
      }
    }

    if (url.pathname === '/api/send-private' && request.method === 'POST') {
      try {
        const body = JSON.parse(bodyText || '{}');
        const sent = await kernel.send({
          scene: 'private',
          peerId: String(body.user_id ?? ''),
          segments: [{ type: 'text', data: { text: String(body.message ?? '') } }],
        });
        return send(200, { message_id: sent.messageId });
      } catch (error) {
        return send(502, { error: '原生发送失败：' + (error instanceof Error ? error.message : String(error)) });
      }
    }

    if (url.pathname === '/api/recall' && request.method === 'POST') {
      try {
        const body = JSON.parse(bodyText || '{}');
        if (!body.message_id) return send(400, { error: '缺少 message_id' });
        await kernel.recall(String(body.message_id));
        return send(200, resultEnvelope(true));
      } catch (error) {
        return send(502, { error: '撤回失败：' + (error instanceof Error ? error.message : String(error)) });
      }
    }

    if (url.pathname === '/api/message' && request.method === 'GET') {
      // Native lookup by message id; the framework falls back to this when its
      // local window no longer holds the message.
      if (!kernel.getMessage) return send(501, { error: '运行时未实现按 ID 查询' });
      try {
        const found = await kernel.getMessage(String(url.searchParams.get('message_id') ?? ''));
        if (!found) return send(404, { error: '消息不存在' });
        return send(200, normalizeMessage(found));
      } catch (error) {
        // 404 才会被驱动当成“查不到”而不是“桥接坏了”，日志里就不会再出现 HTTP 500。
        return send(404, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (url.pathname === '/api/logout' && request.method === 'POST') {
      if (typeof kernel.logout !== 'function') return send(501, { error: '运行时未实现退出登录' });
      try {
        await kernel.logout();
        return send(202, { accepted: true });
      } catch (error) {
        return send(502, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (url.pathname === '/api/media' && request.method === 'GET') {
      if (typeof kernel.media !== 'function') return send(501, { error: '运行时未实现媒体下载' });
      const kind = url.searchParams.get('kind') === 'record' ? 'record' : 'image';
      try {
        const media = await kernel.media(String(url.searchParams.get('message_id') ?? ''), kind);
        return send(200, media);
      } catch (error) {
        return send(404, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === '/api/quick-list' && request.method === 'GET') {
      const items = typeof kernel.quickList === 'function' ? await kernel.quickList() : [];
      return send(200, { items });
    }
    if (url.pathname === '/api/friends' && request.method === 'GET') {
      return send(200, { items: await kernel.friends() });
    }
    if (url.pathname === '/api/groups' && request.method === 'GET') {
      return send(200, { items: await kernel.groups() });
    }
    if (url.pathname === '/api/group-member' && request.method === 'GET') {
      return send(200, await kernel.groupMember(url.searchParams.get('group_id'), url.searchParams.get('user_id')));
    }
    if (url.pathname === '/api/group-members' && request.method === 'GET') {
      return send(200, { items: await kernel.groupMembers(url.searchParams.get('group_id')) });
    }
    if (url.pathname === '/api/stranger' && request.method === 'GET') {
      try {
        return send(200, await kernel.stranger(String(url.searchParams.get('user_id') ?? '')));
      } catch (error) {
        return send(404, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (url.pathname === '/api/request' && request.method === 'POST') {
      try {
        const body = JSON.parse(bodyText || '{}');
        await kernel.handleRequest({
          flag: String(body.flag ?? ''),
          approve: body.approve !== false,
          type: body.type === 'group' ? 'group' : 'friend',
          subType: body.sub_type,
        });
        return send(200, resultEnvelope(true));
      } catch (error) {
        return send(502, { error: '处理请求失败：' + (error instanceof Error ? error.message : String(error)) });
      }
    }

    // Test-only controls; never enabled for the native kernel.
    if (kernel.mode === 'sim') {
      if (url.pathname === '/sim/emit' && request.method === 'POST') {
        kernel.incoming(JSON.parse(bodyText || '{}'));
        return send(200, { cursor });
      }
      if (url.pathname === '/sim/request' && request.method === 'POST') {
        const flag = kernel.request(JSON.parse(bodyText || '{}'));
        return send(200, { cursor, flag });
      }
      if (url.pathname === '/sim/backlog' && request.method === 'POST') {
        const body = JSON.parse(bodyText || '{}');
        const count = Math.max(1, Math.min(Number(body.count ?? 0), 900));
        for (let index = 0; index < count; index += 1) {
          kernel.incoming({ scene: body.scene === 'group' ? 'group' : 'private', text: '积压消息 ' + (index + 1) });
        }
        return send(200, { cursor, count });
      }
      if (url.pathname === '/sim/qr' && request.method === 'POST') {
        const body = JSON.parse(bodyText || '{}');
        if (body.action === 'issue') kernel.issueQr(Number(body.ttlMs ?? 0) || undefined);
        if (body.action === 'scan') kernel.scanQr();
        if (body.action === 'confirm') kernel.confirmQr();
        return send(200, { qr: currentQrPayload() });
      }
      if (url.pathname === '/sim/online' && request.method === 'POST') {
        const body = JSON.parse(bodyText || '{}');
        kernel.setOnline(Boolean(body.value));
        return send(200, { online: kernel.status().online });
      }
      if (url.pathname === '/sim/fault' && request.method === 'POST') {
        const body = JSON.parse(bodyText || '{}');
        if (body.status) {
          faultStatus = Number(body.status);
          faultUntil = Date.now() + Number(body.ms ?? 3000);
        } else {
          faultStatus = 0;
        }
        if (body.haltMs) {
          halted = true;
          haltUntil = Date.now() + Number(body.haltMs);
        }
        return send(200, { ok: true });
      }
      if (url.pathname === '/sim/state' && request.method === 'GET') {
        return send(200, {
          phase: computePhase(),
          cursor,
          ring: ring.length,
          sent: kernel.sent.length,
          requests: Array.isArray(kernel.requests) ? kernel.requests.length : 0,
          qr: currentQrPayload(),
        });
      }
    }

    return send(404, { error: 'not found' });
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let bodyText = '';
    request.on('data', (chunk) => {
      bodyText += String(chunk);
      // 图片段是 base64，几 MB 很正常；上限给到 64MB。
      if (bodyText.length > 64 * 1024 * 1024) request.destroy();
    });
    request.on('end', async () => {
      const supplied = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(supplied);
      const b = Buffer.from(token);
      const authorized = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!authorized && !(kernel.mode === 'sim' && url.pathname.startsWith('/sim/'))) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      try {
        await handleApi(url, request, response, bodyText);
      } catch (error) {
        logger.error?.('[bridge] handler failed: ' + (error instanceof Error ? error.stack : String(error)));
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'internal error' }));
        }
      }
    });
  });

  const timer = setInterval(() => {
    void pumpQr();
  }, 3000);
  timer.unref?.();

  return {
    server,
    kernel,
    features,
    /**
     * Kernel events are funnelled here so the ring/cursor logic lives in one place.
     * 串成一条 promise 链：消息里要 await 群成员预热，但游标/事件顺序不能乱。
     */
    ingest(event) {
      // P0-1：以前这里只放行 message/notice，内核发出的 request（好友/加群申请）
      // 被整类丢掉——能力位 requestHandle 却是 true，机器人永远收不到申请。
      // 三类事件必须走同一条串行链，顺序才不会乱。
      const type = event?.type;
      if (type === 'message' || type === 'notice' || type === 'request') {
        eventChain = eventChain
          .then(() => noteEvents(event))
          .catch((error) => { logger.warn?.('[bridge] event failed: ' + String(error && error.message ? error.message : error)); });
      }
    },
    get phase() {
      return computePhase();
    },
    setPump(enabled) {
      pumpEnabled = enabled;
    },
    async listen(port, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      return server.address();
    },
    async close() {
      clearInterval(timer);
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

export async function attachKernelEvents(bridge, kernel) {
  await kernel.start((event) => bridge.ingest(event));
}
