import type { Router } from '../http.ts';
import { HttpError, sendAttachment, sendJson } from '../http.ts';
import type { WebuiContext } from '../context.ts';

/** Configuration read/write/export/import/reset. */
export function registerConfigRoutes(router: Router, context: WebuiContext): void {
  router.get('/api/config', async ({ res }) => {
    const snapshot = context.config.snapshot();
    sendJson(res, 200, {
      webui: {
        host: snapshot.webui.host,
        port: snapshot.webui.port,
        sessionMinutes: snapshot.webui.sessionMinutes,
        allowlist: snapshot.webui.allowlist,
        tokenConfigured: snapshot.webui.token.length > 0,
      },
      onebot: snapshot.onebot,
      network: snapshot.network,
      files: {
        webui: context.config.fileOf('webui'),
        onebot: context.config.fileOf('onebot'),
        network: context.config.fileOf('network'),
      },
    });
  });

  router.put('/api/config', async ({ res, body }) => {
    const payload = await body();
    const changes: string[] = [];
    if (payload.onebot !== undefined) {
      if (typeof payload.onebot !== 'object' || payload.onebot === null) throw new HttpError(400, 'onebot 必须是对象');
      const change = context.config.saveOnebot(payload.onebot);
      changes.push(`onebot${change.fullReload ? '（全量）' : ''}`);
    }
    if (payload.network !== undefined) {
      if (typeof payload.network !== 'object' || payload.network === null) throw new HttpError(400, 'network 必须是对象');
      const change = context.config.saveNetwork(payload.network);
      changes.push(`network（${change.changedConnections.length} 项变化）`);
    }
    if (changes.length === 0) throw new HttpError(400, '请求中没有 onebot 或 network 字段');
    sendJson(res, 200, { ok: true, changes, savedAt: Date.now() });
  });

  router.get('/api/config/export', async ({ res }) => {
    const snapshot = context.config.snapshot();
    // The admin token is deliberately not exportable: an exported file often
    // ends up in a chat or a backup directory and must not grant console access.
    const exported = {
      _note: 'duskfox 配置导出。webui.token 不含在内，导入后保持本机现有令牌。',
      exportedAt: new Date().toISOString(),
      version: context.version,
      onebot: snapshot.onebot,
      network: snapshot.network,
      webui: {
        host: snapshot.webui.host,
        port: snapshot.webui.port,
        sessionMinutes: snapshot.webui.sessionMinutes,
        allowlist: snapshot.webui.allowlist,
      },
    };
    const stamp = new Date().toISOString().slice(0, 10);
    sendAttachment(res, `duskfox-config-${stamp}.json`, `${JSON.stringify(exported, null, 2)}\n`);
  });

  router.post('/api/config/import', async ({ res, body }) => {
    const payload = await body();
    const data = payload.config ?? payload;
    if (typeof data !== 'object' || data === null) throw new HttpError(400, '导入内容必须是对象');
    const changes = context.config.importAll(data);
    sendJson(res, 200, { ok: true, sections: changes.map((change) => change.section) });
  });

  router.post('/api/config/reset', async ({ res, url }) => {
    const target = url.searchParams.get('to') ?? 'all';
    if (target !== 'all' && target !== 'onebot' && target !== 'network') {
      throw new HttpError(400, 'to 只能是 all / onebot / network');
    }
    const changes = context.config.reset(target);
    sendJson(res, 200, { ok: true, sections: changes.map((change) => change.section) });
  });
}
