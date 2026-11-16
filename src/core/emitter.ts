/** A minimal, allocation friendly typed event emitter. */
export type Handler<T> = (payload: T) => void;
export type WildcardHandler<K extends string, M> = (type: K, payload: M) => void;

export class Emitter<K extends string, M> {
  readonly #handlers = new Map<K, Set<Handler<M>>>();
  readonly #wildcard = new Set<WildcardHandler<K, M>>();
  readonly #label: string;
  /** Optional sink for handler exceptions. Never throws into the emitter. */
  onError: ((error: unknown, context: { type: K }) => void) | null = null;

  constructor(label: string) {
    this.#label = label;
  }

  get label(): string {
    return this.#label;
  }

  on(type: K, handler: Handler<M>): () => void {
    let set = this.#handlers.get(type);
    if (!set) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  onAny(handler: WildcardHandler<K, M>): () => void {
    this.#wildcard.add(handler);
    return () => this.#wildcard.delete(handler);
  }

  once(type: K, handler: Handler<M>): () => void {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(type: K, handler: Handler<M>): void {
    const set = this.#handlers.get(type);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.#handlers.delete(type);
  }

  /** Number of registered listeners (wildcard listeners included once each). */
  count(type?: K): number {
    if (!type) {
      let total = this.#wildcard.size;
      for (const set of this.#handlers.values()) total += set.size;
      return total;
    }
    return (this.#handlers.get(type)?.size ?? 0) + this.#wildcard.size;
  }

  /**
   * Deliver a payload. Handlers run synchronously in registration order and a
   * throwing handler is isolated so one broken subscriber cannot break the
   * account pipeline (mirrors the defensive dispatch used by napcat-core).
   */
  emit(type: K, payload: M): void {
    const direct = this.#handlers.get(type);
    if (direct) {
      for (const handler of [...direct]) this.#invoke(handler, payload, type);
    }
    for (const handler of [...this.#wildcard]) {
      try {
        handler(type, payload);
      } catch (error) {
        this.onError?.(error, { type });
      }
    }
  }

  clear(): void {
    this.#handlers.clear();
    this.#wildcard.clear();
  }

  #invoke(handler: Handler<M>, payload: M, type: K): void {
    try {
      handler(payload);
    } catch (error) {
      this.onError?.(error, { type });
    }
  }
}
