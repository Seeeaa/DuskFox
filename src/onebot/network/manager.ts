import type { AnyConnection, ConfigChange, NetworkConfig, NetworkKind } from '../../core/config.ts';
import { NETWORK_KINDS } from '../../core/config.ts';
import type { Logger } from '../../core/logger.ts';
import type { Ob11EventBase } from '../types.ts';
import type { ConnectionInfo, NetworkHost } from './base.ts';
import { NetworkAdapter } from './base.ts';
import { HttpServerAdapter } from './http-server.ts';
import { HttpClientAdapter } from './http-client.ts';
import { SseAdapter } from './sse.ts';
import { WsServerAdapter } from './ws-server.ts';
import { WsClientAdapter } from './ws-client.ts';

function createAdapter(kind: NetworkKind, config: AnyConnection, host: NetworkHost): NetworkAdapter {
  switch (kind) {
    case 'http-server':
      return new HttpServerAdapter(config as never, host);
    case 'http-client':
      return new HttpClientAdapter(config as never, host);
    case 'sse':
      return new SseAdapter(config as never, host);
    case 'ws-server':
      return new WsServerAdapter(config as never, host);
    case 'ws-client':
      return new WsClientAdapter(config as never, host);
  }
}

/**
 * Owns every bot facing transport for one instance.
 *
 * Connections are keyed by `kind/id`, so a config edit is reconciled against
 * the live set: removed connections stop, edits either restart the adapter
 * (binding fields changed) or apply in place (token, name), and new ones start.
 */
export class NetworkManager {
  readonly #host: NetworkHost;
  readonly #logger: Logger;
  readonly #network: () => NetworkConfig;
  readonly #adapters = new Map<string, NetworkAdapter>();
  readonly #retries = new Map<string, { timer: NodeJS.Timeout; attempts: number }>();
  #started = false;

  constructor(host: NetworkHost, logger: Logger, network: () => NetworkConfig) {
    this.#host = host;
    this.#logger = logger;
    this.#network = network;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const network = this.#network();
    for (const kind of NETWORK_KINDS) {
      for (const entry of network[kind] as AnyConnection[]) {
        if (!entry.enabled) continue;
        await this.#spawn(kind, entry);
      }
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    for (const key of [...this.#retries.keys()]) this.#clearRetry(key);
    const adapters = [...this.#adapters.values()];
    this.#adapters.clear();
    await Promise.all(adapters.map((adapter) => adapter.stop().catch((error: unknown) => {
      this.#logger.failure('net', `停止 ${adapter.kind} 失败`, error);
    })));
  }

  /** Reconcile the live adapters with the new configuration. */
  async apply(change: ConfigChange): Promise<void> {
    if (change.section !== 'network') return;
    if (change.fullReload) {
      await this.stop();
      this.#started = true;
      await this.startInternal();
      return;
    }
    const network = this.#network();
    const desired = new Map<string, { kind: NetworkKind; config: AnyConnection }>();
    for (const kind of NETWORK_KINDS) {
      for (const entry of network[kind] as AnyConnection[]) desired.set(`${kind}/${entry.id}`, { kind, config: entry });
    }

    // Stop adapters whose entry disappeared or was disabled.
    for (const [key, adapter] of [...this.#adapters]) {
      const target = desired.get(key);
      if (!target || !target.config.enabled) {
        await this.#despawn(key);
      }
    }

    for (const [key, target] of desired) {
      if (!target.config.enabled) continue;
      const existing = this.#adapters.get(key);
      if (!existing) {
        await this.#spawn(target.kind, target.config);
        continue;
      }
      const errored = (() => {
        try {
          return existing.info().status === 'error';
        } catch {
          return true;
        }
      })();
      const needsRestart = existing.applyConfig(target.config) || errored;
      if (needsRestart) {
        this.#logger.info('net', `${target.kind} 重启（${errored ? '上次启动失败' : '绑定参数变更'}）`);
        await this.#despawn(key);
        await this.#spawn(target.kind, target.config);
      }
    }
  }

  publish(event: Ob11EventBase): void {
    for (const adapter of this.#adapters.values()) {
      try {
        adapter.publish(event);
      } catch (error) {
        this.#logger.failure('net', `${adapter.kind} 推送事件失败`, error);
      }
    }
  }

  connections(): ConnectionInfo[] {
    return [...this.#adapters.values()]
      .map((adapter) => {
        try {
          return adapter.info();
        } catch {
          return null;
        }
      })
      .filter((info): info is ConnectionInfo => info !== null);
  }

  /** Open bot sockets across every transport. */
  clientCount(): number {
    return this.connections().reduce((total, info) => total + info.clients, 0);
  }

  async startInternal(): Promise<void> {
    const network = this.#network();
    for (const kind of NETWORK_KINDS) {
      for (const entry of network[kind] as AnyConnection[]) {
        if (!entry.enabled) continue;
        await this.#spawn(kind, entry);
      }
    }
  }

  async #spawn(kind: NetworkKind, config: AnyConnection): Promise<void> {
    const key = `${kind}/${config.id}`;
    if (this.#adapters.has(key)) return;
    const adapter = createAdapter(kind, config, this.#host);
    this.#adapters.set(key, adapter);
    try {
      await adapter.start();
      this.#clearRetry(key);
    } catch (error) {
      this.#logger.failure('net', `${kind} ${config.name || config.id} 启动失败`, error);
      this.#scheduleRetry(key);
    }
  }

  async #despawn(key: string): Promise<void> {
    this.#clearRetry(key);
    const adapter = this.#adapters.get(key);
    if (!adapter) return;
    this.#adapters.delete(key);
    try {
      await adapter.stop();
    } catch (error) {
      this.#logger.failure('net', `${adapter.kind} 停止失败`, error);
    }
  }

  /**
   * A listener that failed to bind (port taken, interface missing, WS client
   * dial failure) must not stay dead: retry with capped backoff until it binds
   * or the connection is disabled/removed. Config edits reset the backoff.
   */
  #scheduleRetry(key: string): void {
    const existing = this.#retries.get(key);
    if (existing) clearTimeout(existing.timer);
    const attempts = (existing?.attempts ?? 0) + 1;
    const delay = Math.min(1000 * 2 ** (attempts - 1), 15_000);
    const timer = setTimeout(() => {
      this.#retries.delete(key);
      if (!this.#started) return;
      const adapter = this.#adapters.get(key);
      if (!adapter) return;
      if (!adapter.config.enabled) return;
      this.#logger.info('net', `重试启动 ${key}（第 ${attempts} 次）`);
      void this.#restartAdapter(key);
    }, delay);
    timer.unref?.();
    this.#retries.set(key, { timer, attempts });
  }

  async #restartAdapter(key: string): Promise<void> {
    const adapter = this.#adapters.get(key);
    if (!adapter) return;
    const kind = adapter.kind;
    const config = adapter.config;
    this.#adapters.delete(key);
    try {
      await adapter.stop();
    } catch {
      // A failed start usually leaves nothing to stop.
    }
    await this.#spawn(kind, config);
  }

  #clearRetry(key: string): void {
    const entry = this.#retries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#retries.delete(key);
  }
}
