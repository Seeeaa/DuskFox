import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConfigStore } from './core/config.ts';
import { Logger } from './core/logger.ts';
import { Stats } from './core/stats.ts';
import { Emitter } from './core/emitter.ts';
import { ensureDirectories, formatBytes, resolvePaths, type RuntimePaths } from './core/paths.ts';
import type { DriverEvent } from './core/model.ts';
import { createDriver } from './driver/registry.ts';
import type { AccountDriver, DriverOptions } from './driver/types.ts';
import { OneBotService } from './onebot/service.ts';
import { PluginHost } from './plugins/loader.ts';
import { Sessions, Tickets } from './webui/auth.ts';
import { StreamHub } from './webui/stream.ts';
import { ConsoleServer } from './webui/server.ts';
import type {
  CapabilityRow,
  CleanResult,
  EndpointRow,
  StatusPayload,
  StorageBucket,
  StorageStats,
  WebuiContext,
} from './webui/context.ts';
import { VERSION } from './version.ts';

const STORAGE_QUOTA = 512 * 1024 * 1024;

export interface ApplicationOptions {
  /** Instance work directory; defaults to ~/.duskfox. */
  readonly root?: string;
  readonly driver?: string;
  readonly driverOptions?: DriverOptions;
  readonly webuiHost?: string;
  readonly webuiPort?: number;
  readonly logLevel?: 'debug' | 'info' | 'warn' | 'error';
  /** Directory holding the console assets. */
  readonly assetsDir?: string;
}

/**
 * One duskfox instance.
 *
 * Composition root: it owns the work directory, configuration, logger, the
 * account driver, the OneBot service and the console server, and it is the only
 * place that wires them together.
 */
export class Application implements WebuiContext {
  readonly paths: RuntimePaths;
  readonly logger: Logger;
  readonly config: ConfigStore;
  readonly stats = new Stats();
  readonly driver: AccountDriver;
  readonly service: OneBotService;
  readonly sessions: Sessions;
  readonly tickets = new Tickets();
  readonly stream = new StreamHub();
  readonly version = VERSION;
  readonly startedAt = Date.now();

  readonly plugins: PluginHost;
  readonly #events = new Emitter<'state' | 'message' | 'notice' | 'request' | 'qr' | 'error', DriverEvent>('driver');
  readonly #console: ConsoleServer;
  #address = { host: '127.0.0.1', port: 0 };
  #running = false;

  constructor(options: ApplicationOptions = {}) {
    this.paths = resolvePaths(options.root, options.assetsDir ?? defaultAssetsDir());
    ensureDirectories(this.paths);
    this.logger = new Logger(this.paths, { level: options.logLevel ?? 'info', console: true });
    this.config = new ConfigStore(this.paths, this.logger);
    this.config.load();

    const driverId = options.driver ?? 'mock';
    this.driver = createDriver(
      driverId,
      {
        logger: this.logger,
        paths: this.paths,
        emit: (event) => this.#events.emit(event.type, event),
        onebot: () => this.config.onebot,
      },
      options.driverOptions ?? {},
    );

    this.service = new OneBotService({
      logger: this.logger,
      config: this.config,
      driver: this.driver,
      stats: this.stats,
      version: this.version,
    });
    this.plugins = new PluginHost(this.paths, this.logger, this.service);
    this.sessions = new Sessions(() => this.config.webui.sessionMinutes);
    this.#console = new ConsoleServer({ context: this, assetsDir: this.paths.webui });

    this.#wireEvents();
    if (options.webuiPort !== undefined) this.config.webui.port = options.webuiPort;
    if (options.webuiHost !== undefined) this.config.webui.host = options.webuiHost;
  }

  get address(): { host: string; port: number } {
    return this.#address;
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.#address = await this.#console.start(this.config.webui.host, this.config.webui.port);
    await this.service.start();
    await this.plugins.loadAll();
    this.#writeInstanceFile();
    const account = await this.driver.status();
    this.logger.info(
      'app',
      `duskfox ${this.version} 已启动 · 驱动 ${this.driver.name} · 账号 ${account.online ? account.uin : '未登录'}`,
    );
    this.logger.info('app', `控制台：http://${this.#address.host}:${this.#address.port}`);
    this.logger.info('app', `管理令牌：${this.config.fileOf('webui')}`);
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    this.#removeInstanceFile();
    await this.service.stop();
    await this.#console.stop();
    this.sessions.purge();
    this.logger.info('app', 'duskfox 已停止');
  }

  /** Restart transports and the driver, keeping the console socket alive. */
  async restart(): Promise<void> {
    await this.service.restart();
  }

