import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { finished } from 'node:stream/promises';
import type { ConfigStore } from '../core/config.ts';
import type { Logger } from '../core/logger.ts';
import type { Segment } from '../core/model.ts';
import type { AccountDriver, MediaPayload } from '../driver/types.ts';

export type MediaKind = 'image' | 'record' | 'file' | 'video';
export interface MediaReference {
  nativeId: string;
  kind: MediaKind;
  selector: string;
}

const KINDS = new Set(['image', 'record', 'file', 'video']);

/** Bounded admission; queued requests do not start a bridge download. */
class Limiter {
  #active = 0;
  readonly #queue: Array<() => void> = [];
  constructor(readonly concurrency: number, readonly maxQueue: number) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active >= this.concurrency) {
      if (this.#queue.length >= this.maxQueue) throw new Error('MEDIA_BUSY: 媒体队列已满');
      await new Promise<void>(resolve => this.#queue.push(resolve));
    } else this.#active++;
    try { return await operation(); }
    finally { const next = this.#queue.shift(); if (next) next(); else this.#active--; }
  }
}
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  wav: 'audio/wav', mp3: 'audio/mpeg', amr: 'audio/amr', silk: 'audio/silk',
  ogg: 'audio/ogg', opus: 'audio/ogg', pdf: 'application/pdf', txt: 'text/plain',
};

/** A locator contains no container path and selects one element, not just one message. */
export function mediaReference(nativeId: string, kind: MediaKind, selector = ''): string {
  return 'dfm:' + Buffer.from(JSON.stringify([nativeId, kind, selector])).toString('base64url');
}

export function parseMediaReference(value: string): MediaReference | null {
  if (!value.startsWith('dfm:')) return null;
  try {
    const [nativeId, kind, selector] = JSON.parse(Buffer.from(value.slice(4), 'base64url').toString()) as unknown[];
    if (typeof nativeId !== 'string' || !nativeId || typeof kind !== 'string' || !KINDS.has(kind) || typeof selector !== 'string') return null;
    return { nativeId, kind: kind as MediaKind, selector };
  } catch { return null; }
}

/** Reuse the console's HTTP listener for lazy downloads, including reverse-WS-only bots. */
export class MediaAccess {
  readonly #config: ConfigStore;
  readonly #driver: AccountDriver;
  readonly #logger: Logger;
  readonly #fallbackKey = randomBytes(32).toString('hex');
  readonly #pending = new Map<string, Promise<MediaPayload>>();
  readonly #downloads = new Limiter(2, 16);
  readonly #responses = new Limiter(4, 32);
  #boundHost = '';
  #boundPort = 0;

  constructor(config: ConfigStore, driver: AccountDriver, logger: Logger) {
    this.#config = config;
    this.#driver = driver;
    this.#logger = logger;
  }

  bind(host: string, port: number): void {
    this.#boundHost = host;
    this.#boundPort = port;
  }

  #signature(payload: string): string {
    return createHmac('sha256', this.#config.webui.token || this.#fallbackKey).update(payload).digest('base64url');
  }

  #fromTicket(ticket: string): MediaReference | null {
    const dot = ticket.lastIndexOf('.');
    if (dot < 1) return null;
    const payload = ticket.slice(0, dot);
    const signature = Buffer.from(ticket.slice(dot + 1));
    const expected = Buffer.from(this.#signature(payload));
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    return parseMediaReference('dfm:' + payload);
  }

