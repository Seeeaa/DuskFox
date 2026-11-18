import fs from 'node:fs';
import path from 'node:path';
import type { RuntimePaths } from './paths.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One log line as consumed by the console (never contains raw credentials). */
export interface LogRecord {
  /** Local wall clock, MM-DD HH:MM:SS.mmm. */
  readonly time: string;
  readonly level: LogLevel;
  readonly module: string;
  readonly msg: string;
  /** Epoch milliseconds, used for ordering by the UI. */
  readonly ts: number;
}

export interface LoggerOptions {
  /** Minimum level written to file, console and subscribers. */
  level?: LogLevel;
  /** In-memory window kept for the console. */
  ringSize?: number;
  /** Days of daily files to keep. */
  keepDays?: number;
  /** Also echo to stderr; defaults to true. */
  console?: boolean;
}

const BASE64_BLOB = /[A-Za-z0-9+/=]{200,}/g;
const DATA_URI = /data:[^;\s]+;base64,[A-Za-z0-9+/=]+/g;
const MAX_LOG_MESSAGE = 2000;

/**
 * 日志里绝不允许出现整段 base64（一张图 3MB 会把日志和磁盘打爆，控制台也没法读）。
 * 这里在写文件/标准输出/环形缓冲之前统一收口。
 */
export function sanitizeLogMessage(msg: string): string {
  let out = msg.replace(DATA_URI, '[base64 omitted]');
  out = out.replace(BASE64_BLOB, (match) => '[base64 omitted ' + match.length + ' chars]');
  return out.length > MAX_LOG_MESSAGE ? out.slice(0, MAX_LOG_MESSAGE) + '…（已截断，原长 ' + out.length + '）' : out;
}

const ANSI: Record<LogLevel, string> = { debug: '\u001b[90m', info: '\u001b[36m', warn: '\u001b[33m', error: '\u001b[31m' };
const RESET = '\u001b[0m';
const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_RING = 1000;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * 日志时间固定用东八区（可用 DF_LOG_TIMEZONE 覆盖）。
 * 容器默认是 UTC，直接读系统时区会让控制台显示比用户手表慢 8 小时，
 * 排障时根本对不上“几点几分出的问题”。
 */
const LOG_TIME_ZONE = process.env.DF_LOG_TIMEZONE || 'Asia/Shanghai';

const clockParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: LOG_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function partsOf(date: Date): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of clockParts.formatToParts(date)) out[part.type] = part.value;
  return out;
}

