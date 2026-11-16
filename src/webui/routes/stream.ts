import type { Router } from '../http.ts';
import type { WebuiContext } from '../context.ts';

/** Console live stream: logs, OneBot events, account state and QR updates. */
export function registerStreamRoute(router: Router, context: WebuiContext): void {
  router.get('/api/stream', async ({ res }) => {
    const detach = context.stream.attach(res);
    context.stream.send('hello', { serverTime: Date.now(), version: context.version });
    res.on('close', detach);
  });
}
