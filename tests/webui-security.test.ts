import assert from 'node:assert/strict';
import test from 'node:test';
import { isSensitive } from '../src/webui/routes/files.ts';
import { startInstance, TEST_TOKEN } from './helpers.ts';

test('文件预览敏感名单拦截 config/notify.json 与 config/network.json', () => {
  assert.equal(isSensitive('config/notify.json'), true);
  assert.equal(isSensitive('/config/notify.json'), true);
  assert.equal(isSensitive('config/network.json'), true);
  assert.equal(isSensitive('/config/network.json'), true);
  // 原有凭据文件继续拦截，普通文件不受影响。
  assert.equal(isSensitive('config/webui.json'), true);
  assert.equal(isSensitive('admin.token'), true);
  assert.equal(isSensitive('README.md'), false);
  assert.equal(isSensitive('config/other.json'), false);
});

test('轮换管理令牌后旧会话与票据失效，新令牌可重新登录', async () => {
  const instance = await startInstance();
  try {
    const before = await instance.call('GET', '/api/status');
    assert.equal(before.status, 200);
    assert.equal(instance.app.sessions.size, 1);

    const ticket = await instance.call('POST', '/api/tickets', { purpose: 'stream' });
    assert.equal(ticket.status, 200);
    const ticketValue = ticket.json.ticket as string;
    assert.equal(instance.app.tickets.redeem(ticketValue, 'stream'), true);

    // 用当前会话轮换令牌；调用方这次请求照常拿到 200。
    const rotated = await instance.call('PUT', '/api/security/token', { token: 'new-token-123' });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.json.token, 'new-token-123');
    assert.match(rotated.json.note, /旧的会话与短期票据已全部失效/);
    assert.doesNotMatch(rotated.json.note, /当前会话继续有效/);

    // 旧会话和旧票据都被当场清空，旧会话再请求需要鉴权的接口应当 401。
    assert.equal(instance.app.sessions.size, 0);
    assert.equal(instance.app.tickets.redeem(ticketValue, 'stream'), false);
    const stale = await instance.call('GET', '/api/status');
    assert.equal(stale.status, 401);

    // 旧管理令牌同样不能登录。
    const oldLogin = await fetch(`${instance.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TEST_TOKEN }),
    });
    assert.equal(oldLogin.status, 401);

    // 新令牌可以重新登录，并拿到可用的新会话。
    const login = await fetch(`${instance.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'new-token-123' }),
    });
    assert.equal(login.status, 200);
    const loginJson = (await login.json()) as { token?: string };
    const nextSession = loginJson.token;
    assert.ok(nextSession);

    const after = await fetch(`${instance.base}/api/status`, {
      headers: { authorization: `Bearer ${nextSession}` },
    });
    assert.equal(after.status, 200);
  } finally {
    await instance.stop();
  }
});
