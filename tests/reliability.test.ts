import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { Tickets } from '../src/webui/auth.ts';
import { startInstance, waitFor } from './helpers.ts';

test('配置导入失败不会留下半套配置', async () => {
  const instance = await startInstance();
  try {
    const before = await instance.call('GET', '/api/config');
    const networkFileBefore = fs.readFileSync(instance.root + '/config/network.json', 'utf8');
    const onebotFileBefore = fs.readFileSync(instance.root + '/config/onebot.json', 'utf8');

    const imported = await instance.call('POST', '/api/config/import', {
      config: {
        onebot: { messagePostFormat: 'string', heartbeatIntervalMs: 5000 },
        network: { 'http-server': [{ port: 70000 }] },
      },
    });
    assert.equal(imported.status, 400);
    assert.match(String(imported.json.error), /port/);

    const after = await instance.call('GET', '/api/config');
    assert.deepEqual(after.json.onebot, before.json.onebot, 'in-memory onebot unchanged');
    assert.deepEqual(after.json.network, before.json.network, 'in-memory network unchanged');
    assert.equal(fs.readFileSync(instance.root + '/config/onebot.json', 'utf8'), onebotFileBefore);
    assert.equal(fs.readFileSync(instance.root + '/config/network.json', 'utf8'), networkFileBefore);

    const ok = await instance.call('POST', '/api/config/import', {
      config: { onebot: { messagePostFormat: 'string', heartbeatIntervalMs: 5000 } },
    });
    assert.equal(ok.status, 200);
    assert.equal((await instance.call('GET', '/api/config')).json.onebot.messagePostFormat, 'string');
  } finally {
    await instance.stop();
  }
});

test('文件预览拒绝读取令牌配置', async () => {
  const instance = await startInstance();
  try {
    const blocked = await instance.call('GET', '/api/files/read?path=/config/webui.json');
    assert.equal(blocked.status, 403);
    assert.match(String(blocked.json.error), /凭据/);
    const traversal = await instance.call('GET', '/api/files/read?path=/config/../config/webui.json');
    assert.equal(traversal.status, 403);
    const allowed = await instance.call('GET', '/api/files/read?path=/config/onebot.json');
    assert.equal(allowed.status, 200);
  } finally {
    await instance.stop();
  }
});

test('URL 不再接受会话令牌，改为一次性用途票据', async () => {
  const instance = await startInstance();
  try {
    const byQuery = await fetch(instance.base + '/api/logs/download?token=' + encodeURIComponent(instance.session));
    assert.equal(byQuery.status, 401);

    const byHeader = await fetch(instance.base + '/api/logs/download', { headers: { authorization: 'Bearer ' + instance.session } });
    assert.equal(byHeader.status, 200);

    const issued = await instance.call('POST', '/api/tickets', { purpose: 'logs.download' });
    assert.equal(issued.status, 200);
    assert.equal(typeof issued.json.ticket, 'string');
    const download = await fetch(instance.base + '/api/logs/download?ticket=' + encodeURIComponent(issued.json.ticket));
    assert.equal(download.status, 200);

    // A ticket is scoped: a stream ticket cannot unlock a download.
    const wrong = await instance.call('POST', '/api/tickets', { purpose: 'stream' });
    const crossUse = await fetch(instance.base + '/api/logs/download?ticket=' + encodeURIComponent(wrong.json.ticket));
    assert.equal(crossUse.status, 401);
    const badPurpose = await instance.call('POST', '/api/tickets', { purpose: 'whatever' });
    assert.equal(badPurpose.status, 400);
  } finally {
    await instance.stop();
  }
});

test('票据过期后不可用', async () => {
  const tickets = new Tickets();
  const issued = tickets.issue('logs.download', 5);
  assert.equal(tickets.redeem(issued.ticket, 'logs.download'), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tickets.redeem(issued.ticket, 'logs.download'), false);
  assert.equal(tickets.redeem('nope', 'logs.download'), false);
});