  async status(): Promise<StatusPayload> {
    const account = await this.driver.status();
    const snapshot = this.stats.snapshot(this.service.clientCount());
    return {
      app: {
        name: 'duskfox',
        version: this.version,
        startedAt: this.startedAt,
        uptimeMs: Date.now() - this.startedAt,
        pid: process.pid,
        platform: `${os.platform()} ${os.release()}`,
        arch: os.arch(),
        node: process.version,
        driver: { id: this.driver.id, name: this.driver.name, description: this.driver.description },
      },
      account,
      stats: snapshot,
      login: {
        qr: this.driver.capabilities.qrLogin,
        quick: this.driver.capabilities.quickLogin,
        password: this.driver.capabilities.passwordLogin,
        logout: this.driver.capabilities.logout,
      },
      onebot: {
        selfId: this.service.selfId,
        online: this.service.online,
        actions: this.service.registry.size,
        connections: this.service.connections(),
      },
      webui: {
        host: this.#address.host,
        port: this.#address.port,
        tokenRequired: true,
        sessions: this.sessions.size,
      },
      paths: {
        root: this.paths.root,
        config: this.paths.config,
        logs: this.paths.logs,
        cache: this.paths.cache,
        data: this.paths.data,
      },
      capabilities: this.capabilities(),
      endpoints: this.endpoints(),
      plugins: this.plugins.list(),
    };
  }

  capabilities(): CapabilityRow[] {
    const caps = this.driver.capabilities;
    const enabled = (kind: keyof typeof this.config.network): boolean =>
      (this.config.network[kind] as Array<{ enabled: boolean }>).some((entry) => entry.enabled);
    const mediaKinds = [
      caps.mediaImage ? '图片' : '',
      caps.mediaRecord ? '语音' : '',
      caps.mediaVideo ? '视频' : '',
      caps.mediaFile ? '文件' : '',
    ].filter(Boolean);
    const media = mediaKinds.length;
    const transport = (kind: keyof typeof this.config.network, label: string, detail: string): CapabilityRow => ({
      key: kind,
      label,
      detail: enabled(kind) ? detail : `${detail}（未配置）`,
      state: enabled(kind) ? 'yes' : 'partial',
    });
    return [
      { key: 'private', label: '私聊消息', detail: 'send_private_msg · message.private', state: caps.privateMessage ? 'yes' : 'no' },
      { key: 'group', label: '群消息', detail: 'send_group_msg · message.group', state: caps.groupMessage ? 'yes' : 'no' },
      {
        key: 'media',
        label: '媒体消息段',
        detail: media > 0 ? `已支持：${mediaKinds.join(' / ')}` : '图片 / 语音 / 视频 / 文件均未支持',
        state: media === 4 ? 'yes' : media > 0 ? 'partial' : 'no',
      },
      transport('http-server', 'HTTP API', 'HTTP 服务端'),
      transport('ws-client', '反向 WS', 'WS 客户端'),
      transport('ws-server', '正向 WS', 'WS 服务端'),
      transport('http-client', 'HTTP 上报', 'HTTP 客户端 POST'),
      transport('sse', 'SSE', '事件流'),
      {
        key: 'roster',
        label: '群成员列表',
        detail: 'get_group_member_list',
        state: caps.groupMemberList ? 'yes' : 'no',
      },
      {
        key: 'query',
        label: '消息查询',
        detail: `get_msg · 最近 ${this.service.messages.size} 条窗口`,
        state: caps.messageQuery ? 'yes' : 'no',
      },
      {
        key: 'requests',
        label: '请求处理',
        detail: 'set_friend_add_request / set_group_add_request',
        state: caps.requestHandle ? 'yes' : 'no',
      },
      (() => {
        const info = this.driver.qrInfo?.();
        const passive = info?.loginMode === 'passive';
        const refreshable = info?.refreshable !== false;
        return {
          key: 'qr',
          label: '扫码登录',
          detail: passive
            ? 'GET /api/qr · 被动模式（需 QQ 客户端窗口出码，控制台同步显示）'
            : 'GET /api/qr · 主动模式',
          state: !caps.qrLogin ? 'no' : refreshable ? 'yes' : 'partial',
        } satisfies CapabilityRow;
      })(),
      {
        key: 'plugins',
        label: '插件机制',
        detail: `plugins/*.mjs 事件钩子 · 已加载 ${this.plugins.activeCount} 个`,
        state: 'yes',
      },
    ];
  }

  endpoints(): EndpointRow[] {
    const rows: EndpointRow[] = [
      { method: 'GET', path: '/api/status', wired: true },
      { method: 'GET', path: '/api/config', wired: true },
      { method: 'PUT', path: '/api/config', wired: true },
      { method: 'GET', path: '/api/logs', wired: true },
      { method: 'GET', path: '/api/events', wired: true },
      { method: 'GET', path: '/api/qr', wired: true },
      { method: 'POST', path: '/api/qr/refresh', wired: true },
      { method: 'GET', path: '/api/process', wired: this.driver.processInfo !== undefined },
      { method: 'POST', path: '/api/process/:action', wired: this.driver.controlProcess !== undefined },
      { method: 'POST', path: '/api/account/logout', wired: this.driver.capabilities.logout },
      { method: 'POST', path: '/api/action/:name', wired: true },
      { method: 'GET', path: '/api/files', wired: true },
      { method: 'GET', path: '/api/files/read', wired: true },
      { method: 'GET', path: '/api/storage', wired: true },
      { method: 'POST', path: '/api/storage/clean', wired: true },
      { method: 'POST', path: '/api/instance/restart', wired: true },
      { method: 'GET', path: '/api/config/export', wired: true },
      { method: 'POST', path: '/api/config/import', wired: true },
      { method: 'POST', path: '/api/config/reset', wired: true },
      { method: 'PUT', path: '/api/security/token', wired: true },
      { method: 'GET', path: '/api/stream', wired: true },
    ];
    return rows;
  }

