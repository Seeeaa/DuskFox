'use strict';
const { randomInt } = require('node:crypto');
const { localFileInfo } = require('./media-files.cjs');

function errorDetail(channel, operation, error, started, identity = {}) {
  return {
    channel, operation, fileUuid: String(identity.fileUuid || ''), fileId: String(identity.fileId || ''),
    elapsedMs: Date.now() - started,
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : '',
  };
}

function logDownload(event) {
  const line = '[bridge] file-download ' + JSON.stringify(event);
  if (event.error) console.error(line); else console.log(line);
}

function checkResult(operation, result) {
  if ((typeof result === 'number' && result !== 0) ||
      (typeof result?.result === 'number' && result.result !== 0)) {
    throw new Error(operation + ': ' + JSON.stringify(result));
  }
}

class FileAssistant {
  constructor(ctx) {
    this.ctx = ctx;
    this.binding = null;
    this.epoch = 0;
    this.statusWaiters = new Set();
    this.searchWaiters = new Set();
    this.cancellations = new Set();
    this.pending = new Map();
  }

  bind() {
    const session = this.ctx.state.session;
    const service = session?.getFileAssistantService?.();
    if (!service?.downloadFile || !service?.addKernelFileAssistantListener) {
      throw new Error('客户端未提供 FileAssistant.downloadFile/addKernelFileAssistantListener');
    }
    if (this.binding?.session === session && this.binding.service === service) return this.binding;
    this.stop(new Error('FILE_ASSISTANT_SESSION_CHANGED'));
    const binding = { session, service, id: undefined, listener: null };
    const active = () => this.binding === binding && this.ctx.state.session === session;
    binding.listener = new Proxy({
      onFileStatusChanged: info => {
        if (!active()) return;
        for (const item of Array.isArray(info) ? info : [info]) {
          for (const waiter of [...this.statusWaiters]) waiter(item);
        }
      },
      onFileSearch: info => {
        if (active()) for (const waiter of [...this.searchWaiters]) waiter(info);
      },
    }, {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key === 'string' && key.startsWith('on')) return () => {};
      },
    });
    this.binding = binding;
    try { binding.id = service.addKernelFileAssistantListener(binding.listener); }
    catch (error) { this.binding = null; throw error; }
    this.epoch++;
    return binding;
  }

  stop(error = new Error('FILE_ASSISTANT_STOPPED')) {
    for (const cancel of [...this.cancellations]) cancel(error);
    this.statusWaiters.clear();
    this.searchWaiters.clear();
    const old = this.binding;
    this.binding = null;
    if (!old || typeof old.service.removeKernelFileAssistantListener !== 'function') return;
    try {
      const result = old.service.removeKernelFileAssistantListener([old.id ?? old.listener]);
      Promise.resolve(result).catch(reason => logDownload({
        channel: 'FileAssistant', operation: 'removeListener', error: String(reason?.stack || reason),
      }));
    } catch (reason) {
      logDownload({ channel: 'FileAssistant', operation: 'removeListener', error: String(reason?.stack || reason) });
    }
  }

  /** Subscribe before invoking native code; synchronous callbacks are valid. */
  async request(binding, waiters, handler, invoke, timeoutMs, label, validateResult = true) {
    let timer, callback, cancel;
    const completion = new Promise((resolve, reject) => {
      callback = info => {
        try { handler(info, resolve, reject); } catch (error) { reject(error); }
      };
      cancel = reject;
      waiters.add(callback);
      this.cancellations.add(cancel);
      timer = setTimeout(() => reject(new Error(label())), Math.max(1, timeoutMs));
      timer.unref?.();
    });
    try {
      const [, value] = await Promise.all([
        Promise.resolve().then(() => {
          if (this.binding !== binding || this.ctx.state.session !== binding.session) throw new Error('FILE_ASSISTANT_SESSION_CHANGED');
          return invoke();
        }).then(result => {
          if (validateResult || (result && typeof result === 'object')) checkResult('FileAssistant native call', result);
          return result;
        }),
        completion,
      ]);
      return value;
    } finally {
      clearTimeout(timer);
      waiters.delete(callback);
      this.cancellations.delete(cancel);
    }
  }

  async search(binding, options, timeoutMs) {
    if (typeof binding.service.searchFile !== 'function') throw new Error('客户端未提供 FileAssistant.searchFile');
    const resultId = randomInt(100000, 2147483647);
    const started = Date.now();
    const query = String(options.fileName || options.fileId || options.fileUuid);
    let searchId;
    let searchIdReady = false;
    const deferred = [];
    const handleSearch = (info, resolve, reject) => {
      if (Number(info?.resultId) !== resultId) return;
      if (Object.hasOwn(info, 'searchId')) {
        if (!searchIdReady) { deferred.push({ info, resolve, reject }); return; }
        if (searchId === undefined || searchId === null || String(info.searchId) !== String(searchId)) return;
      }
      const code = [info.result, info.errCode, info.errorCode].map(Number).find(value => Number.isFinite(value) && value !== 0);
      if (code) { reject(new Error('FileAssistant.onFileSearch: ' + JSON.stringify(info))); return; }
      const ids = [options.fileId, options.fileUuid].filter(Boolean).map(String);
      const hasSize = options.fileSize !== undefined && options.fileSize !== null && String(options.fileSize).trim() !== '';
      const declaredSize = hasSize ? Number(options.fileSize) : NaN;
      const matches = (info.resultItems || []).filter(item => {
        if (hasSize && (!Number.isSafeInteger(declaredSize) || declaredSize < 0 ||
          item.fileSize === undefined || item.fileSize === null || String(item.fileSize).trim() === '' ||
          Number(item.fileSize) !== declaredSize)) return false;
        const exact = [item.id, item.fileId, item.fileUuid, item.uuid].some(value => value && ids.includes(String(value)));
        const message = options.messageId && String(item.msgId) === String(options.messageId) &&
          (!options.peerUid || String(item.peerUid) === String(options.peerUid)) &&
          (!options.fileName || String(item.fileName) === String(options.fileName));
        return item.id !== undefined && item.id !== null && String(item.id) !== '' && (exact || message);
      });
      const fullMatch = item => Boolean(options.messageId && options.peerUid && options.fileName) &&
        Number.isSafeInteger(declaredSize) && declaredSize >= 0 &&
        String(item.msgId) === String(options.messageId) && String(item.peerUid) === String(options.peerUid) &&
        String(item.fileName) === String(options.fileName) && Number(item.fileSize) === declaredSize;
      const downloaded = item => Number(item.fileStatus) === 2 && Boolean(String(item.filePath || '').trim());
      const sameName = item => Boolean(options.fileName) && String(item.fileName) === String(options.fileName);
      const recordTime = item => {
        const value = Number(item.fileTime ?? item.msgTime ?? item.time ?? 0);
        return Number.isFinite(value) ? (value >= 1e12 ? value / 1000 : value) : 0;
      };
      const seen = new Set();
      const candidates = matches.sort((left, right) =>
        Number(fullMatch(right)) - Number(fullMatch(left)) ||
        Number(downloaded(right)) - Number(downloaded(left)) ||
        recordTime(right) - recordTime(left) || Number(sameName(right)) - Number(sameName(left)),
      ).filter(item => {
        const id = String(item.id);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const item = candidates[0];
      const fields = value => ({
        id: String(value.id), msgId: String(value.msgId ?? ''), fileName: String(value.fileName ?? ''),
        fileSize: value.fileSize ?? '', fileStatus: value.fileStatus ?? null,
        fileTime: value.fileTime ?? value.msgTime ?? value.time ?? null,
      });
      logDownload({
        channel: 'FileAssistant', operation: 'selectCandidate', ok: Boolean(item),
        fileUuid: String(options.fileUuid || ''), fileId: item ? String(item.id) : '',
        selected: item ? fields(item) : null, candidateCount: candidates.length,
        searchResultCount: (info.resultItems || []).length,
        candidates: candidates.slice(0, 10).map(fields), elapsedMs: Date.now() - started,
      });
      if (!item) {
        reject(new Error('FILE_ASSISTANT_NO_MATCH: 没有匹配的消息文件 resultId=' + resultId +
          ' message_id=' + String(options.messageId || '')));
        return;
      }
      resolve({ fileId: String(item.id), filePath: String(item.filePath || ''), fileStatus: item.fileStatus });
    };
    return this.request(binding, this.searchWaiters, handleSearch, async () => {
      const result = await binding.service.searchFile([query], { resultType: 2, pageLimit: 100 }, resultId);
      searchId = result && typeof result === 'object' ? result.searchId : result;
      searchIdReady = true;
      for (const item of deferred.splice(0)) handleSearch(item.info, item.resolve, item.reject);
      return result;
    }, timeoutMs, () => 'FILE_ASSISTANT_SEARCH_TIMEOUT: searchId=' + String(searchId ?? '') +
      ' resultId=' + resultId + ' query=' + query, false);
  }

  async download(options) {
    const identity = { fileUuid: String(options.fileUuid || ''), fileId: String(options.fileId || '') };
    if (!identity.fileUuid && !identity.fileId) throw new Error('FileAssistant 下载缺少 fileUuid/fileId');
    const binding = this.bind();
    const key = JSON.stringify([this.epoch, options.messageId || '', identity.fileId, identity.fileUuid]);
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this.perform(binding, { ...options, ...identity });
    this.pending.set(key, job);
    try { return await job; }
    finally { if (this.pending.get(key) === job) this.pending.delete(key); }
  }

  async perform(binding, options) {
    const deadline = Date.now() + (options.timeoutMs || 120000);
    const errors = [];
    let resolvedId = '';
    if ((options.fileUuid || (options.messageId && options.fileName)) && typeof binding.service.searchFile === 'function') {
      const started = Date.now();
      try {
        const match = await this.search(binding, options, Math.min(5000, deadline - Date.now()));
        resolvedId = match.fileId;
        logDownload({ channel: 'FileAssistant', operation: 'searchFile', ok: true,
          fileUuid: options.fileUuid, fileId: options.fileId, resolvedFileId: resolvedId, elapsedMs: Date.now() - started });
        if (Number(match.fileStatus) === 2 && match.filePath) {
          const info = localFileInfo(match.filePath, options.fileSize);
          logDownload({ channel: 'FileAssistant', operation: 'cachedPath', ok: true,
            fileUuid: options.fileUuid, fileId: resolvedId, elapsedMs: Date.now() - started, ...info });
          return { ...info, channel: 'FileAssistant', errors };
        }
      } catch (error) {
        const detail = errorDetail('FileAssistant', 'searchFile', error, started, options);
        errors.push(detail);
        logDownload(detail);
      }
    }
    const candidates = [...new Set([resolvedId, options.fileId].filter(Boolean))];
    if (!candidates.length && !errors.length) {
      const error = new Error('FILE_ASSISTANT_NO_MATCH: 未解析到 FileAssistant 记录 ID fileUuid=' + options.fileUuid);
      const detail = errorDetail('FileAssistant', 'searchFile', error, Date.now(), options);
      errors.push(detail);
      logDownload(detail);
    }
    for (const fileId of candidates) {
      if (Date.now() >= deadline) break;
      const started = Date.now();
      let lastStatus = null;
      let sawCallback = false;
      let sawNoId = false;
      let lastNoIdStatus = null;
      let noIdReason = '';
      logDownload({ channel: 'FileAssistant', operation: 'downloadFile', phase: 'start',
        fileUuid: options.fileUuid, fileId, elapsedMs: 0 });
      try {
        const info = await this.request(binding, this.statusWaiters, (status, resolve, reject) => {
          lastStatus = status;
          sawCallback = true;
          const identifiers = ['id', 'fileId', 'fileUuid']
            .filter(key => status?.[key] !== undefined && status[key] !== null && String(status[key]) !== '');
          if (identifiers.length) {
            if (identifiers.some(key => String(status[key]) !==
                String(key === 'fileUuid' ? options.fileUuid || fileId : fileId))) return;
          } else {
            sawNoId = true;
            lastNoIdStatus = status;
          }
          const code = [status?.errCode, status?.errorCode, status?.fileErrCode, status?.result]
            .map(Number).find(value => Number.isFinite(value) && value !== 0);
          if (code) { reject(new Error('FileAssistant.onFileStatusChanged: ' + JSON.stringify(status))); return; }
          if (!identifiers.length) {
            if (Number(status?.fileStatus) !== 2 || String(status?.fileProgress) !== '0') {
              noIdReason = 'fileStatus/fileProgress 未完成';
              return;
            }
            const declared = options.fileSize;
            const expected = typeof declared === 'number' || (typeof declared === 'string' && declared.trim() !== '')
              ? Number(declared) : NaN;
            if (!Number.isSafeInteger(expected) || expected < 0) {
              noIdReason = '缺少有效声明大小';
              return;
            }
            try {
              const file = localFileInfo(String(status?.filePath || ''), expected);
              if (file.size !== expected) {
                noIdReason = '声明大小不匹配 expected=' + expected + ' actual=' + file.size;
                return;
              }
              resolve(file);
            } catch (error) {
              noIdReason = String(error?.message || error);
            }
            return;
          }
          if (Number(status.fileStatus) !== 2 || String(status.fileProgress) !== '0') return;
          resolve(localFileInfo(String(status.filePath || ''), options.fileSize));
        }, () => binding.service.downloadFile([fileId]), deadline - Date.now(),
        () => (sawNoId ? 'FILE_ASSISTANT_CALLBACK_NO_ID' : 'FILE_ASSISTANT_DOWNLOAD_TIMEOUT') +
          ': fileUuid=' + options.fileUuid + ' fileId=' + fileId +
          ' callbackState=' + (sawNoId ? 'callback_without_id' : sawCallback ? 'no_matching_completion' : 'no_callback') +
          ' reason=' + noIdReason + ' lastStatus=' + JSON.stringify(lastStatus) +
          (sawNoId ? ' lastNoIdStatus=' + JSON.stringify(lastNoIdStatus) : ''));
        logDownload({ channel: 'FileAssistant', operation: 'downloadFile', ok: true,
          fileUuid: options.fileUuid, fileId, elapsedMs: Date.now() - started, path: info.path, size: info.size });
        return { ...info, channel: 'FileAssistant', errors };
      } catch (error) {
        const detail = errorDetail('FileAssistant', 'downloadFile', error, started, { ...options, fileId });
        errors.push(detail);
        logDownload(detail);
      }
    }
    const code = candidates.length ? 'FILE_ASSISTANT_DOWNLOAD_FAILED' : 'FILE_ASSISTANT_NO_MATCH';
    const context = code + ': candidateIds=' + JSON.stringify(candidates);
    const error = new AggregateError(errors.map(item => new Error(item.error)),
      context + ' ' + (errors.map(item => item.error).join('\n') || 'FileAssistant 未取得本地文件'));
    error.code = code;
    error.candidateIds = candidates;
    error.downloadErrors = errors.map(item => ({
      ...item, candidateIds: candidates, originalError: item.error,
      error: item.error.startsWith(code) ? item.error : context + ' ' + item.error,
    }));
    if (!error.downloadErrors.length) error.downloadErrors.push(errorDetail('FileAssistant', 'downloadFile', error, Date.now(), options));
    logDownload({ channel: 'FileAssistant', operation: 'downloadResult', fileUuid: options.fileUuid,
      fileId: resolvedId || options.fileId || '', candidateIds: candidates, error: error.message });
    throw error;
  }
}

module.exports = { FileAssistant, errorDetail, logDownload };
