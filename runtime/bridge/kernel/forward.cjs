'use strict';
const { CHAT_PRIVATE, CHAT_GROUP, withTimeout, elementKind } = require('./shared.cjs');

/** Reuse QQ's native merge builder and native RichMedia upload; no receive-side media fetch. */
class ForwardDomain {
  constructor(ctx) { this.ctx = ctx; }

  async send({ scene, peerId, segments }) {
    const service = this.ctx.state.msgService;
    if (!service) throw new Error('消息服务未就绪');
    if (segments.length !== 1 || segments[0].type !== 'forward') throw new Error('合并转发必须独立发送');
    const data = segments[0].data || {};
    let nodes = data.content || data.messages;
    if (!nodes && data.id) {
      const id = String(data.id);
      nodes = [{ type: 'node', data: { id: this.ctx.state.forwardOwners.get(id)?.nativeId || id } }];
    }
    if (!Array.isArray(nodes) || !nodes.length) throw new Error('合并转发节点不能为空');
    const resolved = [];
    for (const node of nodes) {
      const value = node?.type === 'node' ? node.data : node;
      if (!value || typeof value !== 'object') throw new Error('node 必须是对象');
      if (value.id || value.message_id) {
        const id = String(value.id || value.message_id);
        let peer = value.source_peer;
        if (peer && peer.chatType === 1 && /^\d+$/.test(String(peer.peerUid))) {
          peer = { ...peer, peerUid: await this.ctx.kernel.resolveUid(peer.peerUid) };
        }
        const raw = await this.ctx.kernel.getMessage(id, peer);
        if (!raw) throw new Error('转发源消息不存在：' + id);
        resolved.push({ raw, data: value, peer: raw.parentMsgPeer || {
          chatType: Number(raw.chatType), peerUid: String(raw.peerUid), guildId: '',
        } });
      } else {
        const content = value.content || value.message;
        if (!Array.isArray(content) || !content.length) throw new Error('自定义 node.content 必须是非空消息段数组');
        if (content.some(segment => !['text', 'image'].includes(segment.type))) throw new Error('自定义转发节点支持 text/image');
        // Native staging produces authentic messages from the current account.
        const author = value.user_id ?? value.uin;
        if (author && String(author) !== String(this.ctx.state.uin)) {
          throw new Error('NATIVE_FORWARD_AUTHOR: 自定义节点 user_id 仅支持当前 QQ，当前值=' + this.ctx.state.uin);
        }
        resolved.push({ data: value, content });
      }
    }
    const samePeer = resolved.every(item => item.raw && item.peer.chatType === resolved[0].peer.chatType &&
      item.peer.peerUid === resolved[0].peer.peerUid);
    let sourcePeer;
    let ids;
    if (samePeer) {
      sourcePeer = resolved[0].peer;
      ids = resolved.map(item => String(item.raw.msgId));
    } else {
      const selfUin = String(this.ctx.state.uin);
      const selfUid = await this.ctx.kernel.resolveUid(selfUin);
      sourcePeer = { chatType: CHAT_PRIVATE, peerUid: selfUid, guildId: '' };
      const selfKey = this.ctx.kernel.outboundKey('private', selfUin);
      const destinationKey = this.ctx.kernel.outboundKey(scene, peerId);
      const stage = async item => {
        if (!item.raw) {
          this.ctx.kernel.ensureStagingCapacity(selfUin, selfUid);
          const sent = await this.ctx.kernel.sendNative({ scene: 'private', peerId: selfUin, segments: item.content });
          this.ctx.kernel.recordStaging(sent.messageId, selfUin, selfUid, 'custom');
          return sent.messageId;
        }
        if (item.peer.chatType === CHAT_PRIVATE && item.peer.peerUid === selfUid) return String(item.raw.msgId);
        this.ctx.kernel.ensureStagingCapacity(selfUin, selfUid);
        const watermark = await this.ctx.kernel.selfSeqWatermark(sourcePeer).catch(() => 0);
        const started = Math.floor(Date.now() / 1000);
        this.ctx.state.timing.assertAllowed();
        const result = await withTimeout(service.forwardMsg([String(item.raw.msgId)], item.peer, [sourcePeer], new Map()), 120000, 'forwardMsg');
        if (result?.result !== undefined && result.result !== 0) throw new Error('forwardMsg 返回 ' + JSON.stringify(result));
        const kinds = [...new Set(item.raw.elements.map(elementKind).filter(Boolean))];
        const record = await this.ctx.kernel.confirmSentMessage(sourcePeer, watermark, kinds, '', started);
        const id = String(record?.msgId || result?.msgId || '');
        if (!id) throw new Error('SEND_RESULT_UNKNOWN: 自聊转发暂存未取得消息回执');
        if (record) this.ctx.kernel.cacheMessage(record);
        this.ctx.kernel.recordStaging(id, selfUin, selfUid, 'forward');
        return id;
      };
      const stageBatch = async () => {
        const staged = [];
        for (const item of resolved) staged.push(await stage(item));
        return staged;
      };
      // Hold the self-chat queue for the whole batch. The target queue is already held by send().
      ids = await (selfKey === destinationKey ? stageBatch() : this.ctx.state.timing.run(selfKey, stageBatch));
    }
    const customNames = resolved.some(item => !item.raw || item.data.nickname || item.data.name);
    if (typeof service.buildMultiForwardMsg === 'function' && (!customNames || typeof service.multiForwardMsgWithComment !== 'function')) {
      const result = await withTimeout(service.buildMultiForwardMsg({ srcMsgIds: ids, srcContact: sourcePeer }), 120000, 'buildMultiForwardMsg');
      if (result?.result !== undefined && result.result !== 0) throw new Error('buildMultiForwardMsg 返回 ' + JSON.stringify(result));
      const elements = result?.rspInfo?.elements;
      if (!Array.isArray(elements) || !elements.length) throw new Error('buildMultiForwardMsg 未返回 rspInfo.elements');
      return this.ctx.kernel.sendNative({ scene, peerId, segments: [], nativeElements: elements });
    }
    // Older clients can send the merged record directly, with a per-node display name.
    const peerUid = scene === 'group' ? String(peerId) : await this.ctx.kernel.resolveUid(peerId);
    const destination = { chatType: scene === 'group' ? CHAT_GROUP : CHAT_PRIVATE, peerUid, guildId: '' };
    const watermark = await this.ctx.kernel.selfSeqWatermark(destination).catch(() => 0);
    const started = Math.floor(Date.now() / 1000);
    this.ctx.state.timing.assertAllowed();
    let result;
    if (typeof service.multiForwardMsgWithComment === 'function') {
      const info = ids.map((id, index) => ({
        msgId: id, senderShowName: String(resolved[index].data.nickname || resolved[index].data.name ||
          resolved[index].raw?.sendNickName || this.ctx.state.nick || ''),
      }));
      result = await withTimeout(Promise.resolve(service.multiForwardMsgWithComment(info, sourcePeer, destination, [], new Map())), 120000, 'multiForwardMsgWithComment');
    } else if (typeof service.multiForwardMsg === 'function') {
      result = await withTimeout(Promise.resolve(service.multiForwardMsg(destination, sourcePeer, ids)), 120000, 'multiForwardMsg');
    } else throw new Error('客户端缺少 buildMultiForwardMsg/multiForwardMsg 原生接口');
    if (result?.result !== undefined && result.result !== 0) throw new Error('multiForwardMsg 返回 ' + JSON.stringify(result));
    const record = await this.ctx.kernel.confirmSentMessage(destination, watermark, ['forward'], '', started);
    const id = String(record?.msgId || result?.msgId || '');
    if (!id) throw new Error('SEND_RESULT_UNKNOWN: 合并转发已提交但未取得回执');
    this.ctx.state.peerByMsgId.set(id, destination);
    if (record) this.ctx.kernel.cacheMessage(record);
    return { messageId: id };
  }
}

module.exports = { ForwardDomain };
