import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface Entry {
  readonly nativeId: string;
  readonly scene: 'private' | 'group';
  readonly peerId: string;
}

export interface ResolvedMessageId extends Entry {
  readonly numericId: number;
}

/** On-disk window; versioned so a future layout change stays detectable. */
interface PersistedState {
  readonly version: number;
  readonly mode: 'hash' | 'seq';
  readonly seq: number;
  readonly entries: readonly {
    readonly numericId: number;
    readonly nativeId: string;
    readonly scene: 'private' | 'group';
    readonly peerId: string;
  }[];
}

const DEFAULT_CAPACITY = 5000;
const STATE_VERSION = 1;
/** Coalescing window for disk writes: a burst of messages costs one write. */
const PERSIST_DELAY_MS = 1000;

/**
 * Maps driver native message ids to the positive 32 bit ids OneBot clients see.
 *
 * Like napcat, no database is involved: a bounded table keeps roughly the last
 * {@link capacity} messages, which is all a bot needs for recall and lookups.
 * `hash` mode derives the id from a digest so the same message keeps the same
 * id across restarts; `seq` mode hands out a monotonic counter.
 *
 * When a `stateFile` is given the window is restored from that JSON file on
 * construction and written back (tmp file + rename) after changes, so a numeric
 * id seen before a restart still resolves to its native id afterwards.
 */
export class MessageIdRegistry {
  readonly #capacity: number;
  readonly #stateFile: string | null;
  #mode: 'hash' | 'seq';
  #seq = 0;
  /** numeric id -> entry, insertion ordered for LRU trimming. */
  readonly #byId = new Map<number, Entry>();
  /** `scene|peerId|nativeId` -> numeric id. */
  readonly #byNative = new Map<string, number>();
  #persistTimer: NodeJS.Timeout | null = null;
  #dirty = false;
  readonly #onExit: (() => void) | null;