test('监听端口被占用时自动重试，释放后恢复监听', async () => {
  const instance = await startInstance();
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
  const address = blocker.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const config = await instance.call('GET', '/api/config');
    const network = config.json.network;
    network['http-server'] = [{ name: 'retry', enabled: true, host: '127.0.0.1', port, token: '', cors: false, enableWs: false }];
    const saved = await instance.call('PUT', '/api/config', { network });
    assert.equal(saved.status, 200);

    await waitFor(() => instance.app.service.connections().some((info) => info.kind === 'http-server' && info.status === 'error'), 8000);

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await waitFor(() => instance.app.service.connections().some((info) => info.kind === 'http-server' && info.status === 'listening'), 12_000);
  } finally {
    blocker.close();
    await instance.stop();
  }
});

test('事件轮询不重叠，游标跳过会记录丢失', async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const events = Array.from({ length: 10 }, (_, index) => ({
    cursor: index + 1,
    data: {
      time: Math.floor(Date.now() / 1000),
      self_id: 10001,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 'm' + (index + 1),
      user_id: 20001,
      message: [{ type: 'text', data: { text: 'evt-' + (index + 1) } }],
      raw_message: 'evt-' + (index + 1),
      sender: { user_id: 20001, nickname: '甲' },
    },
  }));
  let lostOnce = false;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/status') {
      response.end(JSON.stringify({ message_ready: true, self_id: 10001, nickname: 'slow', login_mode: 'active', phase: 'online' }));
      return;
    }
    if (url.pathname === '/api/events') {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const after = Number(url.searchParams.get('after') ?? 0);
      const batch = events.filter((item) => item.cursor > after).slice(0, 2);
      const payload = { cursor: events.length, events: batch, ...(lostOnce ? {} : { lost: 0 }) };
      setTimeout(() => {
        inFlight -= 1;
        response.end(JSON.stringify(payload));
      }, 1200);
      return;
    }
    if (url.pathname === '/api/qr') {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    if (url.pathname === '/api/send') {
      response.end(JSON.stringify({ message_id: 'x1' }));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  void lostOnce;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: 'http://127.0.0.1:' + port } });
  try {
    await waitFor(async () => {
      const list = await instance.call('GET', '/api/events?limit=300');
      return list.json.items.filter((item: { summary: string }) => item.summary.includes('evt-')).length >= 10;
    }, 30_000);
    assert.equal(maxConcurrent, 1, 'event polling must never overlap');
    const list = await instance.call('GET', '/api/events?limit=300');
    const backlog = list.json.items
      .map((item: { summary: string }) => item.summary)
      .filter((summary: string) => summary.includes('evt-'));
    assert.equal(backlog.length, 10, 'every event delivered exactly once');
    assert.equal(new Set(backlog).size, 10, 'no duplicated events');
  } finally {
    await instance.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * A scriptable fake runtime for the pagination / instance / phase tests.
 */
function fakeRuntime(options: {
  events: Array<{ cursor: number; data: Record<string, unknown> }>;
  batch?: number;
  instance?: () => string;
  status?: () => Record<string, unknown>;
  delayMs?: number;
}) {
  const state = { inFlight: 0, maxInFlight: 0 };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('content-type', 'application/json');
    const answer = (value: unknown): void => {
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/api/status') {
      return answer({
        message_ready: true,
        self_id: 10001,
        nickname: 'fake',
        login_mode: 'active',
        phase: 'online',
        ...(options.status?.() ?? {}),
      });
    }
    if (url.pathname === '/api/events') {
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      const after = Number(url.searchParams.get('after') ?? 0);
      const batch = options.batch ?? 100;
      const events = options.events.filter((item) => item.cursor > after).slice(0, batch);
      const payload = { cursor: options.events.length, instance: options.instance?.(), events };
      setTimeout(() => {
        state.inFlight -= 1;
        answer(payload);
      }, options.delayMs ?? 0);
      return;
    }
    if (url.pathname === '/api/qr') return answer({ picture: null });
    if (url.pathname === '/api/send') return answer({ message_id: 'x' });
    response.writeHead(404);
    response.end('{}');
  });
  return { server, state };
}

function messageEvent(cursor: number, text: string, overrides: Record<string, unknown> = {}) {
  return {
    cursor,
    data: {
      time: Math.floor(Date.now() / 1000),
      self_id: 10001,
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 'm' + cursor,
      user_id: 20001,
      message: [{ type: 'text', data: { text } }],
      raw_message: text,
      sender: { user_id: 20001, nickname: '甲' },
      ...overrides,
    },
  };
}

