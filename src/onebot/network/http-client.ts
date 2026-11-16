import type { AnyConnection, HttpClientConnection } from '../../core/config.ts';
import type { Ob11EventBase } from '../types.ts';
import { NetworkAdapter, type ConnectionInfo, type ConnectionStatus } from './base.ts';

const MAX_QUEUE = 500;

/**
 * HTTP client reporting: every event is POSTed to a bot framework endpoint.
 *
 * OneBot v11 reporting is one directional (events out, actions in through some
 * other transport), which is exactly what this adapter implements. Failed
 * reports are retried a bounded number of times so a stalled endpoint cannot
 * grow memory without limit.
 */
export class HttpClientAdapter extends NetworkAdapter {
  #queue: Ob11EventBase[] = [];
  #draining = false;
  #status: ConnectionStatus = 'stopped';
  #detail = '未启动';
  #sent = 0;
  #failed = 0;
  #lastError = '';

  constructor(config: HttpClientConnection, host: ConstructorParameters<typeof NetworkAdapter>[2]) {
    super('http-client', config, host);
  }

  protected override runtimeFingerprint(config: AnyConnection): string {
    const typed = config as HttpClientConnection;
    return JSON.stringify([typed.url]);
  }

  async start(): Promise<void> {
    const config = this.config as HttpClientConnection;
    if (!config.url) {
      this.#status = 'error';
      this.#detail = '未配置上报地址';
      return;
    }
    this.#status = 'connected';
    this.#detail = `上报至 ${config.url}`;
    this.host.logger.info('net:http-client', `${config.name} 事件上报已启用`);
  }

  async stop(): Promise<void> {
    this.#queue = [];
    this.#status = 'stopped';
    this.#detail = '已停止';
  }

  publish(event: Ob11EventBase): void {
    const config = this.config as HttpClientConnection;
    if (!config.url) return;
    this.#queue.push(event);
    if (this.#queue.length > MAX_QUEUE) this.#queue.shift();
    void this.#drain();
  }

  info(): ConnectionInfo {
    const config = this.config as HttpClientConnection;
    const suffix = this.#lastError ? `（最近错误：${this.#lastError}）` : '';
    return this.describe(this.#status, `${this.#detail} · 已发 ${this.#sent} · 失败 ${this.#failed}${suffix}`, 0, config.url || undefined);
  }

  async #drain(): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    const config = this.config as HttpClientConnection;
    try {
      while (this.#queue.length > 0) {
        const event = this.#queue.shift();
        if (!event) break;
        let delivered = false;
        for (let attempt = 0; attempt <= config.retries && !delivered; attempt += 1) {
          try {
            await this.#post(config, event);
            delivered = true;
            this.#sent += 1;
            this.#status = 'connected';
          } catch (error) {
            this.#lastError = error instanceof Error ? error.message : String(error);
            if (attempt < config.retries) await delay(200 * (attempt + 1));
          }
        }
        if (!delivered) {
          this.#failed += 1;
          this.#status = 'error';
          this.#detail = `上报失败：${this.#lastError}`;
          this.host.logger.warn('net:http-client', `${config.name} 上报失败：${this.#lastError}`);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  async #post(config: HttpClientConnection, event: Ob11EventBase): Promise<void> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'X-Self-ID': String(this.host.selfId()),
      'X-Client-Role': 'Universal',
      'User-Agent': 'duskfox',
    };
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(config.timeout),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.arrayBuffer().catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
