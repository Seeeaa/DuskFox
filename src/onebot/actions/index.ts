import type { Logger } from '../../core/logger.ts';
import type { ActionContext } from './registry.ts';
import { ActionRegistry } from './registry.ts';
import { systemActions } from './system.ts';
import { messageActions } from './message.ts';
import { contactActions } from './contact.ts';

/** Build the action table for one instance. */
export function createActionRegistry(logger: Logger): ActionRegistry {
  const registry = new ActionRegistry(logger);
  for (const action of [...systemActions, ...messageActions, ...contactActions]) registry.register(action);
  return registry;
}

export type { ActionContext };
