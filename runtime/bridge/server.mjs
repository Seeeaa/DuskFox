/** QQ bridge HTTP composition, authentication and dispatch. Domain behavior lives in routes/. */
import http from 'node:http';
import crypto from 'node:crypto';
import { normalizeMessage as normalizeNativeMessage } from './kernel/elements.cjs';
import { createEventStream } from './event-stream.mjs';
import { describeCapabilities } from './capabilities.mjs';
import { createLoginPump } from './login-pump.mjs';
import { createAccountRoutes } from './routes/account.mjs';
import { createSessionRoutes } from './routes/session.mjs';
import { createSimulatorRoutes } from './routes/simulator.mjs';
export { toOb11Segments } from './kernel/elements.cjs';

export function createBridgeServer(options) {
  const kernel = options.kernel;
  const logger = options.logger ?? console;
  const expectedToken = Buffer.from(options.token ?? '');
  const instance = 'rt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const fault = { status: 0, until: 0, haltUntil: 0 };
  const note = message => logger.log?.('[bridge] ' + message);
  const capabilities = () => describeCapabilities(kernel);
  const stream = createEventStream(kernel, logger, note);
  const login = createLoginPump(kernel, options, note, () => Date.now() < fault.haltUntil);
  const context = {
    kernel, logger, note, instance, stream, login, fault, capabilities,
    canSend: kind => (kernel.sendSegments ?? ['text', 'image']).includes(kind),
    normalizeMessage: message => normalizeNativeMessage(message, kernel, logger),
    currentQrPayload: () => login.payload(),
    computePhase: status => login.phase(status),
  };
  const routes = new Map([
    ...createSessionRoutes(context),
    ...createAccountRoutes(context),
    ...(kernel.mode === 'sim' ? createSimulatorRoutes(context) : []),
  ]);
  routes.set('GET /api/outbound/config', async ({ send }) => {
    if (!kernel.outboundStatus) return send(501, { error: '运行时没有出站配置接口' });
    return send(200, kernel.outboundStatus());
  });
  routes.set('PUT /api/outbound/config', async ({ body, send }) => {
    if (!kernel.configureOutbound) return send(501, { error: '运行时没有出站配置接口' });
    try { return send(200, kernel.configureOutbound(body)); }
    catch (error) { return send(400, { error: error.message }); }
  });

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    let bodyText = '';
    const fileLimit = Number(kernel.outboundStatus?.().config?.fileMaxBytes || 50 * 1024 * 1024);
    const maxBody = Math.max(64 * 1024 * 1024, Math.ceil(fileLimit / 3) * 4 + 1024 * 1024);
    request.on('data', chunk => {
      bodyText += String(chunk);
      if (bodyText.length > maxBody) request.destroy();
    });
    request.on('end', async () => {
      const supplied = Buffer.from(String(request.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
      const authorized = supplied.length === expectedToken.length && crypto.timingSafeEqual(supplied, expectedToken);
      if (!authorized && !(kernel.mode === 'sim' && url.pathname.startsWith('/sim/'))) return send(401, { error: 'unauthorized' });
      if (fault.status && Date.now() < fault.until) return send(fault.status, { error: 'injected fault' });
      if (Date.now() < fault.haltUntil) return send(503, { error: 'runtime temporarily offline' });
      const handler = routes.get(request.method + ' ' + url.pathname);
      if (!handler) return send(404, { error: 'not found' });
      let body = {};
      if (bodyText) {
        try { body = JSON.parse(bodyText); }
        catch { return send(400, { error: '请求体不是合法 JSON' }); }
      }
      try {
        await handler({ url, request, body, send });
      } catch (error) {
        logger.error?.('[bridge] handler failed: ' + (error.stack || error));
        if (!response.headersSent) send(500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
  const timer = login.start();
  return {
    server, kernel,
    get features() { return capabilities().features; },
    ingest(event) { return stream.ingest(event); },
    get phase() { return login.phase(); },
    setPump(enabled) { login.enabled = enabled; },
    async listen(port, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('error', onError); server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        try { server.listen(port, host, onListening); }
        catch (error) { onError(error); }
      });
      return server.address();
    },
    async close() {
      clearInterval(timer);
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export async function attachKernelEvents(bridge, kernel) {
  await kernel.start(event => bridge.ingest(event));
}
