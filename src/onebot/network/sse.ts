import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AnyConnection, SseServerConnection } from '../../core/config.ts';
import type { Ob11EventBase } from '../types.ts';
import { NetworkAdapter, waitForListening, type ConnectionInfo, type ConnectionStatus } from './base.ts';

/** Server sent events: a read-only event stream for lightweight consumers. */
export class SseAdapter extends NetworkAdapter {
  #server: http.Server | null = null;
  #clients = new Set<ServerResponse>();
  #heartbeat: NodeJS.Timeout | null = null;
  #status: ConnectionStatus = 'stopped';
  #detail = '未启动';
  #boundPort = 0;

  constructor(config: SseServerConnection, host: ConstructorParameters<typeof NetworkAdapter>[2]) {
    super('sse', config, host);
  }

  protected override runtimeFingerprint(config: AnyConnection): string {
    const typed = config as SseServerConnection;
    return JSON.stringify([typed.host, typed.port]);
  }

  async start(): Promise<void> {
    const config = this.config as SseServerConnection;
    this.#status = 'starting';
    const server = http.createServer((request, response) => this.#onRequest(request, response));
    this.#server = server;
    server.on('error', (error: Error) => {
      this.#status = 'error';
      this.#detail = error.message;
      this.host.logger.failure('net:sse', `${config.name} 监听失败`, error);
    });
    server.listen(config.port, config.host);
    await waitForListening(server);
    const address = server.address();
    this.#boundPort = typeof address === 'object' && address ? address.port : config.port;
    this.#status = 'listening';
    this.#detail = `事件流 ${config.host}:${this.#boundPort}`;
    this.#heartbeat = setInterval(() => this.#ping(), 15_000);
    this.#heartbeat.unref?.();
    this.host.logger.info('net:sse', `${config.name} 已监听 http://${config.host}:${this.#boundPort}`);
  }

  async stop(): Promise<void> {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const client of this.#clients) client.end();
    this.#clients.clear();
    const server = this.#server;
    this.#server = null;
    this.#status = 'stopped';
    this.#detail = '已停止';
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  publish(event: Ob11EventBase): void {
    if (this.#clients.size === 0) return;
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.#clients) client.write(frame);
  }

  info(): ConnectionInfo {
    const config = this.config as SseServerConnection;
    return this.describe(
      this.#status,
      this.#detail,
      this.#clients.size,
      `http://${config.host}:${this.#boundPort || config.port}/events`,
    );
  }

  #onRequest(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const verdict = this.authorise(request.headers, url);
    if (!verdict.ok) {
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('unauthorized');
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { allow: 'GET' });
      response.end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 3000\n\n');
    response.write(`data: ${JSON.stringify(this.host.lifecycle('connect'))}\n\n`);
    this.#clients.add(response);
    this.host.logger.info('net:sse', `SSE 客户端已连接（当前 ${this.#clients.size} 个）`);
    const cleanup = (): void => {
      this.#clients.delete(response);
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
  }

  #ping(): void {
    for (const client of this.#clients) client.write(': ping\n\n');
  }
}
