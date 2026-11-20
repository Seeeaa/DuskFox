'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CHAT_PRIVATE, withTimeout, messageList } = require('./shared.cjs');

const PRODUCER = 'duskfox-forward-staging/v1';
const DAY_MS = 86400000;
const LEDGER_LIMIT = 5000;
const WRITE_DELAY_MS = 500;

/** Ownership is recorded at the successful self-chat send, never inferred from a user message's text. */
class StagingCleanup {
  constructor(ctx) {
    this.ctx = ctx;
    this.ledgers = new Map();
    this.timer = null;
    this.started = false;
    this.pending = null;
    this.scheduleTag = '';
    this.lastLoggedError = '';
    this.lastLogAt = 0;
    this.exitHandler = () => {
      try { this.flushAll(); }
      catch (error) { this.reportError(error); }
    };
    this.info = {
      nextRunAt: null, lastRunAt: null, lastFinishedAt: null,
      removed: 0, missing: 0, failed: 0, failures: [], lastError: '', skippedReason: '',
      skipped: 0, skippedInvalidTime: 0, skippedNotExpired: 0, lastSkip: null,
    };
  }

  config() { return this.ctx.state.timing.resolve().config; }

  ledger(uin, selfUid) {
    const cached = this.ledgers.get(uin);
    if (cached) {
      if (cached.selfUid !== selfUid) throw new Error('暂存来源记录的 selfUid 与当前账号不一致');
      return cached;
    }
    const file = path.join(process.env.QQ_BRIDGE_DATA_DIR || os.homedir(), 'forward-staging', uin + '.json');
    let entries = [];
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (stored.producer !== PRODUCER || stored.uin !== uin || stored.selfUid !== selfUid || !Array.isArray(stored.entries)) {
        throw new Error('暂存来源记录格式或账号不匹配：' + file);
      }
      entries = stored.entries;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const ledger = { file, uin, selfUid, entries: new Map(), dirty: false, writeTimer: null, writeError: '' };
    for (const entry of entries) {
      if (!entry || !/^[1-9]\d*$/.test(String(entry.msgId)) || !Number.isFinite(entry.createdAt) || entry.createdAt <= 0 ||
          !['custom', 'forward'].includes(entry.source) ||
          (entry.cleanedAt !== undefined && (!Number.isFinite(entry.cleanedAt) || entry.cleanedAt <= 0))) {
        throw new Error('暂存来源记录含无效消息条目：' + file);
      }
      ledger.entries.set(String(entry.msgId), { ...entry, msgId: String(entry.msgId) });
    }
    this.ledgers.set(uin, ledger);
    this.pruneCleaned(ledger);
    return ledger;
  }