  locate(value: string): MediaReference | null {
    const ref = parseMediaReference(value);
    if (ref) return ref;
    try {
      const match = new URL(value).pathname.match(/\/media\/([^/]+)\//);
      return match?.[1] ? this.#fromTicket(match[1]) : null;
    } catch { return null; }
  }

  url(reference: string, name = 'media'): string {
    const ref = parseMediaReference(reference);
    if (!ref) throw new Error('媒体标识无效：' + reference);
    const payload = reference.slice(4);
    let base = process.env.DUSKFOX_MEDIA_BASE_URL?.trim();
    if (!base) {
      let host = this.#boundHost || this.#config.webui.host;
      if (host === '0.0.0.0' || host === '::') host = hostname();
      if (host.includes(':') && !host.startsWith('[')) host = '[' + host + ']';
      base = 'http://' + host + ':' + (this.#boundPort || this.#config.webui.port);
    }
    return base.replace(/\/+$/, '') + '/media/' + payload + '.' + this.#signature(payload) + '/' + encodeURIComponent(name || 'media');
  }

  /** Same representation for live events, get_msg and get_forward_msg nodes. */
  decorate(nativeId: string, segments: readonly Segment[]): Segment[] {
    return segments.map(segment => {
      if (!KINDS.has(segment.type)) return segment;
      const data = { ...segment.data };
      const kind = segment.type as MediaKind;
      const existing = this.locate(String(data.file_id || '')) || this.locate(String(data.file || ''));
      const reference = existing
        ? mediaReference(existing.nativeId, existing.kind, existing.selector)
        : mediaReference(nativeId, kind);
      const name = String(data.file_name || data.name || data.file || kind).split(/[\\/]/).pop() || kind;
      const originalUrl = String(data.qq_url || data.url || '');
      if (/^https?:\/\//i.test(originalUrl) && !this.locate(originalUrl)) data.qq_url = originalUrl;
      const url = this.url(reference, name);
      delete data.path;
      return {
        ...segment,
        data: {
          ...data, file_id: reference, url,
          // AstrBot File uses url; Record/Video often read file directly.
          file: kind === 'file' ? name : url,
          ...(kind === 'file' ? { name, file_name: name } : {}),
        },
      };
    });
  }

  async read(ref: MediaReference): Promise<MediaPayload> {
    if (!this.#driver.fetchMedia) throw new Error('当前驱动不支持媒体下载');
    const key = mediaReference(ref.nativeId, ref.kind, ref.selector);
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = this.#downloads.run(() => this.#driver.fetchMedia!(ref.nativeId, ref.kind, ref.selector)).then(media => {
        if (!media) throw new Error('运行时未返回媒体内容：' + key);
        return media;
      });
      this.#pending.set(key, pending);
    }
    try { return await pending; }
    finally { if (this.#pending.get(key) === pending) this.#pending.delete(key); }
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    if (!(request.url || '').startsWith('/media/')) return false;
    try {
      return await this.#responses.run(async () => {
        if (response.destroyed) return true;
        const handled = await this.#handle(request, response);
        if (handled && !response.writableFinished && !response.destroyed) await finished(response, { cleanup: true });
        return handled;
      });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) {
        const detail = error instanceof Error ? error.message : String(error);
        response.writeHead(detail.includes('MEDIA_BUSY') ? 429 : 502, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: detail }));
      }
      return true;
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const url = new URL(request.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/media/')) return false;
    const fail = (status: number, error: string): void => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error }));
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      fail(405, '媒体接口只支持 GET/HEAD');
      return true;
    }
    const match = url.pathname.match(/^\/media\/([^/]+)\/[^/]+$/);
    const ref = match?.[1] ? this.#fromTicket(match[1]) : null;
    if (!ref) { fail(403, '媒体链接无效'); return true; }
    try {
      const media = await this.read(ref);
      const bytes = Buffer.from(media.base64, 'base64');
      const ext = media.name.split('.').pop()?.toLowerCase() || '';
      const headers: Record<string, string | number> = {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-disposition': "inline; filename*=UTF-8''" + encodeURIComponent(media.name || ref.kind),
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=3600',
      };
      let start = 0;
      let end = bytes.length - 1;
      let status = 200;
      if (request.headers.range) {
        const range = request.headers.range.match(/^bytes=(\d*)-(\d*)$/);
        if (!range || (!range[1] && !range[2])) { fail(416, '无效的 Range'); return true; }
        if (!range[1]) start = Math.max(0, bytes.length - Number(range[2]));
        else {
          start = Number(range[1]);
          if (range[2]) end = Math.min(end, Number(range[2]));
        }
        if (start > end || start >= bytes.length) {
          response.writeHead(416, { 'content-range': 'bytes */' + bytes.length });
          response.end();
          return true;
        }
        status = 206;
        headers['content-range'] = 'bytes ' + start + '-' + end + '/' + bytes.length;
      }
      headers['content-length'] = end - start + 1;
      response.writeHead(status, headers);
      response.end(request.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#logger.warn('onebot:media', detail);
      if (!response.headersSent && !response.destroyed) fail(detail.includes('MEDIA_BUSY') ? 429 : detail.includes('MEDIA_NOT_READY') ? 409 : 502, detail);
    }
    return true;
  }
}
