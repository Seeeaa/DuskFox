import fs from 'node:fs';
import path from 'node:path';

/** Counters accumulated for one QQ account login session. */
export interface StatsRecord {
  /** Epoch ms of the login this record belongs to; 0 while no login was seen yet. */
  loginAt: number;
  messagesIn: number;
  messagesOut: number;
  apiCalls: number;
  apiErrors: number;
  eventsTotal: number;
  reconnects: number;
  connectAttempts: number;
}

/** Minimal logger surface: a failed stats write must never break the pipeline. */
export interface StatsLogger {
  warn(module: string, msg: string): void;
}

export interface StatsOptions {
  /** Directory that keeps stats.json (usually RuntimePaths.data); omitted = memory only. */
  readonly dataDir?: string;
  readonly logger?: StatsLogger;
  /** Debounce window for disk writes in ms; defaults to 1500. */
  readonly writeDelayMs?: number;
}

const FILE_NAME = 'stats.json';
const DEFAULT_WRITE_DELAY_MS = 1500;

function emptyRecord(loginAt = 0): StatsRecord {
  return {
    loginAt,
    messagesIn: 0,
    messagesOut: 0,
    apiCalls: 0,
    apiErrors: 0,
    eventsTotal: 0,
    reconnects: 0,
    connectAttempts: 0,
  };
}

/** Non-negative integer from persisted JSON, tolerant of missing/garbage fields. */
function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/** Rolling counters shown on the console overview. */
export class Stats {
  #record: StatsRecord;
  /** Epoch ms buckets for the last 120 seconds (in-memory only). */
  readonly #buckets = new Map<number, number>();
  readonly #file: string | null;
  readonly #logger: StatsLogger | undefined;
  readonly #writeDelayMs: number;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;

  constructor(options: StatsOptions = {}) {
    this.#file = options.dataDir ? path.join(options.dataDir, FILE_NAME) : null;
    this.#logger = options.logger;
    this.#writeDelayMs = Math.max(200, options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS);
    this.#record = this.#load();
  }

  /**
   * Align the counters with the account's current login.
   *
   * `loginAt <= 0` means offline/unknown and is ignored, so a bridge hiccup does
   * not wipe a live session. A different timestamp means the QQ account logged
   * in again: counters restart at zero and the new anchor is written at once, so
   * a crash right after login still resumes from the correct point.
   */
  ensureSession(loginAt: number): void {
    const next = Number.isFinite(loginAt) && loginAt > 0 ? Math.floor(loginAt) : 0;
    if (next <= 0 || next === this.#record.loginAt) return;
    this.#record = emptyRecord(next);
    this.#dirty = true;
    this.#persist();
  }

  /** Write pending counters synchronously; called on shutdown. */
  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#dirty) this.#persist();
  }

  /** Total messages received from bots' point of view (inbound + reports). */
  incMessagesIn(): void {
    this.#record.messagesIn += 1;
    this.#touch();
  }

  incMessagesOut(): void {
    this.#record.messagesOut += 1;
    this.#touch();
  }

  incApiCall(failed = false): void {
    this.#record.apiCalls += 1;
    if (failed) this.#record.apiErrors += 1;
    this.#touch();
  }

  incReconnect(): void {
    this.#record.connectAttempts += 1;
    this.#record.reconnects += 1;
    this.#touch();
  }

  incConnect(): void {
    this.#record.connectAttempts += 1;
    this.#touch();
  }

  /** Count one published event (any post_type). */
  incEvent(at = Date.now()): void {
    this.#record.eventsTotal += 1;
    const second = Math.floor(at / 1000);
    this.#buckets.set(second, (this.#buckets.get(second) ?? 0) + 1);
    if (this.#buckets.size > 240) {
      const cutoff = second - 120;
      for (const key of this.#buckets.keys()) {
        if (key < cutoff) this.#buckets.delete(key);
      }
    }
    this.#touch();
  }

  /** Coalesce counter changes into one debounced write. */
  #touch(): void {
    this.#dirty = true;
    if (this.#timer || !this.#file) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#dirty) this.#persist();
    }, this.#writeDelayMs);
    this.#timer.unref?.();
  }

  /** Read the persisted record; a missing or corrupt file starts empty. */
  #load(): StatsRecord {
    const target = this.#file;
    if (!target) return emptyRecord();
    let raw: string;
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch {
      return emptyRecord();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#logger?.warn('stats', `忽略无法解析的 ${target}`);
      return emptyRecord();
    }
    if (!parsed || typeof parsed !== 'object') return emptyRecord();
    const saved = parsed as Partial<StatsRecord>;
    return {
      loginAt: count(saved.loginAt),
      messagesIn: count(saved.messagesIn),
      messagesOut: count(saved.messagesOut),
      apiCalls: count(saved.apiCalls),
      apiErrors: count(saved.apiErrors),
      eventsTotal: count(saved.eventsTotal),
      reconnects: count(saved.reconnects),
      connectAttempts: count(saved.connectAttempts),
    };
  }

  /** Synchronous atomic write; failures are warnings only. */
  #persist(): void {
    const target = this.#file;
    if (!target) {
      this.#dirty = false;
      return;
    }
    const temporary = `${target}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify(this.#record, null, 2)}\n`, 'utf8');
      fs.renameSync(temporary, target);
      this.#dirty = false;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger?.warn('stats', `写入 ${target} 失败：${detail}`);
    }
  }

  /** Events observed during the last 60 seconds. */
  eventsPerMinute(now = Date.now()): number {
    const second = Math.floor(now / 1000);
    let total = 0;
    for (let offset = 0; offset < 60; offset += 1) total += this.#buckets.get(second - offset) ?? 0;
    return total;
  }

  get messagesIn(): number {
    return this.#record.messagesIn;
  }

  get messagesOut(): number {
    return this.#record.messagesOut;
  }

  snapshot(connections: number): {
    rx: number;
    tx: number;
    conn: number;
    epm: number;
    calls: number;
    errors: number;
    events: number;
    reconnects: number;
  } {
    return {
      rx: this.#record.messagesIn,
      tx: this.#record.messagesOut,
      conn: connections,
      epm: this.eventsPerMinute(),
      calls: this.#record.apiCalls,
      errors: this.#record.apiErrors,
      events: this.#record.eventsTotal,
      reconnects: this.#record.reconnects,
    };
  }
}
