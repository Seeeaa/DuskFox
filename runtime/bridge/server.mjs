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
export function toOb11Segments(native) {
  const segments = [];
  for (const element of Array.isArray(native.elements) ? native.elements : []) {
    if (element?.textElement) {
      segments.push({ type: 'text', data: { text: String(element.textElement.content ?? '') } });
      continue;
    }
    if (element?.picElement) {
      const pic = element.picElement;
      segments.push({
        type: 'image',
        data: {
          file: String(pic.fileName ?? ''),
          ...(pic.originImageUrl ? { url: String(pic.originImageUrl) } : {}),
          ...(pic.thumbImageUrl && !pic.originImageUrl ? { url: String(pic.thumbImageUrl) } : {}),
        },
      });
      continue;
    }
    if (element?.faceElement) {
      segments.push({ type: 'face', data: { id: String(element.faceElement.faceIndex ?? '') } });
      continue;
    }
    if (element?.atElement) {
      segments.push({ type: 'at', data: { qq: String(element.atElement.qq ?? element.atElement.atNtUid ?? '') } });
      continue;
    }
    if (element?.replyElement) {
      segments.push({ type: 'reply', data: { id: String(element.replyElement.replyMsgId ?? '') } });
      continue;
    }
  }
  return segments;
}

function textOf(segments) {
  return segments
    .map((segment) => (segment.type === 'text' ? String(segment.data?.text ?? '') : '[图片]'))
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
  let faultStatus = 0;
  let faultUntil = 0;

  const contractVersion = 2;
  /** Which segments this runtime can send / receive, direction is explicit. */
  const sendSegments = ['text', 'image'];
  const recvSegments = ['text', 'image', 'face', 'at', 'reply'];
  const features = {
    privateMessage: true,
    groupMessage: true,
    mediaImage: true,
    recall: true,
    friendList: true,
    groupList: true,
    strangerInfo: false,
    groupMemberInfo: true,
    groupMemberList: true,
    messageQuery: true,
    requestHandle: true,
    mediaRecord: false,
    mediaVideo: false,
    mediaFile: false,
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
    if (kernel.qrState === 'scanned') return 'confirm_on_phone';
    if (kernel.qrState === 'waiting') return 'scan_qr';
    if (kernel.qrState === 'confirmed') return 'authenticated';
    if (kernel.qrState === 'expired') return 'qr_failed';
    return 'waiting_login';
  }

  function noteEvents(native) {
    // The kernel pushes either a fully formed message or a notice.
    if (native.type === 'message') {
      cursor += 1;
      ring.push({ cursor, data: normalizeMessage(native.native) });
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
    const segments = toOb11Segments(nativeMessage);
    const isGroup = nativeMessage.chatType === 2 || Boolean(nativeMessage.groupCode);
    return {
      time: Number(nativeMessage.msgTime || Math.floor(Date.now() / 1000)),
      self_id: Number(kernel.uin),
      post_type: 'message',
      message_type: isGroup ? 'group' : 'private',
      sub_type: isGroup ? 'normal' : 'friend',
      message_id: String(nativeMessage.msgId ?? ''),
      ...(isGroup ? { group_id: Number(nativeMessage.groupCode ?? 0) } : { user_id: Number(nativeMessage.senderUin ?? 0) }),
      message: segments,
      raw_message: textOf(segments),
      font: 0,
      sender: {
        user_id: Number(nativeMessage.senderUin ?? 0),
        nickname: String(nativeMessage.sendNickName ?? nativeMessage.senderUin ?? ''),
      },
      ...(nativeMessage.self ? { self: true } : {}),
    };
  }

  async function pumpQr() {
    if (halted) return;
    if (kernel.status().online) return;
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
        self_id: status.online ? Number(kernel.uin) : 0,
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
        features,
      });
    }

    if (url.pathname === '/api/qr' && request.method === 'GET') {
      const payload = currentQrPayload();
      if (!payload.picture) {
        const hint = payload.state === 'scanned' ? payload.hint : payload.hint ?? '暂无二维码，运行时会在后台请求';
        return send(200, { ...payload, hint, phase: computePhase() });
      }
      return send(200, { ...payload, phase: computePhase(), login_mode: pumpEnabled ? 'active' : 'passive' });
    }

    if (url.pathname === '/api/qr/refresh' && request.method === 'POST') {
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
      try {
        const body = JSON.parse(bodyText || '{}');
        const scene = body.scene === 'group' ? 'group' : 'private';
        if (!body.peer_id) return send(400, { error: '缺少 peer_id' });
        if (!Array.isArray(body.segments) || body.segments.length === 0) return send(400, { error: 'segments 不能为空' });
        for (const segment of body.segments) {
          if (segment?.type === 'image' && !segment?.data?.file) return send(400, { error: '图片段缺少 file' });
          if (segment?.type === 'record' || segment?.type === 'video' || segment?.type === 'file') {
            return send(501, { error: '运行时未实现 ' + segment.type + ' 发送' });
          }
        }
        const sent = await kernel.send({ scene, peerId: String(body.peer_id), segments: body.segments });
        return send(200, { message_id: sent.messageId });
      } catch (error) {
        return send(502, { error: '原生发送失败：' + (error instanceof Error ? error.message : String(error)) });
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
      const found = await kernel.getMessage(String(url.searchParams.get('message_id') ?? ''));
      if (!found) return send(404, { error: '消息不存在' });
      return send(200, normalizeMessage(found));
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
      return send(501, { error: '运行时未实现陌生人信息（待实机验证）' });
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
        return send(200, { phase: computePhase(), cursor, ring: ring.length, sent: kernel.sent.length, qr: currentQrPayload() });
      }
    }

    return send(404, { error: 'not found' });
  }

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    let bodyText = '';
    request.on('data', (chunk) => {
      bodyText += String(chunk);
      if (bodyText.length > 1024 * 1024) request.destroy();
    });
    request.on('end', async () => {
      const supplied = String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(supplied);
      const b = Buffer.from(token);
      const authorized = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!authorized && !url.pathname.startsWith('/sim/')) {
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
    /** Kernel events are funnelled here so the ring/cursor logic lives in one place. */
    ingest(event) {
      if (event?.type === 'message' || event?.type === 'notice') noteEvents(event);
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
