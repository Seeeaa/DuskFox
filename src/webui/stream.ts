import type { ServerResponse } from 'node:http';

interface Client {
  readonly res: ServerResponse;
}

/** Server sent event fan-out for the console live panels. */
export class StreamHub {
  readonly #clients = new Set<Client>();
  #pingTimer: NodeJS.Timeout | null = null;

  get size(): number {
    return this.#clients.size;
  }

  /** Attach a response. Returns a detach function. */
  attach(res: ServerResponse): () => void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const client: Client = { res };
    this.#clients.add(client);
    this.#ensurePing();
    const detach = (): void => {
      this.#clients.delete(client);
      if (this.#clients.size === 0 && this.#pingTimer) {
        clearInterval(this.#pingTimer);
        this.#pingTimer = null;
      }
    };
    res.on('close', detach);
    res.on('error', detach);
    return detach;
  }

  /** Push one named event. Unknown characters cannot appear in names here. */
  send(event: string, payload: unknown): void {
    if (this.#clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.#clients) {
      if (!client.res.writableEnded) client.res.write(frame);
    }
  }

  #ensurePing(): void {
    if (this.#pingTimer) return;
    this.#pingTimer = setInterval(() => {
      for (const client of this.#clients) {
        if (!client.res.writableEnded) client.res.write(': ping\n\n');
      }
    }, 15_000);
    this.#pingTimer.unref?.();
  }
}
