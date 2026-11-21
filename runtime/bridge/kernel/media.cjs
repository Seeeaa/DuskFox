'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CHAT_PRIVATE, withTimeout } = require('./shared.cjs');
const { downloadMedia, guessExt, localFileInfo } = require('./media-files.cjs');
const { FileAssistant, errorDetail, logDownload } = require('./file-assistant.cjs');

const MEDIA_KEYS = { record: 'pttElement', image: 'picElement', file: 'fileElement', video: 'videoElement' };

/** Validate the bytes, not the extension or a successful HTTP status. */
function videoContentError(header, element, size = header.length) {
  const mp4 = header.length >= 12 && header.toString('ascii', 4, 8) === 'ftyp';
  const webm = header.length >= 4 && header.readUInt32BE(0) === 0x1a45dfa3;
  const avi = header.length >= 12 && header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'AVI ';
  const flv = header.length >= 3 && header.toString('ascii', 0, 3) === 'FLV';
  if (!mp4 && !webm && !avi && !flv) {
    return 'VIDEO_CONTENT_INVALID: 非视频原片 header=' + header.subarray(0, 12).toString('hex') + ' actual=' + size;
  }
  const expected = Number(element.fileSize || 0);
  if (expected > 0 && size !== expected) {
    return 'VIDEO_CONTENT_INCOMPLETE: expected=' + expected + ' actual=' + size;
  }
  return '';
}

function videoPathError(file, element) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) return 'VIDEO_CONTENT_INVALID: 不是文件';
  const descriptor = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(32);
    const length = fs.readSync(descriptor, header, 0, header.length, 0);
    return videoContentError(header.subarray(0, length), element, stat.size);
  } finally {
    fs.closeSync(descriptor);
  }
}

class MediaDomain {
  constructor(ctx) {
    this.ctx = ctx;
    this.fileAssistant = new FileAssistant(ctx);
  }

  stop() { this.fileAssistant.stop(); }

  /** Select the outer element: elementId is not on pttElement/fileElement. */
  async media(msgId, kind, selector = '') {
    const msg = await this.ctx.kernel.getMessage(String(msgId));
    if (!msg || !Array.isArray(msg.elements)) throw new Error('消息不存在或不可读');
    const key = MEDIA_KEYS[kind];
    if (!key) throw new Error('未知媒体类型：' + kind);
    const outer = msg.elements.find((item, index) => item?.[key] &&
      (!selector || String(item.elementId || ('index:' + index)) === selector));
    if (!outer) throw new Error('该消息不包含指定媒体：' + kind + ' / ' + selector);
    const element = outer[key];
    if (kind === 'video') return this.video(msg, outer);
    const candidates = [element.filePath, element.sourcePath, element.originalPath,
      kind === 'file' ? this.ctx.state.mediaPaths.get('element:' + String(msg.msgId) + ':' + String(outer.elementId || ''))?.path : '']
      .map(value => String(value || '')).filter(Boolean);
    let file = candidates.find(value => fs.existsSync(value) && fs.statSync(value).isFile() &&
      (kind !== 'file' || !Number(element.fileSize) || fs.statSync(value).size === Number(element.fileSize))) || '';
    let downloadError;
    if (!file) {
      try { file = kind === 'file' ? await this.downloadFile(msg, outer) : await this.downloadRichMedia(msg, outer); }
      catch (error) { downloadError = error; }
    }
    let data;
    if (file && fs.existsSync(file)) {
      data = await fs.promises.readFile(file);
    } else {
      let url = String(element.pttUrl || element.url || element.originImageUrl || element.videoUrl || element.downloadUrl || '');
      if (kind === 'image' && url.startsWith('/')) url = 'https://gchat.qpic.cn' + url;
      if (/^https?:\/\//i.test(url)) {
        try { data = await downloadMedia(url, kind); }
        catch (error) {
          if (kind === 'file' && downloadError) {
            throw new AggregateError([downloadError, error], downloadError.message + '\n' + String(error?.message || error));
          }
          throw error;
        }
      }
      else if (downloadError) throw downloadError;
      else throw new Error('媒体尚未落盘：' + kind + ' msg=' + msgId + ' element=' + String(outer.elementId || ''));
    }
    if (!data.length) throw new Error('媒体文件为空：' + kind + ' msg=' + msgId);
    if (kind === 'file' && Number(element.fileSize) > 0 && data.length !== Number(element.fileSize)) {
      throw new Error('FILE_CONTENT_INCOMPLETE: expected=' + element.fileSize + ' actual=' + data.length);
    }
    const ext = guessExt(data);
    let name = path.basename(String(element.fileName || file || (kind + ext)));
    if (kind === 'record' && ext !== '.bin') name = path.parse(name).name + ext;
    if (!path.extname(name) && ext !== '.bin') name += ext;
    return { base64: data.toString('base64'), name, size: data.length };
  }