  save(ledger) {
    fs.mkdirSync(path.dirname(ledger.file), { recursive: true });
    const temp = ledger.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({
      producer: PRODUCER, uin: ledger.uin, selfUid: ledger.selfUid,
      entries: [...ledger.entries.values()],
    }), { mode: 0o600 });
    fs.renameSync(temp, ledger.file);
    ledger.dirty = false;
    ledger.writeError = '';
  }

  reportError(error, batch = false) {
    this.info.lastError = String(error.stack || error);
    const now = Date.now();
    if (!this.lastLogAt || now - this.lastLogAt >= 3600000) {
      this.lastLoggedError = this.info.lastError;
      this.lastLogAt = now;
      console.error('[bridge] staging cleanup/write failed: ' + (batch ? this.info.failures[0]?.reason || this.info.lastError : this.info.lastError));
    }
  }

  markDirty(ledger) {
    ledger.dirty = true;
    if (ledger.writeTimer) return;
    ledger.writeTimer = setTimeout(() => {
      ledger.writeTimer = null;
      try { this.flush(ledger); }
      catch (error) { this.reportError(error); }
    }, WRITE_DELAY_MS);
    ledger.writeTimer.unref?.();
  }

  flush(ledger) {
    clearTimeout(ledger.writeTimer);
    ledger.writeTimer = null;
    if (!ledger.dirty) return;
    try { this.save(ledger); }
    catch (error) { ledger.writeError = String(error.stack || error); throw error; }
  }

  flushAll() {
    for (const ledger of this.ledgers.values()) this.flush(ledger);
  }

  pruneCleaned(ledger, reserved = 0) {
    if (ledger.entries.size + reserved <= LEDGER_LIMIT) return;
    const cutoff = Date.now() - this.config().stagingCleanupDays * DAY_MS;
    const candidates = [...ledger.entries.values()]
      .filter(entry => entry.cleanedAt && entry.createdAt < cutoff)
      .sort((left, right) => left.createdAt - right.createdAt || left.cleanedAt - right.cleanedAt);
    let removed = 0;
    for (const entry of candidates) {
      if (ledger.entries.size + reserved <= LEDGER_LIMIT) break;
      ledger.entries.delete(entry.msgId);
      removed++;
    }
    if (removed) this.markDirty(ledger);
  }

  assertCapacity(uin, selfUid) {
    if (String(this.ctx.state.uin) !== uin) throw new Error('暂存来源账号已变化');
    const ledger = this.ledger(uin, selfUid);
    this.pruneCleaned(ledger, 1);
    if (ledger.entries.size >= LEDGER_LIMIT) {
      const error = new Error('STAGING_LEDGER_FULL: account=' + uin + ' entries=' + ledger.entries.size + ' limit=' + LEDGER_LIMIT);
      this.info.lastError = error.message;
      throw error;
    }
  }

  record(msgId, uin, selfUid, source) {
    const id = String(msgId);
    if (String(this.ctx.state.uin) !== uin || !/^[1-9]\d*$/.test(id)) throw new Error('暂存消息账号或 ID 无效：' + id);
    const ledger = this.ledger(uin, selfUid);
    if (ledger.entries.has(id)) return;
    this.assertCapacity(uin, selfUid);
    ledger.entries.set(id, { msgId: id, createdAt: Date.now(), source });
    this.markDirty(ledger);
  }

  snapshot() {
    const account = String(this.ctx.state.uin || '');
    const ledger = this.ledgers.get(account);
    const entries = [...(ledger?.entries.values() || [])];
    const cutoff = Date.now() - this.config().stagingCleanupDays * DAY_MS;
    const reusable = entries.filter(entry => entry.cleanedAt && entry.createdAt < cutoff).length;
    return {
      ...this.info, account, tracked: entries.filter(entry => !entry.cleanedAt).length, running: Boolean(this.pending),
      ledgerLimit: LEDGER_LIMIT, ledgerEntries: entries.length, cleanedEntries: entries.filter(entry => entry.cleanedAt).length,
      ledgerFull: entries.length - reusable >= LEDGER_LIMIT, ledgerOverLimit: entries.length > LEDGER_LIMIT,
      pendingWrite: Boolean(ledger?.dirty), writeError: ledger?.writeError || '',
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    process.once('exit', this.exitHandler);
    this.reschedule();
  }

  reschedule() {
    if (!this.started) return;
    const cfg = this.config();
    const tag = JSON.stringify([cfg.stagingCleanupEnabled, cfg.stagingCleanupDays,
      cfg.stagingCleanupIntervalMs, cfg.stagingCleanupStartupDelayMs]);
    if (tag === this.scheduleTag) return;
    this.scheduleTag = tag;
    clearTimeout(this.timer);
    this.timer = null;
    if (!cfg.stagingCleanupEnabled) { this.info.nextRunAt = null; return; }
    if (!this.pending) this.schedule(cfg.stagingCleanupStartupDelayMs);
  }

  schedule(delay) {
    if (!this.started || !this.config().stagingCleanupEnabled) { this.info.nextRunAt = null; return; }
    this.info.nextRunAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.info.nextRunAt = null;
      this.pending = this.tick().finally(() => { this.pending = null; });
    }, delay);
    this.timer.unref?.();
  }

  async stop() {
    this.started = false;
    this.scheduleTag = '';
    clearTimeout(this.timer);
    this.timer = null;
    this.info.nextRunAt = null;
    if (this.pending) await this.pending;
    try { this.flushAll(); }
    catch (error) { this.reportError(error); throw error; }
    finally { process.removeListener('exit', this.exitHandler); }
  }

  async tick() {
    let retrySoon = false;
    try {
      this.flushAll();
      if (!this.ctx.kernel.online || !this.ctx.state.msgService || !this.ctx.state.uin) {
        this.info.skippedReason = 'account_not_ready';
        retrySoon = true;
        return;
      }
      this.info.skippedReason = '';
      this.info.lastRunAt = Date.now();
      this.info.removed = this.info.missing = this.info.failed = 0;
      this.info.skipped = this.info.skippedInvalidTime = this.info.skippedNotExpired = 0;
      this.info.lastSkip = null;
      this.info.failures = [];
      this.info.lastError = '';
      const uin = String(this.ctx.state.uin);
      const selfUid = await this.ctx.kernel.resolveUid(uin);
      const ledger = this.ledger(uin, selfUid);
      const cutoff = Date.now() - this.config().stagingCleanupDays * DAY_MS;
      const expired = [...ledger.entries.values()].filter(entry => !entry.cleanedAt && entry.createdAt < cutoff);
      for (let offset = 0; offset < expired.length && this.started && this.config().stagingCleanupEnabled; offset += 50) {
        const batch = expired.slice(offset, offset + 50);
        try {
          await this.ctx.state.timing.run(this.ctx.kernel.outboundKey('private', uin),
            () => this.deleteBatch(ledger, batch), { maintenance: true });
        } catch (error) {
          this.info.failed += batch.length;
          this.info.failures.push({ messageIds: batch.map(entry => entry.msgId), reason: String(error.stack || error) });
        }
      }
      if (this.info.failures.length) throw new Error(this.info.failures.map(item => item.reason).join('\n'));
    } catch (error) {
      this.reportError(error, true);
    } finally {
      this.info.lastFinishedAt = Date.now();
      this.schedule(retrySoon ? Math.min(60000, this.config().stagingCleanupIntervalMs) : this.config().stagingCleanupIntervalMs);
    }
  }

  async deleteBatch(ledger, batch) {
    this.flush(ledger);
    const service = this.ctx.state.msgService;
    if (String(this.ctx.state.uin) !== ledger.uin || !this.ctx.kernel.online || !service) {
      throw new Error('暂存清理期间账号或消息服务已变化');
    }
    if (typeof service.deleteMsg !== 'function') throw new Error('客户端未提供 deleteMsg，无法清理过期暂存');
    const peer = { chatType: CHAT_PRIVATE, peerUid: ledger.selfUid, guildId: '' };
    const cutoff = Date.now() - this.config().stagingCleanupDays * DAY_MS;
    const candidates = batch.filter(entry => ledger.entries.has(entry.msgId) && !entry.cleanedAt && entry.createdAt < cutoff);
    if (!candidates.length) return;
    const ids = candidates.map(entry => entry.msgId);
    const raw = await withTimeout(service.getMsgsByMsgId(peer, ids), 10000, 'staging getMsgsByMsgId');
    if (typeof raw?.result === 'number' && raw.result !== 0) throw new Error('staging getMsgsByMsgId: ' + JSON.stringify(raw));
    if (!Array.isArray(raw) && !Array.isArray(raw?.msgList) && !Array.isArray(raw?.messages) &&
        !Array.isArray(raw?.result?.msgList) && !Array.isArray(raw?.result?.messages)) {
      throw new Error('staging getMsgsByMsgId 未返回消息列表');
    }
    const found = new Map(messageList(raw).map(message => [String(message.msgId), message]));
    const remove = [];
    const missing = [];
    for (const id of ids) {
      const message = found.get(id);
      if (!message) { missing.push(id); continue; }
      const peerUid = String(message.peerUid || '');
      if (peerUid && peerUid !== ledger.selfUid && peerUid !== ledger.uin) throw new Error('暂存清理查询返回了非自聊消息：' + id);
      const seconds = typeof message.msgTime === 'number' || typeof message.msgTime === 'string'
        ? Number(message.msgTime) : NaN;
      const time = seconds * 1000;
      if (!Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isFinite(time)) {
        this.info.skipped++;
        this.info.skippedInvalidTime++;
        this.info.lastSkip = { messageId: id, reason: 'invalid_msg_time', msgTime: String(message.msgTime ?? '') };
        continue;
      }
      if (time >= cutoff) {
        this.info.skipped++;
        this.info.skippedNotExpired++;
        this.info.lastSkip = { messageId: id, reason: 'native_not_expired', msgTime: String(message.msgTime) };
        continue;
      }
      remove.push(id);
    }
    if (remove.length) {
      if (this.ctx.state.msgService !== service || String(this.ctx.state.uin) !== ledger.uin || !this.ctx.kernel.online) {
        throw new Error('暂存删除前账号或消息服务已变化');
      }
      // Thirty-day-old records use local native deletion rather than the recall time window.
      const result = await withTimeout(Promise.resolve(service.deleteMsg(peer, remove)), 10000, 'staging deleteMsg');
      if ((typeof result === 'number' && result !== 0) || (typeof result?.result === 'number' && result.result !== 0)) {
        throw new Error('staging deleteMsg: ' + JSON.stringify(result));
      }
    }
    for (const id of [...remove, ...missing]) {
      const entry = ledger.entries.get(id);
      if (entry) entry.cleanedAt = Date.now();
      this.ctx.state.nativeMessages.delete(id);
      this.ctx.state.peerByMsgId.delete(id);
      this.ctx.state.metaByMsgId.delete(id);
    }
    if (remove.length || missing.length) {
      this.markDirty(ledger);
      this.pruneCleaned(ledger);
      this.flush(ledger);
      this.ctx.kernel.scheduleMetaFlush();
    }
    this.info.removed += remove.length;
    this.info.missing += missing.length;
  }
}

module.exports = { StagingCleanup };
