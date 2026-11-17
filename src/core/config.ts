import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { RuntimePaths } from './paths.ts';
import type { Logger } from './logger.ts';
import { createId, createToken } from './tokens.ts';

/* -------------------------------------------------------------------------- */
/* Schemas                                                                     */
/* -------------------------------------------------------------------------- */

export const WebuiConfigSchema = Type.Object({
  /** Interface the console binds to. Loopback by default. */
  host: Type.String({ default: '127.0.0.1' }),
  /** Console port; 0 asks the OS for a free port (handy for tests). */
  port: Type.Integer({ default: 6099, minimum: 0, maximum: 65535 }),
  /** Bearer token required by every console request. Generated on first run. */
  token: Type.String({ default: '' }),
  /** Idle session length in minutes, 0 disables expiry. */
  sessionMinutes: Type.Integer({ default: 120, minimum: 0 }),
  /** Optional client address allow list (IPv4/IPv6 literals). */
  allowlist: Type.Array(Type.String(), { default: [] }),
});
export type WebuiConfig = Static<typeof WebuiConfigSchema>;

export const OnebotConfigSchema = Type.Object({
  /** `array` sends message segments, `string` sends CQ code strings. */
  messagePostFormat: Type.Union([Type.Literal('array'), Type.Literal('string')], { default: 'array' }),
  /** Emit message events for messages this account itself sent. */
  reportSelfMessage: Type.Boolean({ default: false }),
  /** meta_event.heartbeat period in milliseconds. */
  heartbeatIntervalMs: Type.Integer({ default: 30000, minimum: 1000 }),
  /** How numeric message ids are produced. */
  messageIdMode: Type.Union([Type.Literal('hash'), Type.Literal('seq')], { default: 'hash' }),
  /** Attach the driver payload to each event as `raw`. */
  debug: Type.Boolean({ default: false }),
  /** Event families published to bot connections. */
  events: Type.Object({
    privateMessage: Type.Boolean({ default: true }),
    groupMessage: Type.Boolean({ default: true }),
    metaEvent: Type.Boolean({ default: true }),
    notice: Type.Boolean({ default: true }),
    request: Type.Boolean({ default: true }),
  }, { default: {} }),
});
export type OnebotConfig = Static<typeof OnebotConfigSchema>;

const ConnectionBase = {
  /** Stable identifier, generated when a connection is created. */
  id: Type.String({ default: '' }),
  name: Type.String({ default: '' }),
  enabled: Type.Boolean({ default: false }),
  /** Shared secret clients must present (empty disables auth for that socket). */
  token: Type.String({ default: '' }),
};

export const HttpServerSchema = Type.Object({
  ...ConnectionBase,
  host: Type.String({ default: '127.0.0.1' }),
  port: Type.Integer({ default: 3000, minimum: 0, maximum: 65535 }),
  /** Allow cross origin action calls from browsers. */
  cors: Type.Boolean({ default: false }),
  /** Mount a WebSocket endpoint on the same port as the HTTP API. */
  enableWs: Type.Boolean({ default: true }),
  messagePostFormat: Type.Optional(Type.Union([Type.Literal('array'), Type.Literal('string')])),
});
export type HttpServerConnection = Static<typeof HttpServerSchema>;

export const HttpClientSchema = Type.Object({
  ...ConnectionBase,
  url: Type.String({ default: '' }),
  /** Per request timeout for event reports. */
  timeout: Type.Integer({ default: 5000, minimum: 200 }),
  /** Attempts per event before it is dropped. */
  retries: Type.Integer({ default: 2, minimum: 0, maximum: 10 }),
});
export type HttpClientConnection = Static<typeof HttpClientSchema>;

export const SseServerSchema = Type.Object({
  ...ConnectionBase,
  host: Type.String({ default: '127.0.0.1' }),
  port: Type.Integer({ default: 3001, minimum: 0, maximum: 65535 }),
});
export type SseServerConnection = Static<typeof SseServerSchema>;

export const WsServerSchema = Type.Object({
  ...ConnectionBase,
  host: Type.String({ default: '127.0.0.1' }),
  port: Type.Integer({ default: 3002, minimum: 0, maximum: 65535 }),
});
export type WsServerConnection = Static<typeof WsServerSchema>;

