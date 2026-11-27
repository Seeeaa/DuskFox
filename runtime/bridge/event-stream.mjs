import { normalizeMessage } from './kernel/elements.cjs';

export function createEventStream(kernel, logger, note, capacity = 8192) {
  const ring = [];
  let cursor = 0;
  let eventChain = Promise.resolve();
  const normalize = (native) => normalizeMessage(native, kernel, logger);
  async function noteEvents(native) {
    // The kernel pushes either a fully formed message or a notice.
    if (native.type === 'message') {
      // @ 段要数字 QQ 号；先把群成员表预热好，否则新群第一条 @ 会退化成 uid。
      if (typeof kernel.warmGroup === 'function') {
        await kernel.warmGroup(native.native).catch(() => { });
      }
      const normalized = normalize(native.native);
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
      if (ring.length > capacity) ring.shift();
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
      if (ring.length > capacity) ring.shift();
      return;
    }

    if (native.type === 'notice') {
      cursor += 1;
      ring.push({ cursor, data: { time: Math.floor(Date.now() / 1000), self_id: Number(kernel.uin), ...native.notice } });
      if (ring.length > capacity) ring.shift();
    }
  }

  return {
    get cursor() { return cursor; },
    get size() { return ring.length; },
    after(after) {
      const oldest = ring.length ? ring[0].cursor : cursor + 1;
      const lost = Math.max(0, oldest - after - 1);
      return { cursor, events: ring.filter(item => item.cursor > after), ...(lost ? { lost } : {}) };
    },
    ingest(event) {
      if (!['message', 'notice', 'request'].includes(event?.type)) return;
      eventChain = eventChain.then(() => noteEvents(event)).catch(error => logger.error?.('[bridge] event failed: ' + (error.stack || error)));
      return eventChain;
    },
  };
}
