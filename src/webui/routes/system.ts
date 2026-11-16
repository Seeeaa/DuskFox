import type { Router } from '../http.ts';
import { HttpError, sendJson } from '../http.ts';
import type { WebuiContext } from '../context.ts';
import { extractToken, isAdminToken } from '../auth.ts';
import { LoginGuard } from '../auth.ts';

/** Auth, status, process control, storage and security routes. */
export function registerSystemRoutes(router: Router, context: WebuiContext, guard: LoginGuard): void {
  router.post('/api/auth/login', async ({ req, res, body }) => {
    const address = req.socket.remoteAddress ?? 'unknown';
    guard.check(address);
    const payload = await body();
    const token = typeof payload.token === 'string' ? payload.token.trim() : '';
    if (!isAdminToken(token, context.config.webui.token)) {
      guard.fail(address);
      context.logger.warn('webui', `控制台登录失败（${address}）`);
      sendJson(res, 401, { ok: false, error: '令牌无效' });
      return;
    }
    guard.success(address);
    const session = context.sessions.create();
    context.logger.info('webui', `控制台登录成功（${address}）`);
    sendJson(res, 200, { ok: true, token: session.token, expiresAt: session.expiresAt });
  });

  router.get('/api/auth/session', async ({ req, res, url }) => {
    const token = extractToken(req.headers, url);
    sendJson(res, 200, { ok: true, admin: isAdminToken(token, context.config.webui.token) });
  });

  router.post('/api/auth/logout', async ({ req, res, url }) => {
    const token = extractToken(req.headers, url);
    if (!isAdminToken(token, context.config.webui.token)) context.sessions.destroy(token);
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/status', async ({ res }) => {
    sendJson(res, 200, await context.status());
  });

  /** Action table for the console debug page, including what the driver supports. */
  router.get('/api/actions', async ({ res }) => {
    const capabilities = context.driver.capabilities;
    const items = context.service.registry.describe().map((action) => {
      const missing = action.requires.filter((key) => !capabilities[key as keyof typeof capabilities]);
      return { ...action, supported: missing.length === 0, missing };
    });
    sendJson(res, 200, { items, driver: context.driver.id });
  });

  router.post('/api/instance/restart', async ({ res }) => {
    context.logger.warn('webui', '控制台请求重启实例');
    await context.restart();
    sendJson(res, 200, { ok: true, restartedAt: Date.now() });
  });

  router.get('/api/storage', async ({ res }) => {
    sendJson(res, 200, await context.storage());
  });

  router.post('/api/storage/clean', async ({ res, url }) => {
    const target = url.searchParams.get('target') ?? 'logs';
    if (target !== 'logs' && target !== 'cache') throw new HttpError(400, 'target 只能是 logs 或 cache');
    sendJson(res, 200, { ok: true, ...(await context.cleanStorage(target)) });
  });

  router.get('/api/process', async ({ res }) => {
    if (!context.driver.processInfo) {
      sendJson(res, 200, { available: false, running: false, note: '当前驱动不提供进程信息' });
      return;
    }
    try {
      const info = await context.driver.processInfo();
      sendJson(res, 200, { available: true, ...info });
    } catch (error) {
      // A runtime that is down is a normal state, not a server error.
      sendJson(res, 200, {
        available: false,
        running: false,
        note: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post('/api/process/:action', async ({ res, params }) => {
    const action = params.action;
    if (action !== 'start' && action !== 'restart' && action !== 'stop') {
      throw new HttpError(400, 'action 只能是 start / restart / stop');
    }
    if (!context.driver.controlProcess) throw new HttpError(501, '当前驱动不支持进程控制');
    await context.driver.controlProcess(action);
    sendJson(res, 200, { ok: true, action });
  });

  router.put('/api/security/token', async ({ res, body }) => {
    const payload = await body();
    const next = typeof payload.token === 'string' ? payload.token.trim() : '';
    if (next && next.length < 8) throw new HttpError(400, '新令牌至少需要 8 个字符');
    const token = context.rotateToken(next || undefined);
    sendJson(res, 200, { ok: true, token, note: '已写入 config/webui.json；当前会话继续有效' });
  });
}
