'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */
const { CHAT_PRIVATE, CHAT_GROUP, withTimeout, elementKind, messageList, replyId, parseReplyHandle, nativeForwardId } = require('./shared.cjs');
const { rememberedAccount } = require('./meta.cjs');

class MessagesDomain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** Cache history without publishing it; seed reply lookups from the referencing message. */
  cacheMessage(message) {
    const id = String(message?.msgId || '');
    if (!id) return message;
    this.ctx.state.nativeMessages.set(id, message);
    const peer = message.parentMsgPeer || {
      chatType: Number(message.chatType || CHAT_PRIVATE),
      peerUid: String(message.peerUid || ''),
      guildId: '',
    };
    if (peer.peerUid) this.ctx.state.peerByMsgId.set(id, peer);
    for (const element of message.elements || []) {
      const forwardId = nativeForwardId(element, id);
      if (forwardId) this.ctx.state.forwardOwners.set(forwardId, {
        nativeId: id, chatType: peer.chatType, peerUid: peer.peerUid, at: Date.now(),
      });
      const reply = element?.replyElement;
      if (!reply) continue;
      const target = replyId(message, reply);
      if (!target) continue;
      const sourcePeer = reply._replyMsgPeer || peer;
      this.ctx.state.replySources.set(target, {
        peer: sourcePeer, rootId: id,
        seq: String(reply.replayMsgSeq || ''),
        clientSeq: String(reply.replyMsgClientSeq || ''),
        time: String(reply.replyMsgTime || ''),
        senderUid: String(reply.senderUidStr || ''),
        senderUin: String(reply.senderUin || reply.senderUid || ''),
      });
      if (sourcePeer.peerUid) this.ctx.state.peerByMsgId.set(target, sourcePeer);
    }
    while (this.ctx.state.nativeMessages.size > 2000) {
      this.ctx.state.nativeMessages.delete(this.ctx.state.nativeMessages.keys().next().value);
    }
    while (this.ctx.state.replySources.size > 5000) {
      this.ctx.state.replySources.delete(this.ctx.state.replySources.keys().next().value);
    }
    return message;
  }

  onNativeMessage(message) {
    if (!message || message.isImportMsg === true) return;
    // 任何真实入站消息都是"消息连接还活着"的证据。
    this.ctx.state.lastMsgAt = Date.now();
    const elements = Array.isArray(message.elements) ? message.elements : [];
    const nativeId = String(message.msgId || '');
    this.cacheMessage(message);
    // 转发消息只带 resId（08 实测），先记下 resId 与所属消息/peer 的关系，
    // 否则 OneBot 用 resId 当 id 来查时会因为 getMessage(resId) 查不到而拿到空 peer。
    for (const element of elements) {
      const forward = element && element.multiForwardMsgElement;
      if (!forward) continue;
      this.ctx.state.forwardOwners.set(String(forward.resId || nativeId), {
        nativeId: String(message.msgId ?? ''),
        chatType: Number(message.chatType ?? 0),
        peerUid: String(message.peerUid ?? ''),
        at: Date.now(),
      });
    }
    // 发送回显：QQ 会把自己刚发出去的消息再回调一次，但元素为空、senderUin=0。
    // 这种回声既解析不出内容，还会被框架当成新消息重复触发指令，直接丢弃。
    if (elements.length === 0) return;
    if (String(this.ctx.state.uin || '') && String(message.senderUin ?? '') === String(this.ctx.state.uin)) return;
    const msgId = String(message.msgId ?? '');
    if (msgId) {
      // 同一条消息可能经多个回调重复到达：只发一次，避免机器人重复回复。
      if (this.ctx.state.metaByMsgId.has(msgId)) return;
      const meta = {
        msgId,
        msgSeq: String(message.msgSeq ?? ''),
        msgTime: String(message.msgTime ?? ''),
        senderUid: String(message.senderUid ?? ''),
        senderUidStr: String(message.senderUidStr ?? ''),
        senderUin: String(message.senderUin ?? ''),
        peerUid: String(message.peerUid ?? ''),
        chatType: message.chatType,
      };
      this.ctx.state.metaByMsgId.set(msgId, meta);
      this.ctx.state.peerByMsgId.set(msgId, { chatType: message.chatType, peerUid: meta.peerUid, guildId: '' });
      this.ctx.kernel.scheduleMetaFlush();
      if (this.ctx.state.metaByMsgId.size > 600) {
        const oldest = this.ctx.state.metaByMsgId.keys().next();
        if (!oldest.done) {
          this.ctx.state.metaByMsgId.delete(oldest.value);
          this.ctx.state.peerByMsgId.delete(oldest.value);
        }
      }
      const uin = String(message.senderUin ?? '');
      const uid = String(message.senderUid ?? '');
      if (uin && uid) this.ctx.state.uinByUid.set(uid, uin);
      // 记录见过的群：内核 onGroupListUpdate 不推数据时，群列表退回这份缓存。
      if (Number(message.chatType) === 2 && /^\d{5,}$/.test(meta.peerUid)) {
        this.ctx.state.groupsSeen.set(meta.peerUid, this.ctx.state.groupsSeen.get(meta.peerUid) || '');
        this.ctx.kernel.warmGroupMembers(meta.peerUid);
      }
      const nick = String(message.sendMemberName || message.sendNickName || '');
      if (uin && nick) this.ctx.state.nickByUin.set(uin, nick);
    }
    this.ctx.kernel.rememberNativeShape(message);
    this.ctx.kernel.markOnline();
    // 自己发出的消息会回显：记录元素类型，用来确认引用/@/图片是否真的进了原生包。
    if (String(this.ctx.state.uin || '') && String(message.senderUin ?? '') === String(this.ctx.state.uin)) {
      const types = (Array.isArray(message.elements) ? message.elements : [])
        .map((element) => String(element?.elementType ?? '?'))
        .join(',');
      console.log(
        '[bridge] self-echo mid=' + String(message.msgId ?? '') +
        ' seq=' + String(message.msgSeq ?? '') +
        ' clientSeq=' + String(message.clientSeq ?? '') +
        ' types=' + types,
      );
    }
    this.ctx.state.emit({ type: 'message', native: message });
  }

  /**
     * 按 ID 查询消息（get_msg 的运行时回退）。
     * 【待实机验证】getMsgsByMsgId 的返回结构与 peer 是否必需。
     */
  async getMessage(msgId, peerHint) {
    const key = String(msgId);
    const handle = key.startsWith('dfr:') ? parseReplyHandle(key) : null;
    if (key.startsWith('dfr:') && !handle) return null;
    const cached = this.ctx.state.nativeMessages.get(key);
    if (cached) return cached;
    const service = this.ctx.state.msgService;
    if (!service) throw new Error('消息服务未就绪');
    let source = this.ctx.state.replySources.get(key);
    if (!source && handle && peerHint?.peerUid) {
      source = { peer: peerHint, ...handle };
    }
    const peer = source?.peer || this.ctx.state.peerByMsgId.get(key) || peerHint;
    if (!peer?.peerUid) return null;
    const errors = [];
    let successfulQueries = 0;
    const query = async (name, args) => {
      if (typeof service[name] !== 'function') return [];
      try {
        const raw = await withTimeout(service[name](...args), 4000, name);
        if (typeof raw?.result === 'number' && raw.result !== 0) {
          throw new Error(name + ' result=' + raw.result + ' ' + String(raw.errMsg || raw.errstr || ''));
        }
        successfulQueries++;
        return messageList(raw);
      } catch (error) {
        const detail = String(error?.message || error);
        errors.push(detail);
        this.ctx.state.probe.byMsgIdError = detail;
        return [];
      }
    };
    const keep = message => {
      message = {
        ...message,
        chatType: message.chatType || peer.chatType,
        peerUid: message.peerUid || peer.peerUid,
        senderUin: message.senderUin || source?.senderUin || '',
      };
      this.cacheMessage(message);
      this.ctx.state.nativeMessages.set(key, message);
      this.ctx.state.peerByMsgId.set(String(message.msgId), peer);
      return message;
    };
    if (!key.startsWith('dfr:')) {
      const direct = await query('getMsgsByMsgId', [peer, [key]]);
      const hit = direct.find(item => String(item.msgId) === key);
      if (hit) return keep(hit);
    }
    const seq = String(source?.seq || this.ctx.state.metaByMsgId.get(key)?.msgSeq || '');
    const bySeq = items => items.find(item => String(item.msgSeq) === seq);
    if (seq && seq !== '0') {
      const hit = bySeq(await query('getMsgsBySeqList', [peer, [seq]]));
      if (hit) return keep(hit);
      const page = bySeq(await query('getMsgsBySeqAndCount', [peer, seq, 1, true, true]));
      if (page) return keep(page);
    }
    if (source?.clientSeq && source.clientSeq !== '0' && source.time && source.time !== '0') {
      const items = await query('getMsgByClientSeqAndTime', [peer, source.clientSeq, source.time]);
      const hit = items.find(item => String(item.clientSeq) === source.clientSeq) || (items.length === 1 ? items[0] : null);
      if (hit) return keep(hit);
    }
    if (source?.rootId) {
      const replies = seq && seq !== '0'
        ? await query('getSourceOfReplyMsg', [peer, source.rootId, seq])
        : !key.startsWith('dfr:') ? await query('getSourceOfReplyMsgV2', [peer, source.rootId, key]) : [];
      const hit = replies.find(item => String(item.msgId) === key || (seq !== '0' && seq && String(item.msgSeq) === seq));
      if (hit) return keep(hit);
    }
    const view = await query('getAioFirstViewLatestMsgs', [peer, 20]);
    const recent = view.find(item => String(item.msgId) === key);
    if (recent) return keep(recent);
    if (!successfulQueries && errors.length) throw new Error('引用/消息查询失败：' + errors.join('；'));
    return null;
  }

  // ---------------------------------------------------------------- 发送

  peerOf(scene, peerId) {
    return scene === 'group'
      ? { chatType: CHAT_GROUP, peerUid: String(peerId), guildId: '' }
      : { chatType: CHAT_PRIVATE, peerUid: String(peerId), guildId: '' };
  }

  /** 读会话首屏最近消息；兼容几种返回外壳。 */
  async aioMessages(peer, count = 10) {
    const service = this.ctx.state.msgService;
    if (!service || typeof service.getAioFirstViewLatestMsgs !== 'function') return null;
    let raw = null;
    try {
      raw = await withTimeout(service.getAioFirstViewLatestMsgs(peer, count), 1200, 'getAioFirstViewLatestMsgs');
    } catch (error) {
      this.ctx.state.probe.aioLatestError = String(error?.message || error);
      return null;
    }
    return Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.messages)
        ? raw.messages
        : Array.isArray(raw?.msgList)
          ? raw.msgList
          : Array.isArray(raw?.result)
            ? raw.result
            : Array.isArray(raw?.result?.messages)
              ? raw.result.messages
              : Array.isArray(raw?.result?.msgList)
                ? raw.result.msgList
                : null;
  }

  /** 发送前水位：当前会话首屏里自己发出的最大 msgSeq。 */
  async selfSeqWatermark(peer) {
    const list = await this.aioMessages(peer, 10);
    if (!list || list.length === 0) return 0;
    const selfUin = String(this.ctx.state.uin || '');
    let max = 0;
    for (const item of list) {
      const uin = String(item?.senderUin ?? '');
      if (selfUin && uin && uin !== selfUin) continue;
      const seq = Number(item?.msgSeq ?? 0);
      if (seq > max) max = seq;
    }
    return max;
  }

  /**
     * 发送回执：sendMsg 只回 { result }，没有 msgId。
     * 发之前记下自己消息的 msgSeq 水位，发之后只认"比水位新、时间合理、段类型对得上"的那条，
     * 不会把上一条消息的 id 当成本次回执。认不出来就返回 null，由调用方按失败上报。
     * 【待实机验证】getAioFirstViewLatestMsgs 的返回字段与发送后可见时延。
     */
  async confirmSentMessage(peer, watermark, wantedKinds, textHint, startedAtSeconds) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const list = await this.aioMessages(peer, 20);
      if (list && list.length > 0) {
        const candidates = list.filter((item) => {
          if (!item || !item.msgId) return false;
          const seq = Number(item.msgSeq ?? 0);
          if (watermark > 0 && seq > 0 && seq <= watermark) return false;
          const seconds = Number(item.msgTime ?? 0);
          if (seconds > 0 && startedAtSeconds > 0 && seconds < startedAtSeconds - 5) return false;
          const kinds = new Set((Array.isArray(item.elements) ? item.elements : []).map(elementKind));
          for (const kind of wantedKinds) {
            if (!kinds.has(kind)) return false;
          }
          if (textHint) {
            const text = (Array.isArray(item.elements) ? item.elements : [])
              .map((element) => String(element?.textElement?.content ?? ''))
              .join('');
            if (text && !text.includes(textHint.slice(0, 12))) return false;
          }
          return true;
        });
        if (candidates.length > 0) {
          if (candidates.length > 1) this.ctx.state.probe.sendAmbiguous = candidates.length;
          return candidates.sort((left, right) => Number(left.msgSeq ?? 0) - Number(right.msgSeq ?? 0)).pop() || null;
        }
        this.ctx.state.probe.aioLatestKeys = Object.keys(list[0] || {}).slice(0, 16);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  }

  async send({ scene, peerId, segments, nativeElements }) {
    if (!this.ctx.state.msgService) throw new Error('消息服务未就绪');
    // 安全阀：万一客户端的自动登录落到别的账号上，绝不代它发消息。
    const remembered = rememberedAccount();
    if (remembered && this.ctx.state.uin && String(this.ctx.state.uin) !== remembered) {
      throw new Error('当前登录账号 ' + this.ctx.state.uin + ' 与既定机器人 ' + remembered + ' 不符，已拒绝发送');
    }
    if (!nativeElements && segments.some(segment => segment.type === 'forward')) {
      return this.ctx.kernel.sendForward({ scene, peerId, segments });
    }
    // 【待实机验证】群聊 peerUid 用群号；私聊 peerUid 必须换成 uid。
    const peerUid = scene === 'group' ? String(peerId) : await this.ctx.kernel.resolveUid(peerId);
    const elements = nativeElements || await this.ctx.kernel.toNativeElements(segments, scene, peerId);
    const peer = { chatType: scene === 'group' ? CHAT_GROUP : CHAT_PRIVATE, peerUid, guildId: '' };
    const startedAtSeconds = Math.floor(Date.now() / 1000);
    // 认回执时要比对段类型：纯图片/语音/文件消息没有文本可以匹配。
    const wantedKinds = [...new Set(elements.map(elementKind))].filter((kind) => kind && kind !== 'reply');
    const textHint = segments
      .filter((segment) => segment?.type === 'text')
      .map((segment) => String(segment?.data?.text ?? ''))
      .join('');
    // 发送前水位：拿不到就当 0（只按时间和段类型匹配），绝不伪造 id。
    const watermark = await this.selfSeqWatermark(peer).catch(() => 0);
    // 图片要先上传到腾讯 CDN：3MB 的图实测就能超过 12 秒，别把正常发送当超时掐掉。
    this.ctx.state.timing.assertAllowed();
    const result = await withTimeout(this.ctx.state.msgService.sendMsg('0', peer, elements, new Map()), 120_000, 'sendMsg');
    if (!result || result.result !== 0) throw new Error('sendMsg 返回 ' + JSON.stringify(result));
    this.ctx.state.probe.sendResultKeys = Object.keys(result).slice(0, 12);
    const record = await this.confirmSentMessage(peer, watermark, wantedKinds, textHint, startedAtSeconds).catch(() => null);
    const messageId = String((record && record.msgId) || result.msgId || '');
    if (!messageId) {
      // 结果不明时不能伪造一个 message_id：撤回/引用都会指错，调用方还会以为成功。
      // 结果未知 ≠ 失败：消息可能已送达，框架自动重试会造成重复发送，所以给可识别前缀。
      throw new Error('SEND_RESULT_UNKNOWN: 消息已提交客户端但未确认回执 msgId，结果未知（不要自动重试）');
    }
    if (record) {
      this.cacheMessage(record);
      const meta = {
        msgId: messageId,
        msgSeq: String(record.msgSeq ?? ''),
        msgTime: String(record.msgTime ?? ''),
        senderUid: String(record.senderUid ?? ''),
        senderUidStr: String(record.senderUidStr ?? ''),
        senderUin: String(record.senderUin ?? this.ctx.state.uin ?? ''),
        peerUid: String(peer.peerUid ?? ''),
        chatType: peer.chatType,
      };
      this.ctx.state.metaByMsgId.set(messageId, meta);
      this.ctx.kernel.scheduleMetaFlush();
    }
    this.ctx.state.peerByMsgId.set(messageId, peer);
    this.ctx.state.peerByMsgId.set('last:' + scene + ':' + String(peerId), peer);
    return { messageId };
  }

  async recall(messageId) {
    if (!this.ctx.state.msgService) throw new Error('消息服务未就绪');
    // 撤回必须带原始 Peer；收消息和发消息时都会写入 peerByMsgId。
    const peer = this.ctx.state.peerByMsgId.get(String(messageId));
    if (!peer) throw new Error('该消息不属于当前会话缓存，无法撤回');
    // 【待实机验证】recallMsg 的返回与确认事件。
    const result = await this.ctx.state.msgService.recallMsg(peer, [String(messageId)]);
    if (result && result.result !== undefined && result.result !== 0) throw new Error('recallMsg 返回 ' + result.result);
    return true;
  }
}

module.exports = { MessagesDomain };
