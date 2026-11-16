import type { Logger } from '../../core/logger.ts';
import type { OnebotConfig } from '../../core/config.ts';
import type { AnyConnection, NetworkKind } from '../../core/config.ts';
import type { Ob11EventBase, Ob11Response, TransportName } from '../types.ts';
import { tokenEquals } from '../../core/tokens.ts';

export type ReloadMode = 'noop' | 'restart';

export type ConnectionStatus = 'stopped' | 'starting' | 'listening' | 'connecting' | 'connected' | 'error';

/** Snapshot consumed by the console network page. */
export interface ConnectionInfo {
  readonly kind: NetworkKind;
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly status: ConnectionStatus;
  readonly detail: string;
  /** Open bot sockets / streams. */
  readonly clients: number;
  /** Human readable endpoint once the adapter is listening. */
  readonly address?: string;
}

export interface NetworkHost {
  readonly logger: Logger;
  readonly config: () => OnebotConfig;
  /** Numeric self id, 0 while offline. */
  readonly selfId: () => number;
  readonly online: () => boolean;
  /** Dispatch an action coming from a bot connection. */
  readonly dispatch: (
    action: string,
    params: Record<string, unknown>,
    echo: unknown,
    transport: TransportName,
  ) => Promise<Ob11Response>;
  /** Build a lifecycle event for a single connection. */
  readonly lifecycle: (subtype: 'connect' | 'enable' | 'disable') => Ob11EventBase;
}

/**
 * Everything a bot-facing transport shares: auth, JSON framing and the
 * `{action, params, echo}` request shape.
 */
export abstract class NetworkAdapter {
  readonly kind: NetworkKind;
  config: AnyConnection;
  protected readonly host: NetworkHost;

  constructor(kind: NetworkKind, config: AnyConnection, host: NetworkHost) {
    this.kind = kind;
    this.config = config;
    this.host = host;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  /** Deliver an event to every subscribed bot. */
  abstract publish(event: Ob11EventBase): void;
  abstract info(): ConnectionInfo;

  /**
   * Fields that cannot change without rebinding the socket. Only a change here
   * forces a restart; editing a token or a display name is applied in place so
   * bots stay connected (the behaviour NapCat's config hot reload provides).
   */
  protected runtimeFingerprint(config: AnyConnection): string {
    return JSON.stringify(config);
  }

  /**
   * Apply an updated config. Returns true when the caller must restart this
   * adapter because a binding field changed.
   */
  applyConfig(next: AnyConnection): boolean {
    const previous = this.config;
    this.config = next;
    return this.runtimeFingerprint(previous) !== this.runtimeFingerprint(next);
  }

  /**
   * Decide whether a request may proceed.
   * An empty token on the connection disables auth, matching OneBot practice
   * for loopback-only deployments.
   */
  protected authorise(headers: Record<string, string | string[] | undefined>, url: URL): { ok: boolean; reason?: string } {
    const token = this.config.token?.trim();
    if (!token) return { ok: true };
    const header = headers.authorization;
    const bearer = Array.isArray(header) ? header[0] : header;
    const supplied = bearer?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('access_token') ?? url.searchParams.get('token') ?? '';
    return tokenEquals(String(supplied), token) ? { ok: true } : { ok: false, reason: '令牌无效' };
  }

  /** Parse a bot request; returns null when the frame is not an action call. */
  protected parseRequest(raw: string): { action: string; params: Record<string, unknown>; echo: unknown } | null {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;
    const frame = payload as { action?: unknown; params?: unknown; echo?: unknown };
    if (typeof frame.action !== 'string' || !frame.action) return null;
    const params = frame.params && typeof frame.params === 'object' ? (frame.params as Record<string, unknown>) : {};
    return { action: frame.action, params, echo: frame.echo };
  }

  protected describe(status: ConnectionStatus, detail: string, clients: number, address?: string): ConnectionInfo {
    return {
      kind: this.kind,
      id: this.config.id,
      name: this.config.name || this.kind,
      enabled: this.config.enabled,
      status,
      detail,
      clients,
      ...(address ? { address } : {}),
    };
  }
}

/** Small helper so adapters can `await` a listening event without leaking listeners. */
export function waitForListening(server: { once: (event: string, listener: (...args: any[]) => void) => unknown }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (error: unknown) => reject(error));
  });
}
