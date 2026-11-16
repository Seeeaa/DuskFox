import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { startInstance, waitFor } from './helpers.ts';

interface BridgeCall {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

test('原生桥接驱动：状态、二维码、收发与事件轮询', async () => {
  const calls: BridgeCall[] = [];
  const queued: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      calls.push({ method: request.method ?? '', url: request.url ?? '', body });
      response.setHeader('content-type', 'application/json');
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/status') {
        response.end(JSON.stringify({ message_ready: true, self_id: 10001, nickname: '桥接账号', pid: 4242, cpu: 1, memory_mb: 128, version: 'qq-bridge-test' }));
        return;
      }
      if (url.pathname === '/api/events') {
        if (queued.length === 0) {
          cursor += 1;
          queued.push({
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            self_id: 10001,
            user_id: 30001,
            message_id: 'bridge-1',
            time: Math.floor(Date.now() / 1000),
            message: [{ type: 'text', data: { text: '来自桥接的问候' } }],
          });
        }
        response.end(JSON.stringify({ cursor, events: queued.splice(0).map((data) => ({ cursor, data })) }));
        return;
      }
      if (url.pathname === '/api/send-private') {
        response.end(JSON.stringify({ message_id: 'bridge-out-1' }));
        return;
      }
      if (url.pathname === '/api/qr/refresh' || url.pathname === '/api/qr') {
        response.end(JSON.stringify({ picture: Buffer.from('fake-png').toString('base64'), expires_at: Math.floor(Date.now() / 1000) + 120, seq: 7 }));
        return;
      }
      response.writeHead(404);
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const instance = await startInstance({
    driver: 'bridge',
    driverOptions: { endpoint: 'http://127.0.0.1:' + port },
  });
  try {
    await waitFor(async () => {
      const status = await instance.call('GET', '/api/status');
      return status.json.account.online === true;
    }, 8000);
    const status = await instance.call('GET', '/api/status');
    assert.equal(status.json.account.uin, '10001');
    assert.equal(status.json.account.nick, '桥接账号');
    assert.equal(status.json.account.loginType, 'session');
    assert.equal(status.json.capabilities.find((row: { key: string }) => row.key === 'group').state, 'no');

    const qr = await instance.call('POST', '/api/qr/refresh');
    assert.equal(qr.json.state, 'waiting');
    assert.match(qr.json.image, /^data:image\/png;base64,/);

    const send = await instance.call('POST', '/api/action/send_private_msg', { user_id: 30001, message: '桥接发送' });
    assert.equal(send.json.status, 'ok');
    const posted = calls.find((call) => call.url === '/api/send-private');
    assert.equal(JSON.parse(posted?.body ?? '{}').user_id, 30001);
    assert.match(posted?.body ?? '', /桥接发送/);

    const group = await instance.call('POST', '/api/action/send_group_msg', { group_id: 1, message: 'x' });
    assert.equal(group.json.retcode, 1200);

    await waitFor(async () => {
      const events = await instance.call('GET', '/api/events');
      return events.json.items.some((item: { type: string }) => item.type === 'message.private');
    }, 5000);
    const events = await instance.call('GET', '/api/events');
    const inbound = events.json.items.find((item: { type: string }) => item.type === 'message.private');
    assert.match(String(inbound.summary), /来自桥接的问候/);
  } finally {
    await instance.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('原生桥接驱动兼容异步二维码契约', async () => {
  let qrReady = false;
  let loginMode: 'active' | 'passive' = 'active';
  const image = `data:image/png;base64,${Buffer.from('fixture').toString('base64')}`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/status') {
      response.end(JSON.stringify({ message_ready: false, self_id: null, qr_ready: qrReady, login_mode: loginMode }));
    } else if (url.pathname === '/api/qr/refresh') {
      response.statusCode = 202;
      response.end(JSON.stringify({ accepted: true }));
      setTimeout(() => { qrReady = true; }, 100);
    } else if (url.pathname === '/api/qr') {
      response.statusCode = qrReady ? 200 : 404;
      response.end(JSON.stringify(qrReady ? { image } : { error: 'QR not available' }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: `http://127.0.0.1:${port}` } });
  try {
    const requested = await instance.call('POST', '/api/qr/refresh');
    assert.equal(requested.status, 200);
    assert.equal(requested.json.image, undefined);
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.image === image, 5000);
    const qr = await instance.call('GET', '/api/qr');
    assert.equal(qr.json.state, 'waiting');
    assert.equal(qr.json.image, image);
    loginMode = 'passive';
    await waitFor(async () => {
      const status = await instance.call('GET', '/api/status');
      return status.json.capabilities.some((row: { key: string; state: string }) => row.key === 'qr' && row.state === 'no');
    }, 5000);
  } finally {
    await instance.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