  adminTokenValid(token: string): boolean {
    return token.length > 0 && token === this.config.webui.token;
  }

  rotateToken(next?: string): string {
    const token = this.config.rotateToken(next);
    return token;
  }

  async storage(): Promise<StorageStats> {
    const buckets: StorageBucket[] = [
      await this.#measure('logs', '日志', this.paths.logs),
      await this.#measure('cache', '缓存', this.paths.cache),
      await this.#measure('data', '数据', this.paths.data),
      await this.#measure('config', '配置', this.paths.config),
    ];
    return { quota: STORAGE_QUOTA, buckets };
  }

  async cleanStorage(target: 'logs' | 'cache'): Promise<CleanResult> {
    const dir = target === 'logs' ? this.paths.logs : this.paths.cache;
    let removedFiles = 0;
    let freedBytes = 0;
    if (!fs.existsSync(dir)) return { target, removedFiles, freedBytes };
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!entry.isFile()) continue;
      const isToday = target === 'logs' && full === this.logger.filePath;
      try {
        const size = fs.statSync(full).size;
        if (isToday) {
          fs.truncateSync(full, 0);
        } else {
          fs.unlinkSync(full);
          removedFiles += 1;
        }
        freedBytes += size;
      } catch (error) {
        this.logger.failure('app', `清理 ${full} 失败`, error);
      }
    }
    this.logger.warn('app', `已清理 ${target}：${removedFiles} 个文件，释放 ${formatBytes(freedBytes)}`);
    return { target, removedFiles, freedBytes };
  }

  /** Path written on start so tooling can discover the live console port. */
  get instanceFile(): string {
    return path.join(this.paths.cache, 'instance.json');
  }

  #wireEvents(): void {
    this.logger.onRecord((record) => this.stream.send('log', record));
    this.service.onEvent((event) => this.stream.send('event', event));
    this.config.onChange((change) => {
      void this.service.applyConfig(change).catch((error: unknown) => {
        this.logger.failure('app', '应用配置变更失败', error);
      });
      this.stream.send('config', change);
    });

    this.#events.on('error', (event) => {
      this.logger.error('driver', event.type === 'error' ? event.message : '');
    });
    this.#events.on('state', (event) => {
      if (event.type !== 'state') return;
      this.service.updateAccount({ online: event.status.online, uin: event.status.uin });
      this.stream.send('status', event.status);
    });
    this.#events.on('message', (event) => {
      if (event.type === 'message') this.service.handleMessage(event.message);
    });
    this.#events.on('notice', (event) => {
      if (event.type === 'notice') this.service.handleNotice(event.notice);
    });
    this.#events.on('request', (event) => {
      if (event.type === 'request') this.service.handleRequest(event.request);
    });
    this.#events.on('qr', (event) => {
      if (event.type === 'qr') this.stream.send('qr', event.qr);
    });
    this.#events.onError = (error, context) => {
      this.logger.failure('driver', `事件 ${context.type} 处理异常`, error);
    };
  }

  async #measure(key: string, label: string, dir: string): Promise<StorageBucket> {
    let bytes = 0;
    let files = 0;
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        try {
          bytes += fs.statSync(path.join(dir, entry.name)).size;
          files += 1;
        } catch {
          // Ignore files removed while measuring.
        }
      }
    }
    return { key, label, bytes, files, percent: Math.min(100, Math.round((bytes / STORAGE_QUOTA) * 1000) / 10) };
  }

  #writeInstanceFile(): void {
    const payload = {
      pid: process.pid,
      startedAt: this.startedAt,
      version: this.version,
      driver: this.driver.id,
      webui: { host: this.#address.host, port: this.#address.port },
      tokenFile: this.config.fileOf('webui'),
    };
    try {
      fs.writeFileSync(this.instanceFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (error) {
      this.logger.failure('app', '写入 instance.json 失败', error);
    }
  }

  #removeInstanceFile(): void {
    try {
      if (fs.existsSync(this.instanceFile)) fs.unlinkSync(this.instanceFile);
    } catch {
      // Best effort only.
    }
  }
}

function capabilitiesDetail(supported: boolean, detail: string): string {
  return supported ? detail : `${detail}（驱动不支持）`;
}

/** Console assets live next to the sources in development and inside dist/. */
function defaultAssetsDir(): string {
  const here = import.meta.dirname;
  const candidates = [
    path.resolve(here, '../webui'),
    path.resolve(here, '../../webui'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return candidates[0] ?? path.resolve(here, '../webui');
}
