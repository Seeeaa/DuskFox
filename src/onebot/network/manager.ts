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
      const needsRestart = existing.applyConfig(target.config);
      if (needsRestart) {
        this.#logger.info('net', `${target.kind} 绑定参数变更，正在重启`);
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
    } catch (error) {
      this.#logger.failure('net', `${kind} ${config.name || config.id} 启动失败`, error);
    }
  }

  async #despawn(key: string): Promise<void> {
    const adapter = this.#adapters.get(key);
    if (!adapter) return;
    this.#adapters.delete(key);
    try {
      await adapter.stop();
    } catch (error) {
      this.#logger.failure('net', `${adapter.kind} 停止失败`, error);
    }
  }
}
