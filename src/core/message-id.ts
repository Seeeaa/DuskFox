import crypto from 'node:crypto';

interface Entry {
  readonly nativeId: string;
  readonly scene: 'private' | 'group';
  readonly peerId: string;
}

export interface ResolvedMessageId extends Entry {
  readonly numericId: number;
}

const DEFAULT_CAPACITY = 5000;

/**
 * Maps driver native message ids to the positive 32 bit ids OneBot clients see.
 *
 * No database is involved: a bounded table keeps roughly the last
 * {@link capacity} messages, which is all a bot needs for recall and lookups.
 * `hash` mode derives the id from a digest so the same message keeps the same
 * id across restarts; `seq` mode hands out a monotonic counter.
 */
export class MessageIdRegistry {
  readonly #capacity: number;
  #mode: 'hash' | 'seq';
  #seq = 0;
  /** numeric id -> entry, insertion ordered for LRU trimming. */
  readonly #byId = new Map<number, Entry>();
  /** `scene|peerId|nativeId` -> numeric id. */
  readonly #byNative = new Map<string, number>();

  constructor(mode: 'hash' | 'seq' = 'hash', capacity = DEFAULT_CAPACITY) {
    this.#mode = mode;
    this.#capacity = capacity;
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
}
