import fs from 'node:fs';
import type { Router } from '../http.ts';
import { HttpError, sendAttachment, sendJson } from '../http.ts';
import type { WebuiContext } from '../context.ts';

/** Account, QR, action invocation, event and log routes. */
export function registerAccountRoutes(router: Router, context: WebuiContext): void {
  router.get('/api/qr', async ({ res }) => {
    const qr = await context.driver.qrCode();
    sendJson(res, 200, { ...qr, mock: context.driver.id === 'mock' });
  });

  router.post('/api/qr/refresh', async ({ res }) => {
    if (!context.driver.capabilities.qrLogin) throw new HttpError(501, '当前驱动不支持扫码登录');
    const qr = await context.driver.refreshQr();
    context.stream.send('qr', { ...qr, mock: context.driver.id === 'mock' });
    context.logger.info('webui', '控制台请求刷新二维码');
    sendJson(res, 200, { ...qr, mock: context.driver.id === 'mock' });
  });

  router.post('/api/account/login', async ({ res, body }) => {
    const payload = await body();
    if (payload.method === 'password') {
      if (!context.driver.capabilities.passwordLogin) throw new HttpError(501, '当前驱动不支持密码登录');
      const uin = typeof payload.uin === 'string' ? payload.uin.trim() : '';
      const password = typeof payload.password === 'string' ? payload.password : '';
      if (!/^\d{5,12}$/.test(uin)) throw new HttpError(400, 'QQ 号格式不正确');
      if (!password) throw new HttpError(400, '密码不能为空');
      context.logger.warn('webui', `控制台发起密码登录（uin=${uin}）`);
      try {
        await context.driver.login({ method: 'password', uin, password });
      } catch (error) {
        throw new HttpError(502, error instanceof Error ? error.message : String(error));
      }
      sendJson(res, 200, { ok: true, method: 'password' });
      return;
    }
    const method = payload.method === 'quick' ? 'quick' : payload.method === 'qr' ? 'qr' : null;
    if (!method) throw new HttpError(400, 'method 只能是 qr、quick 或 password');
    if (method === 'quick' && !context.driver.capabilities.quickLogin) {
      throw new HttpError(501, '当前驱动不支持快速登录');
    }
    await context.driver.login({ method });
    sendJson(res, 200, { ok: true, method });
  });

  router.post('/api/account/logout', async ({ res }) => {
    if (!context.driver.capabilities.logout) throw new HttpError(501, '当前驱动不支持退出登录');
    await context.driver.logout();
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/account/quick-list', async ({ res }) => {
    sendJson(res, 200, { available: context.driver.capabilities.quickLogin, items: [] });
  });

  /** Same envelope a bot receives, which makes the console a real API client. */
  router.post('/api/action/:name', async ({ res, params, body }) => {
    const name = params.name ?? '';
    if (!name) throw new HttpError(400, '缺少动作名');
    const payload = await body();
    const inner = payload.params && typeof payload.params === 'object' ? payload.params : payload;
    const response = await context.service.dispatch(name, inner as Record<string, unknown>, payload.echo, 'http');
    sendJson(res, 200, response);
  });

  router.get('/api/events', async ({ res, url }) => {
    const limit = Number(url.searchParams.get('limit') ?? 100);
    sendJson(res, 200, {
      items: context.service.recentEvents(Number.isFinite(limit) ? limit : 100),
      actions: context.service.registry.size,
    });
  });

  router.get('/api/logs', async ({ res, url }) => {
    const level = url.searchParams.get('level') ?? 'all';
    const allowed = new Set(['all', 'debug', 'info', 'warn', 'error']);
    if (!allowed.has(level)) throw new HttpError(400, 'level 取值不合法');
    const limit = Number(url.searchParams.get('limit') ?? 400);
    const items = context.logger.query({
      level: level as 'all' | 'debug' | 'info' | 'warn' | 'error',
      contains: url.searchParams.get('contains') ?? undefined,
      limit: Number.isFinite(limit) ? limit : 400,
    });
    sendJson(res, 200, { items, file: context.logger.filePath, size: context.logger.fileSize() });
  });

  router.get('/api/logs/download', async ({ res }) => {
    const file = context.logger.filePath;
    if (!fs.existsSync(file)) {
      sendAttachment(res, 'duskfox-log.txt', '（今天还没有日志）\n');
      return;
    }
    sendAttachment(res, file.split(/[\\/]/).pop() ?? 'duskfox-log.txt', fs.readFileSync(file, 'utf8'));
  });

  router.delete('/api/logs', async ({ res }) => {
    context.logger.clear();
    sendJson(res, 200, { ok: true });
  });
}
