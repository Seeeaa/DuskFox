'use strict';
const { randomInt } = require('node:crypto');

const DEFAULTS = Object.freeze({
  enabled: true, minMs: 100, maxMs: 300,
  quietHoursEnabled: false, quietStart: '00:00', quietEnd: '07:00',
  idleProbability: 0, idleDurationMs: 60_000, timeZone: 'Asia/Shanghai',
  fileMaxBytes: 50 * 1024 * 1024,
  stagingCleanupEnabled: true, stagingCleanupDays: 30,
  stagingCleanupIntervalMs: 86400_000, stagingCleanupStartupDelayMs: 60_000,
});
const ENV = {
  enabled: 'QQ_BRIDGE_TIMING_ENABLED', minMs: 'QQ_BRIDGE_TIMING_MIN_MS', maxMs: 'QQ_BRIDGE_TIMING_MAX_MS',
  quietHoursEnabled: 'QQ_BRIDGE_QUIET_HOURS_ENABLED', quietStart: 'QQ_BRIDGE_QUIET_START',
  quietEnd: 'QQ_BRIDGE_QUIET_END', idleProbability: 'QQ_BRIDGE_IDLE_PROBABILITY',
  idleDurationMs: 'QQ_BRIDGE_IDLE_DURATION_MS', timeZone: 'QQ_BRIDGE_TIMEZONE',
  fileMaxBytes: 'QQ_BRIDGE_FILE_MAX_BYTES',
  stagingCleanupEnabled: 'QQ_BRIDGE_STAGING_CLEANUP_ENABLED', stagingCleanupDays: 'QQ_BRIDGE_STAGING_CLEANUP_DAYS',
  stagingCleanupIntervalMs: 'QQ_BRIDGE_STAGING_CLEANUP_INTERVAL_MS',
  stagingCleanupStartupDelayMs: 'QQ_BRIDGE_STAGING_CLEANUP_STARTUP_DELAY_MS',
};
const BOOL = new Set(['enabled', 'quietHoursEnabled', 'stagingCleanupEnabled']);
const NUMBER = new Set(['minMs', 'maxMs', 'idleProbability', 'idleDurationMs', 'fileMaxBytes',
  'stagingCleanupDays', 'stagingCleanupIntervalMs', 'stagingCleanupStartupDelayMs']);

class OutboundBlocked extends Error {
  constructor(code, reason, until = null) {
    super(code + ': ' + reason);
    this.code = code;
    this.until = until;
    this.statusCode = 429;
  }
}

class OutboundTiming {
  constructor(env = process.env) {
    this.env = env;
    this.overrides = {};
    this.tails = new Map();
    this.pending = 0;
    this.running = 0;
    this.idleUntil = 0;
    this.lastRejection = null;
    this.resolve();
  }

