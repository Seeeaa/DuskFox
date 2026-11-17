import type { Scene, Segment } from './model.ts';

export interface StoredMessage {
  /** Insertion order, useful for "recent messages" views. */
  readonly seq: number;
  /** Driver native id (recall uses this). */
  readonly nativeId: string;
  /** OneBot id handed to bot frameworks. */
  readonly ob11Id: number;
  readonly scene: Scene;
  readonly peerId: string;
  readonly peerName?: string;
  readonly senderId: string;
  readonly senderName?: string;
  /** Epoch seconds. */
  readonly time: number;
  readonly self: boolean;
  readonly segments: readonly Segment[];
}

const DEFAULT_CAPACITY = 500;

/**
 * Bounded recent-message cache.
 *
 * OneBot's `get_msg` needs to answer for messages this framework already
 * dispatched, but keeping an unbounded history would turn a stateless connector
 * into a database. A ring buffer of the last N messages is enough for the
 * conversational use cases bots actually have, and it matches the design of the
 * message-id registry (same window, same eviction story).
 */
export class MessageStore {
  readonly #capacity: number;
  readonly #byOb11 = new Map<number, StoredMessage>();
  readonly #order: number[] = [];
  #seq = 0;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#byOb11.size;
  }

  save(input: Omit<StoredMessage, 'seq'>): StoredMessage {
    const record: StoredMessage = { ...input, seq: ++this.#seq };
    this.#byOb11.set(record.ob11Id, record);
    this.#order.push(record.ob11Id);
    while (this.#order.length > this.#capacity) {
      const oldest = this.#order.shift();
      if (oldest !== undefined) this.#byOb11.delete(oldest);
    }
    return record;
  }

  get(ob11Id: number): StoredMessage | undefined {
    return this.#byOb11.get(ob11Id);
  }

  recent(limit = 20): StoredMessage[] {
    const count = Math.max(1, Math.min(limit, this.#order.length));
    return this.#order
      .slice(-count)
      .reverse()
      .map((id) => this.#byOb11.get(id))
      .filter((record): record is StoredMessage => record !== undefined);
  }

  clear(): void {
    this.#byOb11.clear();
    this.#order.length = 0;
  }
}
