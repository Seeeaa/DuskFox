import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebuiContext } from './context.ts';
import { createRouter } from './routes/index.ts';
import { Router, sendJson } from './http.ts';
import { extractToken, isAdminToken, TICKET_ROUTES } from './auth.ts';
import { isWithin } from '../core/paths.ts';
import { attachOfficialView, registerOfficialView } from './official-view.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const PUBLIC_ROUTES = new Set(['/api/auth/login']);

export interface ConsoleServerOptions {
  readonly context: WebuiContext;
  readonly assetsDir: string;
}

/**
 * Console web server: static shell, JSON API, SSE stream.
 *
 * Every `/api` route except login requires a bearer token; the HTML shell is
 * public so the login screen can render, but it refuses to show data without a
 * valid session.
 */
export class ConsoleServer {
  readonly #context: WebuiContext;
  readonly #assetsDir: string;
  readonly #router: Router;
  #server: http.Server | null = null;
  #host = '127.0.0.1';
  #port = 0;

  constructor(options: ConsoleServerOptions) {
    this.#context = options.context;
    this.#assetsDir = options.assetsDir;
    this.#router = createRouter(options.context);
    registerOfficialView(this.#router);
  }

  get host(): string {
    return this.#host;
  }

  get port(): number {
    return this.#port;
  }

  async start(host: string, port: number): Promise<{ host: string; port: number }> {
    const server = http.createServer((request, response) => void this.#onRequest(request, response));
    this.#server = server;
    attachOfficialView(server, this.#context, (request) => this.#accessible(request, new URL('http://localhost/')));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE') {
          reject(new Error(`控制台端口 ${port} 已被占用，请修改 config/webui.json 或使用 --port 指定其他端口`));
          return;
        }
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    const address = server.address();
    this.#host = typeof address === 'object' && address ? address.address : host;
    this.#port = typeof address === 'object' && address ? address.port : port;
    this.#context.service.media.bind(this.#host, this.#port);
    this.#context.logger.info('webui', `控制台已监听 http://${this.#host}:${this.#port}`);
    return { host: this.#host, port: this.#port };
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#context.logger.info('webui', '控制台已停止');
  }

  async #onRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (await this.#context.service.media.handle(request, response)) return;
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (!this.#accessible(request, url)) {
        sendJson(response, 403, { ok: false, error: '来源地址不在白名单内' });
        return;
      }
      if (!PUBLIC_ROUTES.has(url.pathname) && !this.#authorised(request, url)) {
        sendJson(response, 401, { ok: false, error: '未登录或会话已过期' });
        return;
      }
      const handled = await this.#router.handle(request, response);
      if (!handled) sendJson(response, 404, { ok: false, error: '接口不存在' });
      return;
    }
    this.#serveStatic(url.pathname, response, request);
  }

  #accessible(request: IncomingMessage, _url: URL): boolean {
    const allowlist = this.#context.config.webui.allowlist;
    if (allowlist.length === 0) return true;
    const address = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    return allowlist.some((allowed) => allowed === address);
  }

  #authorised(request: IncomingMessage, url: URL): boolean {
    const token = extractToken(request.headers);
    if (token) {
      if (isAdminToken(token, this.#context.config.webui.token)) return true;
      if (this.#context.sessions.touch(token)) return true;
    }
    // Downloads and EventSource cannot send headers; they use a scoped ticket.
    const ticket = url.searchParams.get('ticket');
    const scope = TICKET_ROUTES[url.pathname];
    if (ticket && scope) return this.#context.tickets.redeem(ticket, scope);
    return false;
  }

  #serveStatic(pathname: string, response: ServerResponse, request: IncomingMessage): void {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET' });
      response.end();
      return;
    }
    const decoded = decodeURIComponent(pathname);
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const absolute = path.resolve(this.#assetsDir, relative);
    if (!isWithin(this.#assetsDir, absolute) || !fs.existsSync(absolute)) {
      // Fall back to the shell so an unknown deep link still loads the console.
      const shell = path.join(this.#assetsDir, 'index.html');
      if (!fs.existsSync(shell)) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('控制台资源缺失：webui/index.html');
        return;
      }
      this.#sendFile(shell, response, request);
      return;
    }
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      const index = path.join(absolute, 'index.html');
      if (!fs.existsSync(index)) {
        response.writeHead(403);
        response.end();
        return;
      }
      this.#sendFile(index, response, request);
      return;
    }
    this.#sendFile(absolute, response, request);
  }

  #sendFile(file: string, response: ServerResponse, request: IncomingMessage): void {
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const stat = fs.statSync(file);
    response.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': type.startsWith('text/html') ? 'no-store' : 'no-cache',
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(file).pipe(response);
  }
}
