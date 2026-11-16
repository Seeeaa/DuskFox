import { WebSocket } from 'ws';
import type { AnyConnection, WsClientConnection } from '../../core/config.ts';
import type { Ob11EventBase } from '../types.ts';
import { failedResponse } from '../types.ts';
import { NetworkAdapter, type ConnectionInfo, type ConnectionStatus } from './base.ts';

const MAX_BACKLOG = 200;

/** Reverse WebSocket client: the framework dials out to a bot framework. */
export class WsClientAdapter extends NetworkAdapter {
  #socket: WebSocket | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #status: ConnectionStatus = 'stopped';
  #detail = '未启动';
  #attempts = 0;
  #backlog: Ob11EventBase[] = [];
  #closed = false;

  constructor(config: WsClientConnection, host: ConstructorParameters<typeof NetworkAdapter>[2]) {
    super('ws-client', config, host);
  }

  protected override runtimeFingerprint(config: AnyConnection): string {
    const typed = config as WsClientConnection;
    return JSON.stringify([typed.url, typed.reconnect]);
  }

  async start(): Promise<void> {
    this.#closed = false;
    this.#connect();
  }

  async stop(): Promise<void> {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#backlog = [];
    const socket = this.#socket;
    this.#socket = null;
    this.#status = 'stopped';
    this.#detail = '已停止';
    if (socket) {
      socket.removeAllListeners();
      socket.terminate();
    }
  }

  publish(event: Ob11EventBase): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.#backlog.push(event);
      if (this.#backlog.length > MAX_BACKLOG) this.#backlog.shift();
      return;
    }
    socket.send(JSON.stringify(event));
  }

  info(): ConnectionInfo {
    const config = this.config as WsClientConnection;
    return this.describe(this.#status, this.#detail, this.#status === 'connected' ? 1 : 0, config.url || undefined);
  }

  #connect(): void {
    if (this.#closed) return;
    const config = this.config as WsClientConnection;
    if (!config.url) {
      this.#status = 'error';
      this.#detail = '未配置连接地址';
      return;
    }
    this.#status = 'connecting';
    this.#detail = `连接 ${config.url}`;
    const headers: Record<string, string> = {
      'X-Self-ID': String(this.host.selfId()),
      'X-Client-Role': 'Universal',
      'User-Agent': 'duskfox',
    };
    if (config.token) headers.authorization = `Bearer ${config.token}`;
    const socket = new WebSocket(config.url, { headers, handshakeTimeout: 8000, maxPayload: 1024 * 1024, perMessageDeflate: false });
    this.#socket = socket;

    socket.on('open', () => {
      this.#attempts = 0;
      this.#status = 'connected';
      this.#detail = `已连接 ${config.url}`;
      this.host.logger.info('net:ws-client', `${config.name} 已连接 ${config.url}`);
      socket.send(JSON.stringify(this.host.lifecycle('connect')));
      const backlog = this.#backlog;
      this.#backlog = [];
      for (const event of backlog) socket.send(JSON.stringify(event));
    });

    socket.on('message', (raw) => void this.#onMessage(raw.toString()));
    socket.on('close', () => {
      if (this.#socket === socket) this.#socket = null;
      this.#status = this.#closed ? 'stopped' : 'connecting';
      if (!this.#closed) this.#scheduleReconnect(config);
    });
    socket.on('error', (error) => {
      this.#status = 'error';
      this.#detail = error.message;
    });
  }

  #scheduleReconnect(config: WsClientConnection): void {
    if (this.#closed || this.#reconnectTimer) return;
    this.#attempts += 1;
    const delay = Math.min(config.reconnect * Math.max(1, this.#attempts), 60_000);
    this.host.logger.warn('net:ws-client', `${config.name} 断开，${Math.round(delay / 1000)} 秒后重连`);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  async #onMessage(raw: string): Promise<void> {
    const request = this.parseRequest(raw);
    if (!request) return;
    const socket = this.#socket;
    if (!socket) return;
    let response;
    try {
      response = await this.host.dispatch(request.action, request.params, request.echo, 'websocket');
    } catch (error) {
      response = failedResponse(error, request.echo);
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  }
}