async function bootFake(options: Parameters<typeof fakeRuntime>[0]) {
  const runtime = fakeRuntime(options);
  await new Promise<void>((resolve) => runtime.server.listen(0, '127.0.0.1', () => resolve()));
  const address = runtime.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: 'http://127.0.0.1:' + port } });
  return { runtime, instance, close: async () => { await instance.stop(); await new Promise<void>((resolve) => runtime.server.close(() => resolve())); } };
}

test('分页积压：每批 100 条、共 250 条也要全部送达', async () => {
  const events = Array.from({ length: 250 }, (_, index) => messageEvent(index + 1, 'page-' + (index + 1)));
  const { runtime, instance, close } = await bootFake({ events, batch: 100 });
  try {
    await waitFor(async () => (await instance.call('GET', '/api/events?limit=300')).json.items.length >= 150, 20_000);
    const list = await instance.call('GET', '/api/events?limit=300');
    const page = list.json.items.map((item: { summary: string }) => item.summary).filter((summary: string) => summary.includes('page-'));
    assert.equal(page.length, 250, 'all 250 events delivered across batches');
    assert.equal(new Set(page).size, 250, 'no duplicated events');
    assert.equal(runtime.state.maxInFlight, 1, 'polling stayed serial');
  } finally {
    await close();
  }
});

test('message_sent 事件不会再被丢弃', async () => {
  const events = [
    messageEvent(1, 'self-sent', { post_type: 'message_sent', sub_type: 'friend' }),
  ];
  const { instance, close } = await bootFake({ events });
  try {
    await instance.call('PUT', '/api/config', { onebot: { reportSelfMessage: true } });
    await waitFor(async () => {
      const list = await instance.call('GET', '/api/events?limit=50');
      return list.json.items.some((item: { type: string; summary: string }) => item.type === 'message_sent.private' && item.summary.includes('self-sent'));
    }, 15_000);
    const list = await instance.call('GET', '/api/events?limit=50');
    const item = list.json.items.find((entry: { type: string; summary: string }) => entry.type === 'message_sent.private');
    assert.ok(item, 'message_sent should reach the console');
    assert.match(String(item.summary), /self-sent/);
  } finally {
    await close();
  }
});

test('二维码：运行时报告已扫码时，缓存的图片不能盖住 scanned 状态', async () => {
  let phase = 'scan_qr';
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/status') {
      response.end(JSON.stringify({ message_ready: false, self_id: 0, login_mode: 'active', phase, qr_ready: true }));
      return;
    }
    if (url.pathname === '/api/qr') {
      response.end(JSON.stringify({ picture: Buffer.from('png').toString('base64'), seq: 2, expires_at: Math.floor(Date.now() / 1000) + 120, phase }));
      return;
    }
    if (url.pathname === '/api/events') {
      response.end(JSON.stringify({ cursor: 0, instance: 'qr-test', events: [] }));
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: 'http://127.0.0.1:' + port } });
  try {
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.state === 'waiting', 8000);
    phase = 'confirm_on_phone';
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.state === 'scanned', 8000);
  } finally {
    await instance.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('运行时重启收缩能力：旧能力不会残留', async () => {
  let groups = true;
  let instanceId = 'rt-a';
  const events = [messageEvent(1, 'hello')];
  const { instance, close } = await bootFake({
    events,
    instance: () => instanceId,
    status: () => ({
      instance: instanceId,
      contract: 2,
      send_segments: ['text', 'image'],
      recv_segments: ['text', 'image'],
      features: { privateMessage: true, groupMessage: groups, mediaImage: true, friendList: true },
    }),
  });
  try {
    await waitFor(async () => {
      const status = await instance.call('GET', '/api/status');
      return status.json.capabilities.find((row: { key: string }) => row.key === 'group')?.state === 'yes';
    }, 8000);

    groups = false;
    instanceId = 'rt-b';
    await waitFor(async () => {
      const status = await instance.call('GET', '/api/status');
      return status.json.capabilities.find((row: { key: string }) => row.key === 'group')?.state === 'no';
    }, 10_000);
  } finally {
    await close();
  }
});
