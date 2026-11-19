import { createConnection } from 'node:net';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import type { Router } from './http.ts';
import { HttpError, sendJson } from './http.ts';
import type { WebuiContext } from './context.ts';
import { extractToken, isAdminToken } from './auth.ts';
import { randomBytes } from 'node:crypto';

const enabled = process.env.DUSKFOX_OFFICIAL_LOGIN === '1';
const scope = '/api/official-login/display';

export function loginFrame(command: 'frame' | 'refresh' | 'account', socketPath = '/run/df-view/login.sock'): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const peer = createConnection(socketPath);
    const timeout = setTimeout(() => peer.destroy(new Error('login display timeout')), 3500);
    const chunks: Buffer[] = [];
    let size = 0;
    peer.on('connect', () => peer.write(command + '\n'));
    peer.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 512 * 1024) peer.destroy(new Error('oversized frame'));
      else chunks.push(chunk);
    });
    peer.on('error', reject);
    peer.once('close', () => clearTimeout(timeout));
    peer.on('end', () => {
      try {
        const frame = JSON.parse(Buffer.concat(chunks).toString());
        if (!['waiting', 'pending', 'scanned', 'unavailable', 'confirmed', 'authorized', 'unknown'].includes(frame.state)) throw new Error('bad frame');
        if (frame.image && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(frame.image)) throw new Error('bad image');
        resolve(frame);
      } catch (error) { reject(error); }
    });
  });
}

const grants = new Map<string, { until: number; owner: string }>();

export function registerOfficialView(router: Router): void {
  if (!enabled) return;
  for (const command of ['frame', 'refresh'] as const) {
    router[command === 'frame' ? 'get' : 'post']('/api/official-login/' + command, async ({ res }) => {
      res.setHeader('Cache-Control', 'no-store');
      try { sendJson(res, 200, await loginFrame(command)); }
      catch (error) { throw new HttpError(503, error instanceof Error ? error.message : String(error)); }
    });
  }
  router.post(scope + '/ticket', ({ req, res }) => {
    const owner = extractToken(req.headers);
    if (!owner) throw new HttpError(401, '需要控制台会话');
    for (const [key, grant] of grants) if (grant.until <= Date.now() || grant.owner === owner) grants.delete(key);
    if (grants.size >= 64) throw new HttpError(429, '请稍后再试');
    const ticket = randomBytes(24).toString('base64url');
    grants.set(ticket, { until: Date.now() + 10_000, owner });
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, 200, { ticket });
  });
}

export function attachOfficialView(server: Server, context: WebuiContext, allowed: (req: IncomingMessage) => boolean): void {
  if (!enabled) return;
  const portal = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 256 * 1024 });
  const valid = (token: string) => isAdminToken(token, context.config.webui.token) || context.sessions.active(token);
  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const origin = new URL(request.headers.origin ?? '');
      const key = url.searchParams.get('ticket') ?? '';
      const grant = grants.get(key);
      if (url.pathname !== scope || !['https:', 'http:'].includes(origin.protocol) ||
          origin.host !== request.headers.host || !allowed(request) || !grant || grant.until <= Date.now() ||
          !valid(grant.owner) || portal.clients.size !== 0) return socket.destroy();
      grants.delete(key);
      portal.handleUpgrade(request, socket, head, (client) => {
        const remote = createConnection('/run/df-view/view.sock');
        const stream = createWebSocketStream(client);
        const expiry = setTimeout(() => client.terminate(), 180_000);
        const monitor = setInterval(() => { if (!valid(grant.owner)) client.terminate(); }, 2500);
        remote.on('error', () => client.terminate());
        stream.on('error', () => remote.destroy());
        remote.on('close', () => client.close());
        client.once('close', () => { clearTimeout(expiry); clearInterval(monitor); remote.destroy(); });
        remote.pipe(stream).pipe(remote);
      });
    } catch { socket.destroy(); }
  });
  server.once('close', () => { for (const client of portal.clients) client.terminate(); portal.close(); grants.clear(); });
}
