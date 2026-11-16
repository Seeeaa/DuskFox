/** Rolling counters shown on the console overview. */
export class Stats {
  #messagesIn = 0;
  #messagesOut = 0;
  #apiCalls = 0;
  #apiErrors = 0;
  #eventsTotal = 0;
  #connectAttempts = 0;
  #reconnects = 0;
  /** Epoch ms buckets for the last 120 seconds. */
  readonly #buckets = new Map<number, number>();

  /** Total messages received from bots' point of view (inbound + reports). */
  incMessagesIn(): void {
    this.#messagesIn += 1;
  }

  incMessagesOut(): void {
    this.#messagesOut += 1;
  }

  incApiCall(failed = false): void {
    this.#apiCalls += 1;
    if (failed) this.#apiErrors += 1;
  }

  incReconnect(): void {
    this.#connectAttempts += 1;
    this.#reconnects += 1;
  }

  incConnect(): void {
    this.#connectAttempts += 1;
  }

  /** Count one published event (any post_type). */
  incEvent(at = Date.now()): void {
    this.#eventsTotal += 1;
    const second = Math.floor(at / 1000);
    this.#buckets.set(second, (this.#buckets.get(second) ?? 0) + 1);
    if (this.#buckets.size > 240) {
      const cutoff = second - 120;
      for (const key of this.#buckets.keys()) {
        if (key < cutoff) this.#buckets.delete(key);
      }
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
    return this.#messagesIn;
  }

  get messagesOut(): number {
    return this.#messagesOut;
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
      rx: this.#messagesIn,
      tx: this.#messagesOut,
      conn: connections,
      epm: this.eventsPerMinute(),
      calls: this.#apiCalls,
      errors: this.#apiErrors,
      events: this.#eventsTotal,
      reconnects: this.#reconnects,
    };
  }
}
