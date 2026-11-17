import { Type, type Static, type TObject, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Logger } from '../../core/logger.ts';
import type { OnebotConfig } from '../../core/config.ts';
import type { MessageIdRegistry } from '../../core/message-id.ts';
import type { MessageStore } from '../../core/message-store.ts';
import type { Stats } from '../../core/stats.ts';
import type { AccountStatus } from '../../core/model.ts';
import type { AccountDriver, CapabilityKey } from '../../driver/types.ts';
import { ActionError, RETCODE } from '../types.ts';

export interface ActionContext {
  readonly driver: AccountDriver;
  readonly config: OnebotConfig;
  readonly logger: Logger;
  readonly messageIds: MessageIdRegistry;
  /** Recent messages for `get_msg`. */
  readonly messages: MessageStore;
  readonly stats: Stats;
  readonly selfId: () => number;
  readonly online: () => boolean;
  readonly status: () => Promise<AccountStatus>;
  readonly startedAt: number;
  readonly version: string;
  /** Invoke another action in the same registry (action composition). */
  readonly call: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

export interface ActionDefinition<P extends TSchema = TObject, R = unknown> {
  readonly name: string;
  readonly description: string;
  /** Parameter schema; defaults and validation are derived from it. */
  readonly params?: P;
  /** Capabilities that must all be present, otherwise 1200 is returned. */
  readonly requires?: readonly CapabilityKey[];
  handle(params: Static<P>, context: ActionContext): Promise<R>;
}

/** Anything a driver can fail with should surface as a failed response. */
export class ActionRegistry {
  readonly #actions = new Map<string, ActionDefinition>();
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  register<P extends TSchema, R>(definition: ActionDefinition<P, R>): this {
    if (this.#actions.has(definition.name)) throw new Error(`重复注册的动作：${definition.name}`);
    this.#actions.set(definition.name, definition as unknown as ActionDefinition);
    return this;
  }

  has(name: string): boolean {
    return this.#actions.has(normaliseName(name));
  }

  get size(): number {
    return this.#actions.size;
  }

  describe(): Array<{ name: string; description: string; requires: string[] }> {
    return [...this.#actions.values()]
      .map((definition) => ({
        name: definition.name,
        description: definition.description,
        requires: [...(definition.requires ?? [])],
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Dispatch one action.
   *
   * `_async` and `_rate_limited` suffixes are accepted because several go-cqhttp
   * era frameworks still append them; they are aliases, not different actions.
   */
  async invoke(name: string, rawParams: unknown, context: ActionContext): Promise<unknown> {
    const actionName = normaliseName(name);
    const definition = this.#actions.get(actionName);
    if (!definition) {
      throw new ActionError(`不支持的 API：${name}`, RETCODE.notFound);
    }
    const missing = (definition.requires ?? []).filter((key) => !context.driver.capabilities[key]);
    if (missing.length > 0) {
      throw new ActionError(
        `${actionName} 暂不支持：当前驱动缺少 ${missing.join(', ')}`,
        RETCODE.unsupported,
      );
    }
    const params = this.#validate(definition, rawParams);
    const started = performance.now();
    try {
      const data = await definition.handle(params, context);
      this.#logger.debug('onebot', `${actionName} ok (${Math.round(performance.now() - started)}ms)`);
      return data;
    } catch (error) {
      if (error instanceof ActionError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn('onebot', `${actionName} 失败：${message}`);
      throw new ActionError(message, RETCODE.server);
    }
  }

  #validate(definition: ActionDefinition, rawParams: unknown): any {
    if (!definition.params) return rawParams ?? {};
    const input = rawParams && typeof rawParams === 'object' ? rawParams : {};
    const withDefaults = Value.Default(definition.params, Value.Clone(input as never)) as unknown;
    const coerced = Value.Convert(definition.params, withDefaults) as unknown;
    const cleaned = Value.Clean(definition.params, coerced) as unknown;
    if (!Value.Check(definition.params, cleaned)) {
      const issues: string[] = [];
      for (const error of Value.Errors(definition.params, cleaned)) {
        const where = error.path === '' ? '参数' : error.path.replace(/^\//, '').replace(/\//g, '.');
        issues.push(`${where} ${error.message}`);
        if (issues.length >= 6) break;
      }
      throw new ActionError(`参数错误：${issues.join('；')}`, RETCODE.badParam);
    }
    return cleaned;
  }
}

function normaliseName(name: string): string {
  return name.replace(/_(async|rate_limited)$/i, '');
}

/* -------------------------------------------------------------------------- */
/* Shared parameter schemas                                                    */
/* -------------------------------------------------------------------------- */

export const MessageSegmentSchema = Type.Record(Type.String(), Type.Unknown());

export const MessageSchema = Type.Union([Type.String(), Type.Array(Type.Unknown())]);

export const UserIdSchema = Type.Number({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export const GroupIdSchema = Type.Number({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export const MessageIdSchema = Type.Number({ minimum: 0 });
