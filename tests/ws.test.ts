import assert from 'node:assert/strict';
import test from 'node:test';
import { WebSocketServer, WebSocket } from 'ws';
import { startInstance, waitFor } from './helpers.ts';

test('反向 WS：连接、动作调用、事件推送与心跳', async () => {
  const received: Array<Record<string, any>> = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const address = wss.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  let socket: WebSocket | null = null;
  wss.on('connection', (client, request) => {
    socket = client;
    assert.equal(request.headers['x-self-id'], '10000');
    assert.equal(request.headers['x-client-role'], 'Universal');
    client.on('message', (raw) => {
      received.push(JSON.parse(raw.toString()) as Record<string, any>);
    });
  });

  const instance = await startInstance({ onebot: { heartbeatIntervalMs: 1000 } });
  try {
    await instance.call('POST', '/api/account/login', { method: 'quick' });
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true);

    const config = await instance.call('GET', '/api/config');
    const network = config.json.network;
    network['ws-client'] = [
      { name: 'test-bot', enabled: true, url: 'ws://127.0.0.1:' + port + '/ws', heartbeat: 30000, reconnect: 1000 },
    ];
    network['http-server'] = [];
    await instance.call('PUT', '/api/config', { network });

    await waitFor(() => received.some((frame) => frame.meta_event_type === 'lifecycle'), 8000);
    const lifecycle = received.find((frame) => frame.meta_event_type === 'lifecycle');
    assert.equal(lifecycle?.post_type, 'meta_event');
    assert.equal(lifecycle?.sub_type, 'connect');

    await waitFor(() => socket !== null && socket.readyState === WebSocket.OPEN);
    socket!.send(JSON.stringify({ action: 'get_version_info', params: {}, echo: 'e1' }));
    await waitFor(() => received.some((frame) => frame.echo === 'e1'));
    const answer = received.find((frame) => frame.echo === 'e1') as { status: string; data: { app_name: string } };
    assert.equal(answer.status, 'ok');
    assert.equal(answer.data.app_name, 'duskfox');

    await waitFor(() => received.some((frame) => frame.meta_event_type === 'heartbeat'), 5000);

    await instance.call('PUT', '/api/config', { onebot: { reportSelfMessage: true } });
    await instance.call('POST', '/api/action/send_private_msg', { user_id: 20001, message: '发给 bot 看' });
    await waitFor(() => received.some((frame) => frame.post_type === 'message' && frame.message_type === 'private'), 5000);
    const event = received.find((frame) => frame.post_type === 'message') as Record<string, any>;
    assert.equal(event.sub_type, 'self');
    assert.equal(typeof event.message_id, 'number');
    assert.equal(Array.isArray(event.message), true);
    assert.equal(event.message[0].type, 'text');
    assert.equal(event.message[0].data.text, '发给 bot 看');

    await instance.call('PUT', '/api/config', { onebot: { messagePostFormat: 'string' } });
    await instance.call('POST', '/api/action/send_private_msg', { user_id: 20001, message: '字符串格式' });
    await waitFor(() => received.filter((frame) => frame.post_type === 'message').length >= 2, 5000);
    const textEvent = received.filter((frame) => frame.post_type === 'message').at(-1) as Record<string, any>;
    assert.equal(typeof textEvent.message, 'string');
    assert.match(textEvent.message, /字符串格式/);
  } finally {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await instance.stop();
  }
});

test('正向 WS 服务端：多个客户端都收到事件，动作按 echo 回包', async () => {
  const instance = await startInstance();
  const sockets: WebSocket[] = [];
  try {
    await instance.call('POST', '/api/account/login', { method: 'quick' });
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true);
    const config = await instance.call('GET', '/api/config');
    const network = config.json.network;
    network['ws-server'] = [{ name: 'forward', enabled: true, host: '127.0.0.1', port: 0, token: '' }];
    network['http-server'] = [];
    await instance.call('PUT', '/api/config', { network });
    await waitFor(() => instance.app.service.connections().some((c) => c.kind === 'ws-server' && c.status === 'listening'));
    const url = instance.connectionUrl('ws-server');

    const frames: Array<Record<string, any>> = [];
    for (let index = 0; index < 2; index += 1) {
      const socket = new WebSocket(url);
      // Attach before awaiting open: the server sends lifecycle immediately.
      socket.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
    }
    await waitFor(() => frames.filter((frame) => frame.meta_event_type === 'lifecycle').length >= 2, 5000);

    sockets[0]!.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'fwd' }));
    await waitFor(() => frames.some((frame) => frame.echo === 'fwd'), 5000);

    await instance.call('PUT', '/api/config', { onebot: { reportSelfMessage: true } });
    await instance.call('POST', '/api/action/send_private_msg', { user_id: 20001, message: 'broadcast' });
    await waitFor(() => frames.filter((frame) => frame.post_type === 'message').length >= 2, 5000);
    assert.equal(instance.app.service.clientCount() >= 2, true);
  } finally {
    for (const socket of sockets) socket.terminate();
    await instance.stop();
  }
});
