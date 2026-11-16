import { Router } from '../http.ts';
import { LoginGuard } from '../auth.ts';
import type { WebuiContext } from '../context.ts';
import { registerSystemRoutes } from './system.ts';
import { registerConfigRoutes } from './config.ts';
import { registerAccountRoutes } from './account.ts';
import { registerFileRoutes } from './files.ts';
import { registerStreamRoute } from './stream.ts';

/** Build the complete console API router. */
export function createRouter(context: WebuiContext): Router {
  const router = new Router();
  const guard = new LoginGuard();
  registerSystemRoutes(router, context, guard);
  registerConfigRoutes(router, context);
  registerAccountRoutes(router, context);
  registerFileRoutes(router, context);
  registerStreamRoute(router, context);
  return router;
}
