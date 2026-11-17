import type { Logger } from '../core/logger.ts';
import type { ConfigStore } from '../core/config.ts';
import type { RuntimePaths } from '../core/paths.ts';
import type { AccountDriver } from '../driver/types.ts';
import type { AccountStatus } from '../core/model.ts';
import type { ConnectionInfo } from '../onebot/network/base.ts';
import type { LoadedPlugin } from '../plugins/loader.ts';
import type { OneBotService } from '../onebot/service.ts';
import type { Sessions, Tickets } from './auth.ts';
import type { StreamHub } from './stream.ts';

export type CapabilityState = 'yes' | 'partial' | 'no';

/** One row of the console "能力范围" list, generated from live capabilities. */
export interface CapabilityRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly state: CapabilityState;
}

/** One row of the console "接口接入对照" table. */
export interface EndpointRow {
  readonly method: string;
  readonly path: string;
  readonly wired: boolean;
  readonly note?: string;
}

export interface StatusPayload {
  readonly app: {
    readonly name: string;
    readonly version: string;
    readonly startedAt: number;
    readonly uptimeMs: number;
    readonly pid: number;
    readonly platform: string;
    readonly arch: string;
    readonly node: string;
    readonly driver: { readonly id: string; readonly name: string; readonly description: string };
  };
  readonly account: AccountStatus;
  /** Which login methods the current driver actually supports. */
  readonly login: {
    readonly qr: boolean;
    readonly quick: boolean;
    readonly password: boolean;
    readonly logout: boolean;
  };
  readonly stats: {
    readonly rx: number;
    readonly tx: number;
    readonly conn: number;
    readonly epm: number;
    readonly calls: number;
    readonly errors: number;
    readonly events: number;
    readonly reconnects: number;
  };
  readonly onebot: {
    readonly selfId: number;
    readonly online: boolean;
    readonly actions: number;
    readonly connections: readonly ConnectionInfo[];
  };
  readonly webui: {
    readonly host: string;
    readonly port: number;
    readonly tokenRequired: boolean;
    readonly sessions: number;
  };
  readonly paths: {
    readonly root: string;
    readonly config: string;
    readonly logs: string;
    readonly cache: string;
    readonly data: string;
  };
  readonly capabilities: readonly CapabilityRow[];
  readonly endpoints: readonly EndpointRow[];
  readonly plugins: readonly LoadedPlugin[];
}

export interface StorageBucket {
  readonly key: string;
  readonly label: string;
  readonly bytes: number;
  readonly files: number;
  /** Percentage of the soft quota used. */
  readonly percent: number;
}

export interface StorageStats {
  readonly quota: number;
  readonly buckets: readonly StorageBucket[];
}

export interface CleanResult {
  readonly target: string;
  readonly removedFiles: number;
  readonly freedBytes: number;
}

/**
 * Everything the HTTP routes may touch. Implemented by {@link Application};
 * keeping it as an interface avoids a cycle between the server and the app.
 */
export interface WebuiContext {
  readonly logger: Logger;
  readonly config: ConfigStore;
  readonly paths: RuntimePaths;
  readonly version: string;
  readonly startedAt: number;
  readonly driver: AccountDriver;
  readonly service: OneBotService;
  readonly sessions: Sessions;
  readonly tickets: Tickets;
  readonly stream: StreamHub;

  status(): Promise<StatusPayload>;
  restart(): Promise<void>;
  storage(): Promise<StorageStats>;
  cleanStorage(target: 'logs' | 'cache'): Promise<CleanResult>;
  /** Verify the long lived admin token. */
  adminTokenValid(token: string): boolean;
  rotateToken(next?: string): string;
  capabilities(): CapabilityRow[];
  endpoints(): EndpointRow[];
}
