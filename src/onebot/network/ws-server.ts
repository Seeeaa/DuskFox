import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { WsServerConnection } from '../../core/config.ts';
import type { AnyConnection } from '../../core/config.ts';
import type { Ob11EventBase } from '../types.ts';
import { failedResponse } from '../types.ts';
import { NetworkAdapter, waitForListening, type ConnectionInfo, type ConnectionStatus } from './base.ts';

/** Forward WebSocket server: bots connect in, events flow out, actions flow in. */
export class WsServerAdapter extends NetworkAdapter {
  #server: WebSocketServer | null = null;
  #clients = new Set<WebSocket>();
  #status: ConnectionStatus = 'stopped';
  #detail = '未启动';
  #boundPort = 0;

  constructor(config: WsServerConnection, host: ConstructorParameters<typeof NetworkAdapter>[2]) {
    super('ws-server', config, host);
  }

  protected override runtimeFingerprint(config: AnyConnection): string {
    const typed = config as WsServerConnection;
    return JSON.stringify([typed.host, typed.port]);
  }

  async start(): Promise<void> {
    const config = this.config as WsServerConnection;
    this.#status = 'starting';
    // 与 ws-client 一致：base64 图片一帧可能几 MB。
    const server = new WebSocketServer({ host: config.host, port: config.port, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
    this.#server = server;
    server.on('connection', (socket: WebSocket, request: IncomingMessage) => this.#onConnection(socket, request));
    server.on('error', (error: Error) => {
      this.#status = 'error';
      this.#detail = error.message;
      this.host.logger.failure('net:ws-server', `${config.name} 监听失败`, error);
    });
    await waitForListening(server);
    const address = server.address();
    this.#boundPort = typeof address === 'object' && address ? address.port : config.port;
    this.#status = 'listening';
    this.#detail = `监听 ${config.host}:${this.#boundPort}`;
    this.host.logger.info('net:ws-server', `${config.name} 已监听 ws://${config.host}:${this.#boundPort}`);
  }

  async stop(): Promise<void> {
    for (const client of this.#clients) client.terminate();
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
    const payload = JSON.stringify(event);
    for (const client of this.#clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  info(): ConnectionInfo {
    const config = this.config as WsServerConnection;
    return this.describe(this.#status, this.#detail, this.#clients.size, `ws://${config.host}:${this.#boundPort || config.port}`);
  }

  #onConnection(socket: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const verdict = this.authorise(request.headers, url);
    if (!verdict.ok) {
      this.host.logger.warn('net:ws-server', `拒绝未授权连接：${url.pathname}`);
      socket.close(1403, verdict.reason ?? 'unauthorized');
      return;
    }
    this.#clients.add(socket);
    this.host.logger.info('net:ws-server', `Bot 已连接（当前 ${this.#clients.size} 个）`);
    socket.send(JSON.stringify(this.host.lifecycle('connect')));
    socket.on('message', (raw) => void this.#onMessage(socket, raw.toString()));
    socket.on('close', () => {
      this.#clients.delete(socket);
      this.host.logger.info('net:ws-server', `Bot 已断开（当前 ${this.#clients.size} 个）`);
    });
    socket.on('error', () => {});
  }

  async #onMessage(socket: WebSocket, raw: string): Promise<void> {
    const request = this.parseRequest(raw);
    if (!request) return;
    let response;
    try {
      const data = await this.host.dispatch(request.action, request.params, request.echo, 'websocket');
      response = data;
    } catch (error) {
      response = failedResponse(error, request.echo);
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  }
}
