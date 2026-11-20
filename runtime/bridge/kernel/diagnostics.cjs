'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */
const { shortOf } = require('./shared.cjs');

class DiagnosticsDomain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  diagnostics() {
    let groupService = null;
    try {
      groupService = this.ctx.state.session ? this.ctx.state.session.getGroupService() : null;
    } catch (error) {
      groupService = null;
    }
    return {
      ...this.ctx.state.probe,
      loginListenerReady: this.ctx.state.listenerReady,
      messageListenerReady: Boolean(this.ctx.state.msgService),
      // 客户端各版本方法名不完全一样：把可用方法列出来，便于按实机能力降级。
      msgServiceMethods: this.methodsOf(this.ctx.state.msgService),
      groupServiceMethods: this.methodsOf(groupService),
    };
  }

  /** 列出对象（含原型链）上的方法名，只用于诊断。 */
  methodsOf(object) {
    if (!object) return [];
    const names = new Set();
    let current = object;
    for (let depth = 0; depth < 4 && current && current !== Object.prototype; depth += 1) {
      for (const name of Object.getOwnPropertyNames(current)) {
        if (name === 'constructor') continue;
        try {
          if (typeof object[name] === 'function') names.add(name);
        } catch (error) { /* getter 抛错就跳过 */ }
      }
      current = Object.getPrototypeOf(current);
    }
    return [...names].sort();
  }

  /** 把一条原生消息的元素结构压成小摘要，供 /api/status 核对字段名。 */
  rememberNativeShape(message) {
    const shapeOf = (element) => {
      if (!element || typeof element !== 'object') return null;
      const fields = {};
      for (const [key, value] of Object.entries(element)) {
        if (typeof value === 'string') fields[key] = shortOf(value, 40);
        else if (value && typeof value === 'object') fields[key] = Object.keys(value).slice(0, 14);
        else if (value !== undefined) fields[key] = value;
      }
      return fields;
    };
    const elements = (Array.isArray(message.elements) ? message.elements : []).slice(0, 4).map((element) => ({
      elementType: element?.elementType,
      fields: shapeOf(element),
    }));
    const entry = {
      chatType: message.chatType,
      peerUid: shortOf(message.peerUid, 40),
      msgSeq: String(message.msgSeq ?? ''),
      msgTime: String(message.msgTime ?? ''),
      senderUin: String(message.senderUin ?? ''),
      senderUid: shortOf(message.senderUid, 40),
      names: {
        sendMemberName: shortOf(message.sendMemberName, 24),
        sendNickName: shortOf(message.sendNickName, 24),
        sendRemarkName: shortOf(message.sendRemarkName, 24),
      },
      elements,
      keys: Object.keys(message).slice(0, 24),
    };
    this.ctx.state.recentNative.push(entry);
    while (this.ctx.state.recentNative.length > 4) this.ctx.state.recentNative.shift();
    this.ctx.state.probe.recentNative = this.ctx.state.recentNative;
    for (const element of Array.isArray(message.elements) ? message.elements : []) {
      if (element && element.replyElement) {
        this.ctx.state.probe.lastReplyElement = shapeOf(element.replyElement);
        this.ctx.state.probe.lastReplyKeys = Object.keys(element.replyElement).slice(0, 20);
      }
      if (element && element.textElement && Number(element.textElement.atType) > 0) {
        this.ctx.state.probe.lastAtElement = shapeOf(element.textElement);
      }
    }
  }

  /** 诊断用：记下最近一次 @ 解析结果，/api/status 里能看到 uid -> QQ 号是否成功。 */
  atProbe(uid, uin) {
    this.ctx.state.probe.lastAtResolved = { uid: String(uid).slice(0, 16), uin: String(uin || ''), at: Date.now() };
    this.ctx.state.probe.uinByUidSize = this.ctx.state.uinByUid.size;
  }
}

module.exports = { DiagnosticsDomain };
