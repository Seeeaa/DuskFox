import assert from 'node:assert/strict';
import test from 'node:test';
import { startInstance, waitFor } from './helpers.ts';

test('控制台鉴权：无令牌 401，错误令牌 401，正确令牌可登录', async () => {
  const instance = await startInstance();
  try {
    const unauthorized = await instance.call('GET', '/api/status', undefined, false);
    assert.equal(unauthorized.status, 401);
    const wrong = await fetch(`${instance.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'nope' }),
    });
    assert.equal(wrong.status, 401);
    const session = await instance.call('GET', '/api/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.json.ok, true);
  } finally {
    await instance.stop();
  }
});

test('状态接口返回驱动、账号、能力与接口清单', async () => {
  const instance = await startInstance();
  try {
    const { status, json } = await instance.call('GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(json.app.name, 'duskfox');
    assert.equal(json.app.driver.id, 'mock');
    assert.equal(json.account.online, false);
    assert.equal(Array.isArray(json.capabilities), true);
    assert.equal(json.capabilities.some((row: { key: string; state: string }) => row.key === 'http-server'), true);
    assert.equal(json.endpoints.some((row: { path: string }) => row.path === '/api/status'), true);
    assert.equal(typeof json.stats.epm, 'number');
  } finally {
    await instance.stop();
  }
});

test('离线时动作返回失败，登录后可用', async () => {
  const instance = await startInstance();
  try {
    const offline = await instance.call('POST', '/api/action/get_login_info', {});
    assert.equal(offline.status, 200);
    assert.equal(offline.json.status, 'failed');
    assert.equal(offline.json.retcode, 1404);

    const login = await instance.call('POST', '/api/account/login', { method: 'quick' });
    assert.equal(login.status, 200);
    await waitFor(async () => {
      const status = await instance.call('GET', '/api/status');
      return status.json.account.online === true;
    });

    const info = await instance.call('POST', '/api/action/get_login_info', {});
    assert.equal(info.json.status, 'ok');
    assert.equal(info.json.data.user_id, 10000);
  } finally {
    await instance.stop();
  }
});

test('控制台动作调用与 OneBot HTTP 服务共用同一套实现', async () => {
  const instance = await startInstance();
  try {
    await instance.call('POST', '/api/account/login', { method: 'quick' });
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true);

    const viaConsole = await instance.call('POST', '/api/action/send_private_msg', {
      user_id: 20001,
      message: [{ type: 'text', data: { text: '控制台' } }],
    });
    assert.equal(viaConsole.json.status, 'ok');
    assert.equal(typeof viaConsole.json.data.message_id, 'number');

    // Start the OneBot facing server on an ephemeral port.
    const config = await instance.call('GET', '/api/config');
    const network = config.json.network;
    network['http-server'] = [{ name: 'test', enabled: true, host: '127.0.0.1', port: 0, token: 'ob-token', cors: false, enableWs: true }];
    const saved = await instance.call('PUT', '/api/config', { network });
    assert.equal(saved.status, 200);
    await waitFor(() => instance.app.service.connections().some((c) => c.kind === 'http-server' && c.status === 'listening'));
    const base = instance.connectionUrl('http-server');

    const noToken = await fetch(`${base}/get_version_info`);
    assert.equal(noToken.status, 403);

    const version = await fetch(`${base}/get_version_info`, { headers: { authorization: 'Bearer ob-token' } });
    const versionJson = (await version.json()) as { status: string; data: { protocol_version: string } };
    assert.equal(versionJson.status, 'ok');
    assert.equal(versionJson.data.protocol_version, 'v11');

    const send = await fetch(`${base}/send_msg`, {
      method: 'POST',
      headers: { authorization: 'Bearer ob-token', 'content-type': 'application/json' },
      body: JSON.stringify({ user_id: 20002, message: 'HTTP 直连' }),
    });
    const sendJson = (await send.json()) as { status: string; data: { message_id: number } };
    assert.equal(sendJson.status, 'ok');
    assert.equal(typeof sendJson.data.message_id, 'number');
  } finally {
    await instance.stop();
  }
});

test('参数校验失败返回 1400，未知动作返回 1404', async () => {
  const instance = await startInstance();
  try {
    await instance.call('POST', '/api/account/login', { method: 'quick' });
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true);
    const bad = await instance.call('POST', '/api/action/send_private_msg', { message: 'x' });
    assert.equal(bad.json.status, 'failed');
    assert.equal(bad.json.retcode, 1400);
    const missing = await instance.call('POST', '/api/action/unknown_action', {});
    assert.equal(missing.json.retcode, 1404);
    const asyncAlias = await instance.call('POST', '/api/action/get_status_async', {});
    assert.equal(asyncAlias.json.status, 'ok');
  } finally {
    await instance.stop();
  }
});

test('配置保存后立即生效并写回磁盘', async () => {
  const instance = await startInstance();
  try {
    const saved = await instance.call('PUT', '/api/config', {
      onebot: { messagePostFormat: 'string', heartbeatIntervalMs: 5000, debug: true },
    });
    assert.equal(saved.status, 200);
    const config = await instance.call('GET', '/api/config');
    assert.equal(config.json.onebot.messagePostFormat, 'string');
    assert.equal(config.json.onebot.heartbeatIntervalMs, 5000);
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(`${instance.root}/config/onebot.json`, 'utf8'));
    assert.equal(raw.debug, true);
  } finally {
    await instance.stop();
  }
});

test('文件接口拒绝路径穿越', async () => {
  const instance = await startInstance();
  try {
    const escape = await instance.call('GET', '/api/files?path=../../');
    assert.equal(escape.status, 400);
    const root = await instance.call('GET', '/api/files?path=/');
    assert.equal(root.status, 200);
    assert.equal(root.json.entries.some((entry: { name: string }) => entry.name === 'config'), true);
    const read = await instance.call('GET', '/api/files/read?path=/config/onebot.json');
    assert.equal(read.status, 200);
    assert.match(read.json.text, /messagePostFormat/);
  } finally {
    await instance.stop();
  }
});

test('二维码、日志与存储接口', async () => {
  const instance = await startInstance();
  try {
    const qr = await instance.call('GET', '/api/qr');
    assert.equal(qr.status, 200);
    assert.equal(qr.json.mock, true);
    assert.equal(qr.json.state, 'waiting');
    assert.match(qr.json.image, /^data:image\/svg\+xml;base64,/);
    const refreshed = await instance.call('POST', '/api/qr/refresh');
    assert.equal(refreshed.json.seq > qr.json.seq, true);

    const logs = await instance.call('GET', '/api/logs?limit=20');
    assert.equal(logs.status, 200);
    assert.equal(Array.isArray(logs.json.items), true);

    const storage = await instance.call('GET', '/api/storage');
    assert.equal(storage.json.buckets.length, 4);
    assert.equal(storage.json.quota > 0, true);

    const cleaned = await instance.call('POST', '/api/storage/clean?target=cache');
    assert.equal(cleaned.status, 200);
  } finally {
    await instance.stop();
  }
});

test('事件与管理接口', async () => {
  const instance = await startInstance();
  try {
    const events = await instance.call('GET', '/api/events');
    assert.equal(events.status, 200);
    assert.equal(Array.isArray(events.json.items), true);
    assert.equal(events.json.items.length > 0, true);

    const actions = await instance.call('GET', '/api/actions');
    assert.equal(actions.json.items.some((item: { name: string; supported: boolean }) => item.name === 'send_private_msg'), true);

    const restart = await instance.call('POST', '/api/instance/restart');
    assert.equal(restart.status, 200);
    const afterRestart = await instance.call('GET', '/api/status');
    assert.equal(afterRestart.status, 200);

    const rotated = await instance.call('PUT', '/api/security/token', { token: 'brand-new-token-123' });
    assert.equal(rotated.status, 200);
    const oldSessionStillValid = await instance.call('GET', '/api/status');
    assert.equal(oldSessionStillValid.status, 200);
    const fresh = await fetch(`${instance.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'brand-new-token-123' }),
    });
    assert.equal(fresh.status, 200);
  } finally {
    await instance.stop();
  }
});
