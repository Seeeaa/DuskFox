import { parseReplyHandle } from '../kernel/shared.cjs';

/** One registration per method/path; no mirrored pathname list. */
export function createAccountRoutes(context) {
  const { kernel, logger, note, canSend, normalizeMessage } = context;
  const resultEnvelope = (ok, extra = {}) => ({ ok, ...extra });
  return new Map([
    ["POST /api/send", async ({ url, request, body, send }) => {

      if (!kernel.send) return send(501, { error: '运行时未实现统一发送' });

      let scene = 'private';
      let peerId = '';
      try {

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
          if (segment?.type === 'file' || segment?.type === 'video') {
            if (!canSend(segment.type)) return send(501, { error: '运行时不支持发送 ' + segment.type });
            if (!String(segment?.data?.file ?? segment?.data?.path ?? '').trim()) {
              return send(400, { error: segment.type + ' 段缺少 file' });
            }
            continue;
          }
          if (segment?.type === 'forward') {
            if (!canSend('forward')) return send(501, { error: '运行时不支持发送合并转发' });
            if (!Array.isArray(segment?.data?.content) && !String(segment?.data?.id ?? '').trim()) {
              return send(400, { error: '合并转发段需要 content 节点或 id' });
            }
            continue;
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
        // 消息可能已送达、只是拿不到回执：这不是普通失败，必须让调用方知道别自动重试。
        if (detail.includes('SEND_RESULT_UNKNOWN')) {
          logger.warn?.('[bridge] send ' + scene + ' peer=' + peerId + ' 结果未知：' + detail);
          return send(202, { ok: false, unknown: true, error: detail.replace('SEND_RESULT_UNKNOWN: ', '') });
        }
        console.error('[bridge] send failed', detail, '\n', error instanceof Error ? error.stack : '');
        logger.warn?.('[bridge] send ' + scene + ' peer=' + peerId + ' 失败：' + detail);
        return send(error.statusCode || 502, { error: '原生发送失败：' + detail, code: error.code, until: error.until });
      }

    }],
    ["POST /api/send-private", async ({ url, request, body, send }) => {

      try {

        const sent = await kernel.send({
          scene: 'private',
          peerId: String(body.user_id ?? ''),
          segments: [{ type: 'text', data: { text: String(body.message ?? '') } }],
        });
        return send(200, { message_id: sent.messageId });
      } catch (error) {
        return send(error.statusCode || 502, { error: '原生发送失败：' + (error instanceof Error ? error.message : String(error)), code: error.code, until: error.until });
      }

    }],
    ["POST /api/recall", async ({ url, request, body, send }) => {

      try {

        if (!body.message_id) return send(400, { error: '缺少 message_id' });
        await kernel.recall(String(body.message_id));
        return send(200, resultEnvelope(true));
      } catch (error) {
        return send(error.statusCode || 502, { error: '撤回失败：' + (error instanceof Error ? error.message : String(error)), code: error.code, until: error.until });
      }

    }],
    ["GET /api/message", async ({ url, request, body, send }) => {

      // Native lookup by message id; the framework falls back to this when its
      // local window no longer holds the message.
      if (!kernel.getMessage) return send(501, { error: '运行时未实现按 ID 查询' });
      try {
        const requestedId = String(url.searchParams.get('message_id') ?? '');
        if (requestedId.startsWith('dfr:') && !parseReplyHandle(requestedId)) return send(404, { error: '引用句柄无效' });
        const peerId = String(url.searchParams.get('peer_id') || '');
        const hint = peerId ? {
          chatType: url.searchParams.get('scene') === 'group' ? 2 : 1,
          peerUid: peerId, guildId: '',
        } : undefined;
        if (hint && hint.chatType === 1 && !kernel.state?.peerByMsgId?.has(requestedId) && typeof kernel.resolveUid === 'function') {
          hint.peerUid = await kernel.resolveUid(peerId);
        }
        const found = await kernel.getMessage(requestedId, hint);
        if (!found) return send(404, { error: '消息不存在' });
        return send(200, normalizeMessage(found));
      } catch (error) {
        // 原生查询报错保留原始原因；只有正常查询无结果才是 404。
        return send(502, { error: error instanceof Error ? error.message : String(error) });
      }

    }],
    ["POST /api/logout", async ({ url, request, body, send }) => {

      if (typeof kernel.logout !== 'function') return send(501, { error: '运行时未实现退出登录' });
      try {
        await kernel.logout();
        return send(202, { accepted: true });
      } catch (error) {
        return send(502, { error: error instanceof Error ? error.message : String(error) });
      }

    }],
    ["GET /api/forward", async ({ url, request, body, send }) => {

      if (typeof kernel.getForward !== 'function') {
        return send(501, { error: '运行时未实现合并转发展开（缺少 getMultiMsg）' });
      }
      try {
        const nodes = await kernel.getForward(String(url.searchParams.get('message_id') ?? ''));
        if (!nodes) return send(404, { error: '合并转发不存在、已失效，或getMultiMsg 返回结构与预期不符' });
        // 原生给的是 RawMessage，这里统一转成 OneBot 节点；已是 OneBot 形状的原样放行。
        const content = nodes.map((node) => {
          if (node && Array.isArray(node.message)) return node;
          if (node?.type === 'node' && node.data) return node;
          if (node && Array.isArray(node.content)) return { ...node, message: node.content };
          const parsed = normalizeMessage(node);
          return {
            message_id: String(parsed.message_id || ''),
            user_id: Number(parsed.sender && parsed.sender.user_id) || 0,
            sender: parsed.sender,
            nickname: String((parsed.sender && parsed.sender.nickname) || ''),
            time: Number(parsed.time) || 0,
            message: parsed.message,
          };
        });
        return send(200, { content });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 原生展开失败保留原因，不改写成“消息不存在”。
        if (detail.includes('超时')) return send(504, { error: detail });
        return send(502, { error: detail });
      }

    }],
    ["GET /api/media", async ({ url, request, body, send }) => {

      if (typeof kernel.media !== 'function') return send(501, { error: '运行时未实现媒体下载' });
      const requested = String(url.searchParams.get('kind') ?? 'image');
      // 未知 kind 必须明确报错：以前"非 record 即 image"会让 file/video 报"该消息不包含图片"，
      // 把"不支持"伪装成"消息里没有图片"（08 报告第 53/85 条要求禁止这种降级）。
      if (!['image', 'record', 'file', 'video'].includes(requested)) {
        return send(400, { error: '未知的媒体类型 kind=' + requested + '（只支持 image|record|file|video）' });
      }
      const kind = requested;
      try {
        const media = await kernel.media(String(url.searchParams.get('message_id') ?? ''), kind, String(url.searchParams.get('selector') ?? ''));
        return send(200, media);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        // 未落盘与原生下载失败分别返回 409/502。
        const timedOut = detail.includes('MEDIA_DOWNLOAD_TIMEOUT');
        const notReady = detail.includes('尚未落到本地') || detail.includes('未落盘');
        return send(timedOut ? 504 : notReady ? 409 : 502, { error: detail });
      }

    }],
    ["GET /api/quick-list", async ({ url, request, body, send }) => {

      const items = typeof kernel.quickList === 'function' ? await kernel.quickList() : [];
      return send(200, { items });

    }],
    ["GET /api/friends", async ({ url, request, body, send }) => {

      return send(200, { items: await kernel.friends() });

    }],
    ["GET /api/groups", async ({ url, request, body, send }) => {

      return send(200, { items: await kernel.groups() });

    }],
    ["GET /api/group-member", async ({ url, request, body, send }) => {

      return send(200, await kernel.groupMember(url.searchParams.get('group_id'), url.searchParams.get('user_id')));

    }],
    ["GET /api/group-members", async ({ url, request, body, send }) => {

      return send(200, { items: await kernel.groupMembers(url.searchParams.get('group_id')) });

    }],
    ["GET /api/stranger", async ({ url, request, body, send }) => {

      try {
        return send(200, await kernel.stranger(String(url.searchParams.get('user_id') ?? '')));
      } catch (error) {
        return send(404, { error: error instanceof Error ? error.message : String(error) });
      }

    }],
    ["POST /api/request", async ({ url, request, body, send }) => {

      try {

        await kernel.handleRequest({
          flag: String(body.flag ?? ''),
          approve: body.approve !== false,
          type: body.type === 'group' ? 'group' : 'friend',
          subType: body.sub_type,
        });
        return send(200, resultEnvelope(true));
      } catch (error) {
        return send(error.statusCode || 502, { error: '处理请求失败：' + (error instanceof Error ? error.message : String(error)), code: error.code, until: error.until });
      }

    }]
  ]);
}