  constructor(mode: 'hash' | 'seq' = 'hash', capacity = DEFAULT_CAPACITY, stateFile: string | null = null) {
    this.#mode = mode;
    this.#capacity = capacity;
    this.#stateFile = stateFile;
    if (stateFile) this.#restore(stateFile);
    this.#onExit = stateFile ? () => this.flush() : null;
    // A synchronous last write on exit is the only durable hook left after
    // the debounce timer was dropped by the event loop shutting down.
    if (this.#onExit) process.once('exit', this.#onExit);
  }

  get mode(): 'hash' | 'seq' {
    return this.#mode;
  }

  set mode(next: 'hash' | 'seq') {
    if (next === this.#mode) return;
    this.#mode = next;
    // Ids from the previous scheme are no longer derivable: drop them rather
    // than hand out numbers that can never be resolved again.
    this.#byId.clear();
    this.#byNative.clear();
    this.#schedulePersist();
  }

  get size(): number {
    return this.#byId.size;
  }

  /** Register a native message and return the numeric id clients will see. */
  register(nativeId: string, scene: 'private' | 'group', peerId: string): number {
    const key = `${scene}|${peerId}|${nativeId}`;
    const existing = this.#byNative.get(key);
    if (existing !== undefined && this.#byId.has(existing)) return existing;

    const numericId = this.#mode === 'seq' ? ++this.#seq : this.#hashId(key);
    const entry: Entry = { nativeId, scene, peerId };
    this.#byId.set(numericId, entry);
    this.#byNative.set(key, numericId);
    this.#trim();
    this.#schedulePersist();
    return numericId;
  }

  /** Resolve a numeric id back to its driver native id. */
  resolve(numericId: number): ResolvedMessageId | null {
    const entry = this.#byId.get(numericId);
    return entry ? { ...entry, numericId } : null;
  }

  /** Native id for a numeric id, or null when it fell out of the window. */
  nativeIdOf(numericId: number): string | null {
    return this.#byId.get(numericId)?.nativeId ?? null;
  }

  clear(): void {
    this.#byId.clear();
    this.#byNative.clear();
    this.#schedulePersist();
  }

  /** Write the window to disk now (a no-op when persistence is disabled). */
  flush(): void {
    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }
    this.#persistNow();
  }

  /** Flush and detach the exit hook, e.g. when the owning service is replaced. */
  dispose(): void {
    this.flush();
    if (this.#onExit) process.removeListener('exit', this.#onExit);
  }

  #hashId(key: string): number {
    const digest = crypto.createHash('md5').update(key).digest();
    // Keep the first bit clear so the id is always a positive int32.
    let candidate = digest.readInt32BE(0) & 0x7fffffff;
    if (candidate === 0) candidate = 1;
    let probe = 0;
    while (this.#byId.has(candidate)) {
      probe += 1;
      candidate = (candidate + probe) & 0x7fffffff;
      if (candidate === 0) candidate = 1;
      if (probe > 64) break;
    }
    return candidate;
  }

  #trim(): void {
    while (this.#byId.size > this.#capacity) {
      const oldest = this.#byId.keys().next();
      if (oldest.done) break;
      const entry = this.#byId.get(oldest.value);
      this.#byId.delete(oldest.value);
      if (entry) this.#byNative.delete(`${entry.scene}|${entry.peerId}|${entry.nativeId}`);
    }
  }

  /** Read the previous window; a missing or corrupt file means a cold start. */
  #restore(file: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const saved = parsed as Partial<PersistedState>;

    // The counter is restored even when the scheme changed: ids must never be
    // handed out twice, whether the file matched or not.
    if (typeof saved.seq === 'number' && Number.isSafeInteger(saved.seq) && saved.seq > 0) {
      this.#seq = saved.seq;
    }
    // Numeric ids only mean something within the scheme that issued them.
    if (saved.mode !== this.#mode || !Array.isArray(saved.entries)) return;

    for (const raw of saved.entries) {
      const parsedEntry = readEntry(raw);
      if (!parsedEntry) continue;
      const key = `${parsedEntry.entry.scene}|${parsedEntry.entry.peerId}|${parsedEntry.entry.nativeId}`;
      if (this.#byId.has(parsedEntry.numericId) || this.#byNative.has(key)) continue;
      this.#byId.set(parsedEntry.numericId, parsedEntry.entry);
      this.#byNative.set(key, parsedEntry.numericId);
    }
    this.#trim();
    if (this.#mode !== 'seq') return;
    // A hand-edited file must not make the next register() collide.
    for (const numericId of this.#byId.keys()) {
      if (numericId > this.#seq) this.#seq = numericId;
    }
  }

  #schedulePersist(): void {
    if (!this.#stateFile) return;
    this.#dirty = true;
    // Keep the first timer instead of resetting it: a constant message stream
    // must still reach the disk within a second.
    if (this.#persistTimer) return;
    const timer = setTimeout(() => {
      this.#persistTimer = null;
      this.#persistNow();
    }, PERSIST_DELAY_MS);
    // Persistence must not be the reason the process stays alive; exit flushes.
    timer.unref?.();
    this.#persistTimer = timer;
  }

  #persistNow(): void {
    const target = this.#stateFile;
    if (!target) return;
    if (!this.#dirty) return;
    const temporary = `${target}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(temporary, `${JSON.stringify(this.#snapshot(), null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporary, target);
      this.#dirty = false;
    } catch {
      // An unwritable state directory is a warning we cannot log here; the
      // in-memory window keeps working and the next change retries the write.
      try {
        fs.unlinkSync(temporary);
      } catch {
        // Nothing to clean up.
      }
    }
  }

  /** Bounded snapshot in insertion order, newest last. */
  #snapshot(): PersistedState {
    const entries: { numericId: number; nativeId: string; scene: 'private' | 'group'; peerId: string }[] = [];
    for (const [numericId, entry] of this.#byId) {
      entries.push({ numericId, nativeId: entry.nativeId, scene: entry.scene, peerId: entry.peerId });
    }
    return { version: STATE_VERSION, mode: this.#mode, seq: this.#seq, entries };
  }
}

/** Validate one persisted entry; anything malformed is skipped on purpose. */
function readEntry(raw: unknown): { numericId: number; entry: Entry } | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as { numericId?: unknown; nativeId?: unknown; scene?: unknown; peerId?: unknown };
  const numericId = item.numericId;
  if (typeof numericId !== 'number' || !Number.isSafeInteger(numericId) || numericId <= 0 || numericId > 0x7fffffff) {
    return null;
  }
  if (typeof item.nativeId !== 'string' || item.nativeId.length === 0) return null;
  if (item.scene !== 'private' && item.scene !== 'group') return null;
  if (typeof item.peerId !== 'string' || item.peerId.length === 0) return null;
  return { numericId, entry: { nativeId: item.nativeId, scene: item.scene, peerId: item.peerId } };
}
