import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../core/logger.ts';
import type { RuntimePaths } from '../core/paths.ts';
import type { OneBotService } from '../onebot/service.ts';

/** The small logging surface plugins are allowed to use. */
export interface PluginLogger {
  debug(module: string, message: string): void;
  info(module: string, message: string): void;
  warn(module: string, message: string): void;
  error(module: string, message: string): void;
  failure(module: string, message: string, error: unknown): void;
}

/** What a plugin module receives when the host calls its default export. */
export interface PluginContext {
  readonly id: string;
  readonly version: string;
  readonly logger: PluginLogger;
  /** Absolute path to a per-plugin data directory (created on demand). */
  readonly dataDir: string;
  /** Subscribe to published OneBot events. Returns an unsubscribe function. */
  onEvent(handler: (event: unknown) => void): () => void;
  /** Call any registered action, exactly like a bot would over the network. */
  call(action: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface LoadedPlugin {
  readonly id: string;
  readonly version: string;
  readonly file: string;
  readonly active: boolean;
  readonly error?: string;
}

const EXTENSIONS = new Set(['.mjs', '.js']);
const MAX_PLUGIN_BYTES = 1024 * 1024;

/**
 * In-process plugin host.
 *
 * Plugins are plain ESM modules in `<workdir>/plugins` whose default export
 * receives a {@link PluginContext}. They run inside the framework process, so
 * they can react to events and call actions with zero network overhead. Loading
 * is intentionally conservative: files are sorted, one broken plugin is
 * isolated, and nothing is imported from outside the plugin directory.
 */
export class PluginHost {
  readonly #paths: RuntimePaths;
  readonly #logger: Logger;
  readonly #service: OneBotService;
  readonly #loaded: LoadedPlugin[] = [];

  constructor(paths: RuntimePaths, logger: Logger, service: OneBotService) {
    this.#paths = paths;
    this.#logger = logger;
    this.#service = service;
  }

  list(): LoadedPlugin[] {
    return [...this.#loaded];
  }

  get activeCount(): number {
    return this.#loaded.filter((plugin) => plugin.active).length;
  }

  /** Import every plugin file once; failures are recorded, never thrown. */
  async loadAll(): Promise<LoadedPlugin[]> {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.#paths.plugins);
    } catch {
      return this.list();
    }
    const files = entries
      .filter((name) => EXTENSIONS.has(path.extname(name).toLowerCase()) && !name.startsWith('.'))
      .sort();

    for (const name of files) {
      const file = path.join(this.#paths.plugins, name);
      const id = path.basename(name, path.extname(name));
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_PLUGIN_BYTES) {
          this.#loaded.push({ id, version: '', file, active: false, error: '文件过大或不是普通文件' });
          continue;
        }
        const module = (await import(`${pathToFileURL(file).href}?v=${stat.mtimeMs}`)) as {
          default?: (context: PluginContext) => unknown;
          version?: string;
        };
        if (typeof module.default !== 'function') {
          this.#loaded.push({ id, version: '', file, active: false, error: '缺少 default 导出函数' });
          continue;
        }
        const version = String(module.version ?? '0.0.0');
        const dataDir = path.join(this.#paths.data, 'plugins', id);
        fs.mkdirSync(dataDir, { recursive: true });
        const context: PluginContext = {
          id,
          version,
          logger: this.#scopedLogger(id),
          dataDir,
          onEvent: (handler) => this.#service.onEvent((event) => handler(event)),
          call: (action, params = {}) => this.#service.dispatch(action, params, undefined, 'http'),
        };
        await module.default(context);
        this.#loaded.push({ id, version, file, active: true });
        this.#logger.info('plugins', `已加载插件 ${id}@${version}`);
      } catch (error) {
        this.#logger.failure('plugins', `插件 ${id} 加载失败`, error);
        this.#loaded.push({
          id,
          version: '',
          file,
          active: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.list();
  }

  #scopedLogger(id: string): PluginLogger {
    const logger = this.#logger;
    const prefix = `plugin:${id}`;
    const fmt = (module: string, message: string): string => `[${module}] ${message}`;
    return {
      debug: (module, message) => logger.debug(prefix, fmt(module, message)),
      info: (module, message) => logger.info(prefix, fmt(module, message)),
      warn: (module, message) => logger.warn(prefix, fmt(module, message)),
      error: (module, message) => logger.error(prefix, fmt(module, message)),
      failure: (module, message, error) => logger.failure(prefix, fmt(module, message), error),
    };
  }
}
