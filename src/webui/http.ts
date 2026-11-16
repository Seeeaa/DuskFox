import type { IncomingMessage, ServerResponse } from 'node:http';

export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  /** Lazily parsed JSON body (empty object when absent). */
  body(): Promise<Record<string, unknown>>;
}

export interface Route {
  readonly method: Method;
  readonly pattern: string;
  readonly handler: (context: RequestContext) => Promise<void> | void;
}

const MAX_BODY = 2 * 1024 * 1024;

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'HttpError';
  }
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendText(res: ServerResponse, statusCode: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(statusCode, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

/** Append a download header to a text response. */
export function sendAttachment(res: ServerResponse, filename: string, body: string, contentType = 'application/json; charset=utf-8'): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Tiny path router.
 *
 * Patterns use `:` segments (`/api/action/:name`). Handlers only need to write
 * a response; errors thrown as {@link HttpError} become JSON error replies.
 */
export class Router {
  readonly #routes: Route[] = [];
  readonly #fallback: ((context: RequestContext) => Promise<boolean> | boolean) | null;

  constructor(fallback?: (context: RequestContext) => Promise<boolean> | boolean) {
    this.#fallback = fallback ?? null;
  }

  add(method: Method, pattern: string, handler: Route['handler']): this {
    this.#routes.push({ method, pattern, handler });
    return this;
  }

  get(pattern: string, handler: Route['handler']): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Route['handler']): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: Route['handler']): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: Route['handler']): this {
    return this.add('DELETE', pattern, handler);
  }

  /** Returns true when the request was handled. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    for (const route of this.#routes) {
      if (route.method !== (req.method as Method)) continue;
      const params = match(route.pattern, pathname);
      if (!params) continue;
      let cachedBody: Record<string, unknown> | null = null;
      const context: RequestContext = {
        req,
        res,
        url,
        params,
        body: async () => {
          if (cachedBody) return cachedBody;
          const text = await readBody(req);
          if (!text.trim()) {
            cachedBody = {};
            return cachedBody;
          }
          try {
            const parsed = JSON.parse(text) as unknown;
            cachedBody = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
          } catch {
            throw new HttpError(400, '请求体不是合法的 JSON');
          }
          return cachedBody;
        },
      };
      try {
        await route.handler(context);
      } catch (error) {
        if (res.headersSent) {
          res.end();
          return true;
        }
        if (error instanceof HttpError) {
          sendJson(res, error.statusCode, { ok: false, error: error.message });
          return true;
        }
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return true;
    }
    if (this.#fallback) return this.#fallback({ req, res, url, params: {}, body: async () => ({}) });
    return false;
  }
}

function match(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index] ?? '';
    const actual = pathParts[index] ?? '';
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

/** Typed accessors for request bodies. */
export function expectString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string') throw new HttpError(400, `字段 ${key} 必须是字符串`);
  return value;
}

export function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, `字段 ${key} 必须是字符串`);
  return value;
}
