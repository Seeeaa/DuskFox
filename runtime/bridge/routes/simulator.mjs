/** One registration per method/path; no mirrored pathname list. */
export function createSimulatorRoutes(context) {
  const { kernel, currentQrPayload, computePhase, stream, fault } = context;
  return new Map([
    ["POST /sim/emit", async ({ url, request, body, send }) => {

      kernel.incoming(body);
      return send(200, { cursor: stream.cursor });

    }],
    ["POST /sim/request", async ({ url, request, body, send }) => {

      const flag = kernel.request(body);
      return send(200, { cursor: stream.cursor, flag });

    }],
    ["POST /sim/backlog", async ({ url, request, body, send }) => {

      const count = Math.max(1, Math.min(Number(body.count ?? 0), 900));
      for (let index = 0; index < count; index += 1) {
        kernel.incoming({ scene: body.scene === 'group' ? 'group' : 'private', text: '积压消息 ' + (index + 1) });
      }
      return send(200, { cursor: stream.cursor, count });

    }],
    ["POST /sim/qr", async ({ url, request, body, send }) => {

      if (body.action === 'issue') kernel.issueQr(Number(body.ttlMs ?? 0) || undefined);
      if (body.action === 'scan') kernel.scanQr();
      if (body.action === 'confirm') kernel.confirmQr();
      return send(200, { qr: currentQrPayload() });

    }],
    ["POST /sim/online", async ({ url, request, body, send }) => {

      kernel.setOnline(Boolean(body.value));
      return send(200, { online: kernel.status().online });

    }],
    ["POST /sim/fault", async ({ url, request, body, send }) => {

      if (body.status) {
        fault.status = Number(body.status);
        fault.until = Date.now() + Number(body.ms ?? 3000);
      } else {
        fault.status = 0;
      }
      if (body.haltMs) {
        fault.haltUntil = Date.now() + Number(body.haltMs);
      }
      return send(200, { ok: true });

    }],
    ["GET /sim/state", async ({ url, request, body, send }) => {

      return send(200, {
        phase: computePhase(),
        cursor: stream.cursor,
        ring: stream.size,
        sent: kernel.sent.length,
        requests: Array.isArray(kernel.requests) ? kernel.requests.length : 0,
        qr: currentQrPayload(),
      });

    }]
  ]);
}