  resolve(overrides = this.overrides) {
    const config = {}, sources = {};
    for (const [key, fallback] of Object.entries(DEFAULTS)) {
      let value;
      if (Object.hasOwn(overrides, key)) { value = overrides[key]; sources[key] = 'runtime'; }
      else if (this.env[ENV[key]] !== undefined && this.env[ENV[key]] !== '') {
        value = this.env[ENV[key]]; sources[key] = 'environment';
      } else { value = fallback; sources[key] = 'default'; }
      if (BOOL.has(key)) {
        if (value === true || value === 'true' || value === '1' || value === 1) value = true;
        else if (value === false || value === 'false' || value === '0' || value === 0) value = false;
        else throw new Error(key + ' 必须是 boolean');
      } else if (NUMBER.has(key)) {
        value = Number(value);
        if (!Number.isFinite(value) || value < 0) throw new Error(key + ' 必须是非负数字');
      } else value = String(value);
      config[key] = value;
    }
    for (const key of ['minMs', 'maxMs', 'idleDurationMs']) {
      if (!Number.isInteger(config[key])) throw new Error(key + ' 必须是整数');
    }
    if (config.minMs > config.maxMs || config.maxMs > 60000) throw new Error('需要 0 <= minMs <= maxMs <= 60000');
    if (config.idleProbability > 1 || config.idleDurationMs < 1 || config.idleDurationMs > 86400000) {
      throw new Error('idleProbability 必须在 0..1，idleDurationMs 必须在 1..86400000');
    }
    for (const key of ['quietStart', 'quietEnd']) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(config[key])) throw new Error(key + ' 必须是 HH:mm');
    }
    new Intl.DateTimeFormat('en', { timeZone: config.timeZone }).format();
    for (const key of ['fileMaxBytes', 'stagingCleanupDays', 'stagingCleanupIntervalMs', 'stagingCleanupStartupDelayMs']) {
      if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(key + ' 必须是正整数');
    }
    for (const key of ['stagingCleanupIntervalMs', 'stagingCleanupStartupDelayMs']) {
      if (config[key] < 1000 || config[key] > 2147483647) throw new Error(key + ' 必须在 1000..2147483647');
    }
    if (config.stagingCleanupDays > 3650) throw new Error('stagingCleanupDays 必须在 1..3650');
    return { config, sources };
  }

  update(patch, replace = false) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('配置必须是对象');
    const next = replace ? {} : { ...this.overrides };
    for (const [key, value] of Object.entries(patch)) {
      if (!Object.hasOwn(DEFAULTS, key)) throw new Error('未知配置字段：' + key);
      if (value === null) delete next[key]; else next[key] = value;
    }
    this.resolve(next);
    this.overrides = next;
    if (!this.resolve().config.idleProbability) this.idleUntil = 0;
    return this.snapshot();
  }

  gate(sampleIdle = false) {
    const { config } = this.resolve();
    const now = Date.now();
    if (config.quietHoursEnabled) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone: config.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
      const minute = Number(parts.hour) * 60 + Number(parts.minute);
      const asMinutes = text => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
      const start = asMinutes(config.quietStart), end = asMinutes(config.quietEnd);
      const quiet = start === end || (start < end ? minute >= start && minute < end : minute >= start || minute < end);
      if (quiet) {
        const until = start === end ? null : now + ((end - minute + 1440) % 1440) * 60000 - Number(parts.second) * 1000;
        return { allowed: false, reason: 'quiet_hours', until };
      }
    }
    if (this.idleUntil > now) return { allowed: false, reason: 'random_idle', until: this.idleUntil };
    if (sampleIdle && config.idleProbability > 0 && Math.random() < config.idleProbability) {
      this.idleUntil = now + config.idleDurationMs;
      return { allowed: false, reason: 'random_idle', until: this.idleUntil };
    }
    return { allowed: true, reason: '', until: null };
  }

  assertAllowed(sampleIdle = false) {
    const state = this.gate(sampleIdle);
    if (state.allowed) return;
    this.lastRejection = { ...state, at: Date.now() };
    throw new OutboundBlocked(state.reason === 'quiet_hours' ? 'OUTBOUND_QUIET_HOURS' : 'OUTBOUND_RANDOM_IDLE',
      state.reason, state.until);
  }

  snapshot() {
    return {
      ...this.resolve(), overrides: { ...this.overrides },
      state: { ...this.gate(), queued: this.pending - this.running, running: this.running, activePeers: this.tails.size, lastRejection: this.lastRejection },
    };
  }

  /** Queue before any await, so uploads cannot reorder messages addressed to one peer. */
  run(peer, operation, options = {}) {
    const entered = Date.now();
    const previous = this.tails.get(peer) || Promise.resolve();
    this.pending++;
    const task = previous.catch(() => {}).then(async () => {
      this.running++;
      try {
        if (Date.now() - entered > 120000) throw new OutboundBlocked('OUTBOUND_QUEUE_EXPIRED', '出站排队超过 120 秒');
        if (!options.maintenance) this.assertAllowed(true);
        const { config } = this.resolve();
        if (config.enabled && !options.maintenance) {
          const delay = randomInt(config.minMs, config.maxMs + 1);
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        }
        if (!options.maintenance) this.assertAllowed();
        return await operation();
      } finally { this.running--; }
    }).finally(() => { this.pending--; });
    const tail = task.catch(() => {});
    this.tails.set(peer, tail);
    void tail.finally(() => { if (this.tails.get(peer) === tail) this.tails.delete(peer); });
    return task;
  }
}

module.exports = { OutboundTiming, OutboundBlocked, DEFAULTS };
