import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AnyConnection, HttpServerConnection } from '../../core/config.ts';
import type { Ob11EventBase } from '../types.ts';
import { failedResponse } from '../types.ts';
import { NetworkAdapter, waitForListening, type ConnectionInfo, type ConnectionStatus } from './base.ts';

// 图片以 base64 走 JSON body，1 MB 连一张普通图都放不下。
const MAX_BODY = 64 * 1024 * 1024;

/**
 * HTTP + WebSocket API server.
 *
 * One port serves both transports, like NapCat: `POST /send_msg` calls an
 * action, and when `enableWs` is on, an upgrade on `/api` yields an action-only
 * socket while any other path receives the event stream as well.
 */
export class HttpServerAdapter extends NetworkAdapter {
  #server: http.Server | null = null;
  #wss: WebSocketServer | null = null;
  #apiSockets = new Set<WebSocket>();
  #eventSockets = new Set<WebSocket>();
  #status: ConnectionStatus = 'stopped';
  #detail = '未启动';
  #boundPort = 0;

  constructor(config: HttpServerConnection, host: ConstructorParameters<typeof NetworkAdapter>[2]) {
    super('http-server', config, host);
  }

  protected override runtimeFingerprint(config: AnyConnection): string {
    const typed = config as HttpServerConnection;
    return JSON.stringify([typed.host, typed.port, typed.enableWs]);
  }

  async start(): Promise<void> {
    const config = this.config as HttpServerConnection;
    this.#status = 'starting';
    const server = http.createServer((request, response) => void this.#onRequest(request, response));
    this.#server = server;
    server.on('error', (error: Error) => {
      this.#status = 'error';
      this.#detail = error.message;
      this.host.logger.failure('net:http-server', `${config.name} 监听失败`, error);
    });
    if (config.enableWs) {
      const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY, perMessageDeflate: false });
      this.#wss = wss;
      server.on('upgrade', (request, socket, head) => this.#onUpgrade(request, socket, head));
    }
    server.listen(config.port, config.host);
    await waitForListening(server);
    const address = server.address();
    this.#boundPort = typeof address === 'object' && address ? address.port : config.port;
    this.#status = 'listening';
    this.#detail = `监听 ${config.host}:${this.#boundPort}`;
    this.host.logger.info('net:http-server', `${config.name} 已监听 http://${config.host}:${this.#boundPort}`);
  }

  async stop(): Promise<void> {
    this.#status = 'stopped';
    this.#detail = '已停止';
    for (const socket of [...this.#apiSockets, ...this.#eventSockets]) {
      socket.removeAllListeners();
      socket.terminate();
    }
    this.#apiSockets.clear();
    this.#eventSockets.clear();
    const wss = this.#wss;
    this.#wss = null;
    const server = this.#server;
    this.#server = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  publish(event: Ob11EventBase): void {
    if (this.#eventSockets.size === 0) return;
    const payload = JSON.stringify(event);
    for (const socket of this.#eventSockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }

  info(): ConnectionInfo {
    const config = this.config as HttpServerConnection;
    const clients = this.#apiSockets.size + this.#eventSockets.size;
    return this.describe(this.#status, this.#detail, clients, `http://${config.host}:${this.#boundPort || config.port}`);
  }

  async #onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const config = this.config as HttpServerConnection;
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (config.cors) {
      headers['access-control-allow-origin'] = '*';
      headers['access-control-allow-headers'] = 'authorization, content-type';
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers);
      response.end();
      return;
    }

    const verdict = this.authorise(request.headers, url);
    if (!verdict.ok) {
      response.writeHead(403, { ...headers, 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(failedResponse(new Error(verdict.reason ?? 'unauthorized'))));
      return;
    }

    const action = actionFromPath(url.pathname);
    if (!action) {
      response.writeHead(404, { ...headers, 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(failedResponse(new Error('请求路径缺少动作名'))));
      return;
    }

    let params: Record<string, unknown> = {};
    let echo: unknown;
    if (request.method === 'POST' || request.method === 'PUT') {
      try {
        const body = await readBody(request);
        const parsed = body.trim() ? (JSON.parse(body) as unknown) : {};
        if (parsed && typeof parsed === 'object') {
          const frame = parsed as { params?: unknown; echo?: unknown };
          const target = frame.params && typeof frame.params === 'object' ? (frame.params as Record<string, unknown>) : (parsed as Record<string, unknown>);
          params = target;
          echo = frame.echo;
        }
      } catch (error) {
        response.writeHead(400, { ...headers, 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(failedResponse(error instanceof Error ? error : new Error('请求体不是合法 JSON'))));
        return;
      }
    } else {
      params = Object.fromEntries(url.searchParams.entries());
      echo = url.searchParams.get('echo') ?? undefined;
    }

    let payload;
    try {
      payload = await this.host.dispatch(action, params, echo, 'http');
    } catch (error) {
      payload = failedResponse(error, echo);
    }
    response.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(payload));
  }

  #onUpgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void {
    const wss = this.#wss;
    const server = this.#server;
    if (!wss || !server) {
      socket.destroy();
      return;
    }
    const url = new URL(request.url ?? '/', 'http://localhost');
    const verdict = this.authorise(request.headers, url);
    if (!verdict.ok) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const apiOnly = /\/api\/?$/.test(url.pathname);
    wss.handleUpgrade(request, socket, head, (ws) => {
      const bucket = apiOnly ? this.#apiSockets : this.#eventSockets;
      bucket.add(ws);
      this.host.logger.info('net:http-server', `Bot WS 已连接（${apiOnly ? '仅 API' : '事件流'}）`);
      if (!apiOnly) ws.send(JSON.stringify(this.host.lifecycle('connect')));
      ws.on('message', (raw) => void this.#onSocketMessage(ws, raw.toString()));
      ws.on('close', () => bucket.delete(ws));
      ws.on('error', () => bucket.delete(ws));
    });
  }

  async #onSocketMessage(socket: WebSocket, raw: string): Promise<void> {
    const request = this.parseRequest(raw);
    if (!request) return;
    let payload;
    try {
      payload = await this.host.dispatch(request.action, request.params, request.echo, 'websocket');
    } catch (error) {
      payload = failedResponse(error, request.echo);
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }
}

/** `/send_msg`, `/api/send_msg` and `/api/v11/send_msg` all address the same action. */
function actionFromPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return '';
  const last = segments[segments.length - 1] ?? '';
  return decodeURIComponent(last);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