export const WsClientSchema = Type.Object({
  ...ConnectionBase,
  url: Type.String({ default: '' }),
  heartbeat: Type.Integer({ default: 30000, minimum: 0 }),
  reconnect: Type.Integer({ default: 5000, minimum: 500 }),
});
export type WsClientConnection = Static<typeof WsClientSchema>;

export const NetworkConfigSchema = Type.Object({
  'http-server': Type.Array(HttpServerSchema, { default: [] }),
  'http-client': Type.Array(HttpClientSchema, { default: [] }),
  sse: Type.Array(SseServerSchema, { default: [] }),
  'ws-server': Type.Array(WsServerSchema, { default: [] }),
  'ws-client': Type.Array(WsClientSchema, { default: [] }),
});
export type NetworkConfig = Static<typeof NetworkConfigSchema>;
export type NetworkKind = keyof NetworkConfig;
export type AnyConnection = HttpServerConnection | HttpClientConnection | SseServerConnection | WsServerConnection | WsClientConnection;

export const NETWORK_KINDS: readonly NetworkKind[] = ['http-server', 'http-client', 'sse', 'ws-server', 'ws-client'];

/** Kinds the current build can actually serve end to end. */
export const IMPLEMENTED_KINDS: ReadonlySet<NetworkKind> = new Set<NetworkKind>([
  'http-server',
  'http-client',
  'ws-server',
  'ws-client',
  'sse',
]);

export type ConfigSection = 'webui' | 'onebot' | 'network';

export interface ConfigChange {
  readonly section: ConfigSection;
  /** Connection ids that disappeared, appeared or were edited. */
  readonly changedConnections: string[];
  readonly fullReload: boolean;
}

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                          */
/* -------------------------------------------------------------------------- */

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function describeIssues(schema: TSchema, value: unknown): string[] {
  const issues: string[] = [];
  for (const error of Value.Errors(schema, value)) {
    const where = error.path === '' ? '(root)' : error.path.replace(/^\//, '').replace(/\//g, '.');
    issues.push(`${where}: ${error.message}`);
    if (issues.length >= 12) break;
  }
  return issues;
}

/**
 * Fill defaults, coerce forgiving input ("3000" -> 3000) and drop unknown keys.
 * Everything the console submits is a string; the console must never have to
 * care about JSON types.
 */
export function normalise<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const withDefaults = Value.Default(schema, Value.Clone(raw as never)) as unknown;
  const coerced = Value.Convert(schema, withDefaults) as unknown;
  const cleaned = Value.Clean(schema, coerced) as unknown;
  if (!Value.Check(schema, cleaned)) {
    throw new ConfigError('配置校验失败', describeIssues(schema, cleaned));
  }
  return cleaned as Static<T>;
}

function readJsonFile(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON5.parse(text);
  } catch (error) {
    throw new ConfigError(`${path.basename(file)} 不是合法的 JSON5`, [error instanceof Error ? error.message : String(error)]);
  }
}

/** Write atomically so a crash can never leave a half written config behind. */
export function writeJsonAtomic(file: string, data: unknown, mode = 0o600): void {
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode });
  fs.renameSync(temp, file);
}