  async video(msg, outer) {
    const element = outer.videoElement;
    const deadline = Date.now() + 120_000;
    const errors = [];
    const finish = data => {
      const error = videoContentError(data, element);
      if (error) throw new Error(error);
      const ext = guessExt(data);
      const originalName = path.basename(String(element.fileName || 'video.mp4'));
      const name = ext === '.mp4' ? path.parse(originalName).name + '.mp4' : originalName;
      return { base64: data.toString('base64'), name, size: data.length };
    };
    for (const file of [...new Set([element.filePath, element.sourcePath, element.originalPath].filter(Boolean))]) {
      if (!fs.existsSync(file)) continue;
      try {
        const error = videoPathError(file, element);
        if (error) { errors.push(error); continue; }
        return finish(await fs.promises.readFile(file));
      } catch (error) { errors.push(String(error?.message || error)); }
    }
    // QQ can supply a playable original URL when filePath currently points at its cover.
    let url = '';
    const rich = this.ctx.state.session?.getRichMediaService?.();
    if (typeof rich?.getVideoPlayUrlV2 === 'function') {
      try {
        const peer = {
          chatType: Number(msg.chatType || msg.parentMsgPeer?.chatType || CHAT_PRIVATE),
          peerUid: String(msg.peerUid || msg.parentMsgPeer?.peerUid || ''), guildId: '',
        };
        const result = await withTimeout(rich.getVideoPlayUrlV2(
          peer, String(msg.msgId), String(outer.elementId), 0, { downSourceType: 1, triggerType: 1 },
        ), 5000, 'getVideoPlayUrlV2');
        if (typeof result?.result === 'number' && result.result !== 0) {
          throw new Error('getVideoPlayUrlV2 result=' + result.result + ' ' + String(result.errMsg || ''));
        }
        const entries = result?.urlResult?.domainUrl || [];
        url = String(entries.find(item => /^https?:\/\//i.test(String(item?.url || '')))?.url || '');
      } catch (error) { errors.push(String(error?.message || error)); }
    }
    url ||= [element.videoUrl, element.downloadUrl, element.url].find(value => /^https?:\/\//i.test(String(value || ''))) || '';
    if (url) {
      try { return finish(await downloadMedia(url, 'video', Math.max(1, deadline - Date.now()))); }
      catch (error) { errors.push(String(error?.message || error)); }
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) {
      try {
        const file = await this.downloadRichMedia(msg, outer, {
          strictElement: true,
          timeoutMs: remaining,
          validateFile: value => videoPathError(value, element),
        });
        return finish(await fs.promises.readFile(file));
      } catch (error) { errors.push(String(error?.message || error)); }
    }
    throw new Error('VIDEO_ORIGINAL_UNAVAILABLE: msg=' + msg.msgId + ' element=' + outer.elementId + '；' + errors.join('；'));
  }

  /** Retain root peer/id and native elements for nested forward and media queries. */
  async getForward(msgId) {
    const service = this.ctx.state.msgService;
    if (!service || typeof service.getMultiMsg !== 'function') throw new Error('客户端未提供 getMultiMsg');
    const key = String(msgId || '');
    const cached = this.ctx.state.forwardOwners.get(key);
    const targetId = String(cached?.nativeId || key);
    const owner = await this.ctx.kernel.getMessage(targetId);
    if (!owner) throw new Error('合并转发所属消息不存在：' + targetId);
    const peer = owner.parentMsgPeer || {
      chatType: Number(owner.chatType ?? cached?.chatType ?? CHAT_PRIVATE),
      guildId: '',
      peerUid: String(owner.peerUid || cached?.peerUid || ''),
    };
    const parents = Array.isArray(owner.parentMsgIdList) ? owner.parentMsgIdList : [];
    const rootId = String(parents[0] || targetId);
    const raw = await withTimeout(service.getMultiMsg(peer, rootId, targetId), 30_000, 'getMultiMsg');
    if (raw && raw.result !== undefined && typeof raw.result !== 'object' && Number(raw.result) !== 0) {
      throw new Error('getMultiMsg 失败：' + String(raw.errMsg || raw.errstr || raw.result));
    }
    const list = Array.isArray(raw) ? raw : raw?.msgList || raw?.messages || raw?.result?.msgList || raw?.result?.messages;
    if (!Array.isArray(list)) throw new Error('getMultiMsg 返回缺少节点数组：' + Object.keys(raw || {}).join(','));
    for (const node of list) {
      if (!node || !Array.isArray(node.elements)) continue;
      node.parentMsgPeer = peer;
      node.parentMsgIdList = [...parents, targetId];
      const id = String(node.msgId || '');
      if (!id) continue;
      this.ctx.kernel.cacheMessage(node);
      for (const element of node.elements) {
        const forward = element?.multiForwardMsgElement;
        if (forward) this.ctx.state.forwardOwners.set(String(forward.resId || id), {
          nativeId: id, chatType: peer.chatType, peerUid: peer.peerUid, at: Date.now(),
        });
      }
    }
    while (this.ctx.state.nativeMessages.size > 2000) {
      this.ctx.state.nativeMessages.delete(this.ctx.state.nativeMessages.keys().next().value);
    }
    return list;
  }

  transferKeys(info) {
    const common = info.commonFileInfo || {};
    const msgId = String(info.msgId || common.msgId || '');
    const elementId = String(info.msgElementId || info.elementId || common.elemId || '');
    const keys = [];
    if (msgId && elementId) keys.push('element:' + msgId + ':' + elementId);
    for (const value of [info.fileModelId, common.fileModelId]) {
      if (value && String(value) !== '0') keys.push('model:' + String(value));
    }
    for (const value of [info.fileId, info.uuid, common.uuid]) {
      if (value && String(value) !== '0') keys.push('uuid:' + String(value));
    }
    return [...new Set(keys)];
  }

  onRichMediaDownloadComplete(info) {
    if (Array.isArray(info)) {
      for (const item of info) this.onRichMediaDownloadComplete(item);
      return;
    }
    if (!info) return;
    const keys = this.transferKeys(info);
    const allWaiters = new Set(keys.flatMap(key => [...(this.ctx.state.mediaWaiters.get(key) || [])]));
    const waiters = new Set([...allWaiters].filter(waiter => !waiter.originalOnly || !Number(info.thumbSize)));
    if (allWaiters.size && !waiters.size) return;
    const filePath = String(info.filePath || info.path || '');
    const code = [info.fileErrCode, info.fileSrvErrCode, info.errCode, info.result]
      .map(Number).find(value => Number.isFinite(value) && value !== 0) || 0;
    if (code) {
      const error = new Error('RichMedia 下载失败 code=' + code + '：' +
        String(info.fileErrMsg || info.clientMsg || info.errMsg || info.errStr || ''));
      this.ctx.state.probe.mediaDownloadError = error.message;
      for (const waiter of waiters) waiter.reject(error);
      return;
    }
    if (!filePath || !fs.existsSync(filePath)) return;
    let accepted = !waiters.size;
    for (const waiter of waiters) {
      try {
        const reason = waiter.validateFile?.(filePath);
        if (reason) { waiter.lastInvalid = reason; continue; }
        accepted = true;
        waiter.resolve(filePath);
      } catch (error) {
        waiter.lastInvalid = String(error?.message || error);
      }
    }
    if (accepted) {
      const entry = { path: filePath, at: Date.now() };
      for (const key of keys) this.ctx.state.mediaPaths.set(key, entry);
    }
    while (this.ctx.state.mediaPaths.size > 2000) {
      this.ctx.state.mediaPaths.delete(this.ctx.state.mediaPaths.keys().next().value);
    }
  }

  /** Match file callbacks by UUID/model as well as message/element; files need not report both. */
  async waitForTransfer(identity, invoke) {
    const keys = this.transferKeys(identity).filter(key => !identity.strictElement || key.startsWith('element:'));
    if (!keys.length) throw new Error('媒体下载缺少定位字段');
    for (const key of keys) {
      const cached = this.ctx.state.mediaPaths.get(key);
      if (cached && fs.existsSync(cached.path)) {
        if (!identity.validateFile || !identity.validateFile(cached.path)) return cached.path;
        this.ctx.state.mediaPaths.delete(key);
      }
    }
    let timer;
    let waiter;
    const wait = new Promise((resolve, reject) => {
      waiter = { resolve, reject, validateFile: identity.validateFile, originalOnly: identity.strictElement };
      for (const key of keys) {
        const set = this.ctx.state.mediaWaiters.get(key) || new Set();
        set.add(waiter);
        this.ctx.state.mediaWaiters.set(key, set);
      }
      timer = setTimeout(() => reject(new Error('MEDIA_DOWNLOAD_TIMEOUT: ' +
        String(identity.operation || 'downloadRichMedia') + ' msg=' + identity.msgId +
        ' element=' + identity.elementId + ' uuid=' + String(identity.uuid || '') +
        ' model=' + String(identity.fileModelId || '') +
        (waiter.lastInvalid ? ' rejected=' + waiter.lastInvalid : ''))), identity.timeoutMs || 60_000);
      timer.unref?.();
    });
    Promise.resolve().then(invoke).then(result => {
      if (result?.filePath) this.onRichMediaDownloadComplete({ ...identity, ...result });
      else if (typeof result?.result === 'number' && result.result !== 0) {
        waiter.reject(new Error(String(identity.operation) + ' result=' + result.result + ' ' + String(result.errMsg || '')));
      }
    }, error => waiter.reject(error));
    try { return await wait; }
    finally {
      clearTimeout(timer);
      for (const key of keys) {
        const set = this.ctx.state.mediaWaiters.get(key);
        set?.delete(waiter);
        if (!set?.size) this.ctx.state.mediaWaiters.delete(key);
      }
    }
  }

  /** Preserve the existing /api/media result; channel diagnostics are exposed separately. */
  async downloadFile(msg, outer) {
    return (await this.fileDownloadResult(msg, outer)).path;
  }

  async fileDownloadResult(msg, outer) {
    const element = outer.fileElement;
    const identity = { fileUuid: String(element.fileUuid || ''), fileId: String(element.fileId || element.id || '') };
    const errors = [];
    let started = Date.now();
    logDownload({ channel: 'downloadRichMedia', operation: 'downloadRichMedia', phase: 'start', ...identity,
      messageId: String(msg.msgId), elementId: String(outer.elementId || ''), elapsedMs: 0 });
    try {
      const file = await this.downloadRichMedia(msg, outer, {
        strictElement: true, timeoutMs: 120_000,
        validateFile: value => {
          try { localFileInfo(value, element.fileSize); return ''; }
          catch (error) { return String(error.message || error); }
        },
      });
      const info = localFileInfo(file, element.fileSize);
      logDownload({ channel: 'downloadRichMedia', operation: 'downloadRichMedia', ok: true, ...identity,
        elapsedMs: Date.now() - started, ...info });
      return { ok: true, ...info, channel: 'downloadRichMedia', errors };
    } catch (error) {
      const detail = errorDetail('downloadRichMedia', 'downloadRichMedia', error, started, identity);
      errors.push(detail);
      logDownload(detail);
    }
    started = Date.now();
    try {
      const result = await this.fileAssistant.download({
        ...identity, messageId: String(msg.msgId), fileName: String(element.fileName || ''),
        fileSize: element.fileSize, peerUid: String(msg.peerUid || msg.parentMsgPeer?.peerUid || ''), timeoutMs: 120_000,
      });
      this.ctx.state.mediaPaths.set('element:' + String(msg.msgId) + ':' + String(outer.elementId || ''), {
        path: result.path, at: Date.now(), channel: 'FileAssistant',
      });
      while (this.ctx.state.mediaPaths.size > 2000) this.ctx.state.mediaPaths.delete(this.ctx.state.mediaPaths.keys().next().value);
      return { ok: true, path: result.path, size: result.size, channel: 'FileAssistant', errors: [...errors, ...result.errors] };
    } catch (error) {
      const details = error.downloadErrors?.length ? error.downloadErrors
        : [errorDetail('FileAssistant', 'downloadFile', error, started, identity)];
      errors.push(...details);
      if (!error.downloadErrors?.length) logDownload(details[0]);
      const failure = new AggregateError(errors.map(item => new Error(item.error)),
        'FILE_DOWNLOAD_FAILED: ' + errors.map(item => item.channel + ': ' + item.error).join('\n'));
      failure.probeResult = { ok: false, path: '', size: 0, channel: 'FileAssistant', errors };
      throw failure;
    }
  }

  /** GET probe performs the same lazy retrieval but only stats the downloaded payload. */
  async probe(messageId, kind = 'file', selector = '') {
    const started = Date.now();
    try {
      if (kind !== 'file') throw new Error('媒体探针仅支持 kind=file');
      const msg = await this.ctx.kernel.getMessage(String(messageId));
      if (!msg || !Array.isArray(msg.elements)) throw new Error('消息不存在或不可读');
      const outer = msg.elements.find((item, index) => item?.fileElement &&
        (!selector || String(item.elementId || ('index:' + index)) === selector));
      if (!outer) throw new Error('该消息不包含指定文件');
      const element = outer.fileElement;
      const cached = this.ctx.state.mediaPaths.get('element:' + String(msg.msgId) + ':' + String(outer.elementId || ''));
      const errors = [];
      for (const file of [...new Set([element.filePath, element.sourcePath, element.originalPath, cached?.path].filter(Boolean))]) {
        if (!fs.existsSync(file)) continue;
        try {
          const info = localFileInfo(String(file), element.fileSize);
          const channel = file === cached?.path && cached.channel ? cached.channel : 'local';
          logDownload({ channel, operation: 'probe', ok: true, ...info,
            fileUuid: String(element.fileUuid || ''), fileId: String(element.fileId || ''), elapsedMs: Date.now() - started });
          return { ok: true, ...info, channel, errors };
        } catch (error) {
          const detail = errorDetail('local', 'stat', error, started, {
            fileUuid: element.fileUuid, fileId: element.fileId,
          });
          errors.push(detail);
          logDownload(detail);
        }
      }
      try {
        const result = await this.fileDownloadResult(msg, outer);
        return { ...result, errors: [...errors, ...result.errors] };
      } catch (error) {
        if (error.probeResult) return { ...error.probeResult, errors: [...errors, ...error.probeResult.errors] };
        throw error;
      }
    } catch (error) {
      const detail = errorDetail('probe', 'resolve', error, started);
      logDownload(detail);
      return { ok: false, path: '', size: 0, channel: 'probe', errors: [detail] };
    }
  }

  async downloadRichMedia(msg, outer, options = {}) {
    const service = this.ctx.state.msgService;
    if (!service || typeof service.downloadRichMedia !== 'function') throw new Error('客户端未提供 downloadRichMedia');
    const elementId = String(outer.elementId || '');
    const msgId = String(msg.msgId || '');
    if (!elementId || !msgId) throw new Error('下载媒体缺少 msgId/elementId');
    const params = {
      fileModelId: '0',
      downSourceType: 0, downloadSourceType: 0, triggerType: 1,
      msgId,
      chatType: Number(msg.chatType || msg.parentMsgPeer?.chatType || CHAT_PRIVATE),
      peerUid: String(msg.peerUid || msg.parentMsgPeer?.peerUid || ''),
      elementId, thumbSize: 0, downloadType: 1, filePath: '',
    };
    return this.waitForTransfer({ ...params, ...options, operation: 'downloadRichMedia' },
      () => service.downloadRichMedia(params));
  }
}

module.exports = { MediaDomain };