function stamp(date: Date): string {
  const parts = partsOf(date);
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}.${pad(date.getMilliseconds(), 3)}`;
}

/** 控制台事件列表用的时间，和日志保持同一时区/口径。 */
export function clockTime(date: Date = new Date()): string {
  const parts = partsOf(date);
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

function dayStamp(date: Date): string {
  const parts = partsOf(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Leveled logger with three sinks: console, daily file, and an in-memory ring
 * buffer that the web console streams over SSE.
 *
 * File writes are queued and flushed serially so a slow disk never blocks the
 * account pipeline; a record is dropped only when the queue exceeds
 * {@link MAX_QUEUE} entries, which is logged as a single warning.
 */
export class Logger {
  #level: LogLevel;
  #console: boolean;
  #ringSize: number;
  #keepDays: number;
  #ring: LogRecord[] = [];
  #listeners = new Set<(record: LogRecord) => void>();
  #queue: string[] = [];
  #flushing = false;
  #droppedSinceLastFlush = 0;
  #currentDay: string;
  #filePath: string;
  #burstKey = '';
  #burstLevel: LogLevel = 'info';
  #burstModule = '';
  #burstCount = 0;
  #burstStartAt = 0;
  #burstLastAt = 0;
  #dir: string;
  #closed = false;

  constructor(paths: RuntimePaths, options: LoggerOptions = {}) {
    this.#level = options.level ?? 'info';
    this.#console = options.console ?? true;
    this.#ringSize = options.ringSize ?? DEFAULT_RING;
    this.#keepDays = options.keepDays ?? DEFAULT_KEEP_DAYS;
    this.#dir = paths.logs;
    this.#currentDay = dayStamp(new Date());
    this.#filePath = path.join(this.#dir, `duskfox-${this.#currentDay}.log`);
    fs.mkdirSync(this.#dir, { recursive: true });
    this.#prune();
    process.on('exit', () => this.#flushSync());
  }

  get level(): LogLevel {
    return this.#level;
  }

  set level(next: LogLevel) {
    this.#level = next;
  }

  get filePath(): string {
    return this.#filePath;
  }

  /** Subscribe to every record that passes the level filter. */
  onRecord(listener: (record: LogRecord) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  debug(module: string, msg: string): void {
    this.log('debug', module, msg);
  }

  info(module: string, msg: string): void {
    this.log('info', module, msg);
  }

  warn(module: string, msg: string): void {
    this.log('warn', module, msg);
  }

  error(module: string, msg: string): void {
    this.log('error', module, msg);
  }

  /** Log a caught error with its message; stack only in debug builds. */
  failure(module: string, msg: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.log('error', module, `${msg}: ${detail}`);
    if (error instanceof Error && error.stack && this.#level === 'debug') {
      this.log('debug', module, error.stack);
    }
  }

  log(level: LogLevel, module: string, msg: string): void {
    if (RANK[level] < RANK[this.#level] || this.#closed) return;
    const now = new Date();
    const safe = sanitizeLogMessage(msg);
    const key = level + '\u0000' + module + '\u0000' + safe;
    // 同一条日志在短时间内反复出现（框架轮询不支持的动作、网络抖动）时不刷屏：
    // 只留第一条，等这段连续重复结束时补一行“又出现 N 次”的汇总。
    if (key === this.#burstKey && now.getTime() - this.#burstLastAt < DEDUPE_WINDOW_MS) {
      this.#burstCount += 1;
      this.#burstLastAt = now.getTime();
      return;
    }
    this.#endBurst(now);
    this.#burstKey = key;
    this.#burstLevel = level;
    this.#burstModule = module;
    this.#burstCount = 0;
    this.#burstStartAt = now.getTime();
    this.#burstLastAt = now.getTime();
    this.#write(level, module, safe, now);
  }

  #write(level: LogLevel, module: string, msg: string, now: Date): void {
    const safe = msg;
    const record: LogRecord = { time: stamp(now), level, module, msg: safe, ts: now.getTime() };

    this.#ring.push(record);
    if (this.#ring.length > this.#ringSize) this.#ring.splice(0, this.#ring.length - this.#ringSize);

    if (this.#console) {
      const colour = process.stderr.isTTY ? ANSI[level] : '';
      const suffix = process.stderr.isTTY ? RESET : '';
      process.stderr.write(`${colour}${record.time} ${level.toUpperCase().padEnd(5)} [${module}] ${safe}${suffix}\n`);
    }

    for (const listener of this.#listeners) {
      try {
        listener(record);
      } catch {
        // A broken subscriber must never break logging.
      }
    }

    this.#enqueue(record);
  }

  /** Newest-last snapshot filtered by level and optional substring. */
  query(options: { level?: LogLevel | 'all'; contains?: string; limit?: number } = {}): LogRecord[] {
    const minRank = options.level && options.level !== 'all' ? RANK[options.level] : 0;
    const needle = options.contains?.trim().toLowerCase();
    const limit = Math.max(1, Math.min(options.limit ?? 400, this.#ringSize));
    const picked: LogRecord[] = [];
    for (let index = this.#ring.length - 1; index >= 0 && picked.length < limit; index -= 1) {
      const record = this.#ring[index];
      if (!record) continue;
      if (RANK[record.level] < minRank) continue;
      if (needle && !record.msg.toLowerCase().includes(needle) && !record.module.toLowerCase().includes(needle)) continue;
      picked.push(record);
    }
    return picked.reverse();
  }

  /** 输出被合并掉的那段重复日志的汇总行。 */
  #endBurst(now: Date): void {
    const count = this.#burstCount;
    const module = this.#burstModule;
    if (count > 0 && module) {
      const seconds = Math.max(1, Math.round((now.getTime() - this.#burstStartAt) / 1000));
      this.#write(this.#burstLevel, module, `上一条相同日志又出现 ${count} 次（${seconds} 秒内，已合并）`, now);
    }
    this.#burstCount = 0;
    this.#burstModule = '';
    this.#burstKey = '';
  }

  /** Drop the in-memory ring and truncate today's file. */
  clear(): void {
    this.#ring = [];
    try {
      fs.truncateSync(this.#filePath, 0);
    } catch {
      // A missing file simply means there was nothing to truncate.
    }
  }

  /** Size of today's log file in bytes, 0 when absent. */
  fileSize(): number {
    try {
      return fs.statSync(this.#filePath).size;
    } catch {
      return 0;
    }
  }

  #enqueue(record: LogRecord): void {
    this.#rotateIfNeeded();
    this.#queue.push(JSON.stringify({ ts: record.ts, level: record.level, module: record.module, msg: record.msg }) + '\n');
    if (this.#queue.length > MAX_QUEUE) {
      this.#queue.shift();
      this.#droppedSinceLastFlush += 1;
    }
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#flushing) return;
    this.#flushing = true;
    try {
      while (this.#queue.length > 0 && !this.#closed) {
        const chunk = this.#queue.join('');
        this.#queue = [];
        await fs.promises.appendFile(this.#filePath, chunk, 'utf8');
        if (this.#droppedSinceLastFlush > 0) {
          this.#droppedSinceLastFlush = 0;
        }
      }
    } catch {
      // Disk full or permissions revoked: console and ring still work.
    } finally {
      this.#flushing = false;
    }
  }

  #flushSync(): void {
    if (this.#queue.length === 0) return;
    const chunk = this.#queue.join('');
    this.#queue = [];
    try {
      fs.appendFileSync(this.#filePath, chunk, 'utf8');
    } catch {
      // Best effort only.
    }
  }

  #rotateIfNeeded(): void {
    const today = dayStamp(new Date());
    if (today === this.#currentDay) return;
    this.#flushSync();
    this.#currentDay = today;
    this.#filePath = path.join(this.#dir, `duskfox-${today}.log`);
    this.#prune();
  }

  #prune(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - this.#keepDays * 86_400_000;
    for (const name of entries) {
      const match = /^duskfox-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (!match?.[1]) continue;
      const when = Date.parse(`${match[1]}T00:00:00`);
      if (Number.isFinite(when) && when < cutoff) {
        try {
          fs.unlinkSync(path.join(this.#dir, name));
        } catch {
          // Ignore locked files on Windows; they are retried next start.
        }
      }
    }
  }
}

/** Upper bound for buffered file lines. */
const MAX_QUEUE = 5000;

/** 相同日志在此窗口内只算一次，其余折叠成计数。 */
const DEDUPE_WINDOW_MS = 30_000;

/** No-op logger used by pure unit tests. */
export function silentLogger(): Logger {
  return new Logger({ root: '', config: '', logs: process.env.TEMP ?? '.', cache: '', data: '', plugins: '', webui: '' }, { console: false, level: 'error' });
}