function assignIds<T extends { id: string }>(entries: T[], prefix: string): boolean {
  let mutated = false;
  for (const entry of entries) {
    if (!entry.id) {
      entry.id = createId(prefix);
      mutated = true;
    }
  }
  return mutated;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

const SECTION_FILES: Record<ConfigSection, string> = {
  webui: 'webui.json',
  onebot: 'onebot.json',
  network: 'network.json',
};

/**
 * Configuration owner for one instance.
 *
 * Files are JSON5 so operators can comment them, but every write is normalised
 * JSON. Changes are announced through {@link onChange} so services can hot
 * reload instead of restarting the process.
 */
export class ConfigStore {
  readonly #paths: RuntimePaths;
  readonly #logger: Logger;
  readonly #listeners = new Set<(change: ConfigChange) => void>();
  #webui!: WebuiConfig;
  #onebot!: OnebotConfig;
  #network!: NetworkConfig;

  constructor(paths: RuntimePaths, logger: Logger) {
    this.#paths = paths;
    this.#logger = logger;
  }

  get webui(): WebuiConfig {
    return this.#webui;
  }

  get onebot(): OnebotConfig {
    return this.#onebot;
  }

  get network(): NetworkConfig {
    return this.#network;
  }

  fileOf(section: ConfigSection): string {
    return path.join(this.#paths.config, SECTION_FILES[section]);
  }

  onChange(listener: (change: ConfigChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Read every file, create defaults, and repair missing ids. */
  load(): void {
    this.#webui = this.#loadSection('webui', WebuiConfigSchema);
    this.#onebot = this.#loadSection('onebot', OnebotConfigSchema);
    this.#network = this.#loadSection('network', NetworkConfigSchema);

    let dirty = false;
    if (!this.#webui.token) {
      this.#webui.token = createToken();
      dirty = true;
      this.#logger.info('config', '已生成新的控制台令牌，写入 config/webui.json');
    }
    for (const kind of NETWORK_KINDS) {
      if (assignIds(this.#network[kind] as { id: string }[], kind)) dirty = true;
    }
    if (dirty) {
      this.save('webui');
      this.save('network');
    }
    this.#logger.info('config', `配置已载入：${this.#paths.config}`);
  }

  /** Re-read a single section from disk (used after an external edit). */
  reload(section: ConfigSection): ConfigChange | null {
    try {
      if (section === 'webui') {
        const next = this.#loadSection('webui', WebuiConfigSchema);
        this.#webui = next;
      } else if (section === 'onebot') {
        this.#onebot = this.#loadSection('onebot', OnebotConfigSchema);
      } else {
        this.#network = this.#loadSection('network', NetworkConfigSchema);
      }
      const change: ConfigChange = { section, changedConnections: [], fullReload: true };
      this.#announce(change);
      return change;
    } catch (error) {
      this.#logger.failure('config', `重新载入 ${section} 失败（继续使用内存中的配置）`, error);
      return null;
    }
  }

  /**
   * Update the OneBot section (partial objects are merged into the current
   * values, so a script can flip one switch without restating everything),
   * persist it, and notify listeners.
   */
  saveOnebot(raw: unknown): ConfigChange {
    const previous = this.#onebot;
    const merged = raw && typeof raw === 'object' ? { ...this.#onebot, ...(raw as Record<string, unknown>) } : raw;
    this.#onebot = normalise(OnebotConfigSchema, merged);
    writeJsonAtomic(this.fileOf('onebot'), this.#onebot);
    const change: ConfigChange = {
      section: 'onebot',
      changedConnections: [],
      fullReload: JSON.stringify(previous) !== JSON.stringify(this.#onebot),
    };
    this.#logger.info('config', 'OneBot 配置已保存');
    this.#announce(change);
    return change;
  }

  /**
   * Replace the network section, persist it, and report which connections
   * changed so the manager can reload only what is affected.
   */
  saveNetwork(raw: unknown): ConfigChange {
    const next = normalise(NetworkConfigSchema, raw);
    for (const kind of NETWORK_KINDS) {
      assignIds(next[kind] as { id: string }[], kind);
    }
    const previous = this.#network;
    const changed = new Set<string>();
    for (const kind of NETWORK_KINDS) {
      const before = new Map((previous[kind] as { id: string }[]).map((entry) => [entry.id, JSON.stringify(entry)]));
      for (const entry of next[kind] as { id: string }[]) {
        const old = before.get(entry.id);
        if (old === undefined || old !== JSON.stringify(entry)) changed.add(`${kind}/${entry.id}`);
        before.delete(entry.id);
      }
      for (const removed of before.keys()) changed.add(`${kind}/${removed}`);
    }
    this.#network = next;
    writeJsonAtomic(this.fileOf('network'), this.#network);
    const change: ConfigChange = {
      section: 'network',
      changedConnections: [...changed],
      fullReload: false,
    };
    this.#logger.info('config', `网络配置已保存（${changed.size} 项变化）`);
    this.#announce(change);
    return change;
  }

  /** Rotate the console token. Returns the new value. */
  rotateToken(next?: string): string {
    const token = next?.trim() || createToken();
    if (token.length < 8) throw new ConfigError('令牌至少需要 8 个字符');
    this.#webui = { ...this.#webui, token };
    this.save('webui');
    this.#logger.warn('config', '控制台令牌已更新');
    return token;
  }

  save(section: ConfigSection): void {
    const file = this.fileOf(section);
    if (section === 'webui') writeJsonAtomic(file, this.#webui);
    else if (section === 'onebot') writeJsonAtomic(file, this.#onebot);
    else writeJsonAtomic(file, this.#network);
  }

  /** Snapshot for the export endpoint. Tokens are redacted by the caller. */
  snapshot(): { webui: WebuiConfig; onebot: OnebotConfig; network: NetworkConfig } {
    return {
      webui: structuredClone(this.#webui),
      onebot: structuredClone(this.#onebot),
      network: structuredClone(this.#network),
    };
  }

  /**
   * Overwrite sections from an imported snapshot, atomically.
   *
   * Every section is validated in memory first; files are written before any
   * in-memory state changes, so a bad import can never leave half the instance
   * on new settings and half on old ones (regression test covers this).
   */
  importAll(data: unknown): ConfigChange[] {
    if (typeof data !== 'object' || data === null) throw new ConfigError('导入内容必须是对象');
    const record = data as Record<string, unknown>;

    const nextOnebot = record.onebot !== undefined ? normalise(OnebotConfigSchema, record.onebot) : this.#onebot;
    const nextNetwork = record.network !== undefined ? normalise(NetworkConfigSchema, record.network) : this.#network;
    const nextWebui =
      record.webui !== undefined
        ? normalise(WebuiConfigSchema, { ...this.#webui, ...(record.webui as object) })
        : this.#webui;
    for (const kind of NETWORK_KINDS) assignIds(nextNetwork[kind] as { id: string }[], kind);

    const changes: ConfigChange[] = [];
    const write = (section: ConfigSection, value: unknown): void => {
      writeJsonAtomic(this.fileOf(section), value);
      changes.push({ section, changedConnections: [], fullReload: true });
    };
    if (record.onebot !== undefined) write('onebot', nextOnebot);
    if (record.network !== undefined) write('network', nextNetwork);
    if (record.webui !== undefined) write('webui', nextWebui);

    // Only now is the in-memory state allowed to move.
    if (record.onebot !== undefined) this.#onebot = nextOnebot;
    if (record.network !== undefined) this.#network = nextNetwork;
    if (record.webui !== undefined) this.#webui = nextWebui;
    for (const change of changes) this.#announce(change);
    this.#logger.info('config', `配置已导入：${changes.map((change) => change.section).join(', ') || '无变化'}`);
    return changes;
  }

  /** Restore the OneBot and network sections to built-in defaults. */
  reset(to: 'onebot' | 'network' | 'all' = 'all'): ConfigChange[] {
    const changes: ConfigChange[] = [];
    if (to === 'onebot' || to === 'all') {
      this.#onebot = normalise(OnebotConfigSchema, {});
      this.save('onebot');
      changes.push({ section: 'onebot', changedConnections: [], fullReload: true });
    }
    if (to === 'network' || to === 'all') {
      this.#network = normalise(NetworkConfigSchema, defaultNetwork());
      for (const kind of NETWORK_KINDS) assignIds(this.#network[kind] as { id: string }[], kind);
      this.save('network');
      changes.push({ section: 'network', changedConnections: [], fullReload: true });
    }
    this.#logger.warn('config', `配置已恢复默认：${to}`);
    for (const change of changes) this.#announce(change);
    return changes;
  }

  #loadSection<T extends TSchema>(section: ConfigSection, schema: T): Static<T> {
    const file = this.fileOf(section);
    if (!fs.existsSync(file)) {
      const initial = section === 'network'
        ? normalise(schema, defaultNetwork())
        : normalise(schema, {});
      writeJsonAtomic(file, initial);
      this.#logger.info('config', `已创建默认配置 ${path.basename(file)}`);
      return initial;
    }
    const raw = readJsonFile(file);
    const value = normalise(schema, raw);
    if (JSON.stringify(value) !== JSON.stringify(raw)) {
      writeJsonAtomic(file, value);
      this.#logger.info('config', `已规范化 ${path.basename(file)}`);
    }
    return value;
  }

  #announce(change: ConfigChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#logger.failure('config', '配置变更回调失败', error);
      }
    }
  }
}

/** A fresh instance ships one loopback HTTP server so the console has a live link. */
export function defaultNetwork(): NetworkConfig {
  return {
    'http-server': [
      { id: '', name: '默认 HTTP 服务', enabled: true, host: '127.0.0.1', port: 3000, token: '', cors: false, enableWs: true },
    ],
    'http-client': [],
    sse: [],
    'ws-server': [],
    'ws-client': [],
  } as NetworkConfig;
}
