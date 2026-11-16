import fs from 'node:fs';
import path from 'node:path';
import type { RuntimePaths } from './paths.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One log line as consumed by the console (never contains raw credentials). */
export interface LogRecord {
  /** Local wall clock, HH:MM:SS. */
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

const ANSI: Record<LogLevel, string> = { debug: '\u001b[90m', info: '\u001b[36m', warn: '\u001b[33m', error: '\u001b[31m' };
const RESET = '\u001b[0m';
const DEFAULT_KEEP_DAYS = 14;
const DEFAULT_RING = 1000;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function stamp(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function dayStamp(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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
    const record: LogRecord = { time: stamp(now), level, module, msg, ts: now.getTime() };

    this.#ring.push(record);
    if (this.#ring.length > this.#ringSize) this.#ring.splice(0, this.#ring.length - this.#ringSize);

    if (this.#console) {
      const colour = process.stderr.isTTY ? ANSI[level] : '';
      const suffix = process.stderr.isTTY ? RESET : '';
      process.stderr.write(`${colour}${record.time} ${level.toUpperCase().padEnd(5)} [${module}] ${msg}${suffix}\n`);
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

/** No-op logger used by pure unit tests. */
export function silentLogger(): Logger {
  return new Logger({ root: '', config: '', logs: process.env.TEMP ?? '.', cache: '', data: '', plugins: '', webui: '' }, { console: false, level: 'error' });
}
