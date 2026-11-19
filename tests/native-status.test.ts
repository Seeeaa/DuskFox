import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { NativeKernel } from '../runtime/bridge/native-kernel.cjs';
import { startInstance, waitFor } from './helpers.ts';

function probe() {
  const kernel = new NativeKernel();
  kernel.emit = () => {};
  kernel.session = {};
  kernel.uin = '10001';
  return kernel;
}

test('状态查询零登录副作用：status() 不触发 quickLogin/login/requestQr', () => {
  const kernel = probe();
  const calls: string[] = [];
  (kernel as any).loginService = {
    getMsfStatus: () => { calls.push('getMsfStatus'); return 1; },
    quickLoginWithUin: () => { calls.push('quickLogin'); return true; },
    getLoginList: () => { calls.push('getLoginList'); return []; },
  };
  (kernel as any).requestQr = async () => { calls.push('requestQr'); return true; };
  for (let i = 0; i < 5; i += 1) kernel.status();
  assert.equal(calls.filter((n) => n === 'quickLogin' || n === 'requestQr').length, 0, '状态查询不得发起登录/取码');
});

test('authorized 需要非空数字 uin：否则是 unknown，且身份字段清空', () => {
  const kernel = probe();
  (kernel as any).loginSucceeded = true;
  kernel.uin = '';
  const anonymous = kernel.status();
  assert.equal(anonymous.authorized, false);
  assert.equal(anonymous.accountState, 'unknown');
  assert.equal(anonymous.uin, '');

  kernel.uin = '10001';
  const identified = kernel.status();
  assert.equal(identified.authorized, true);
  assert.equal(identified.accountState, 'authorized');
  assert.equal(identified.uin, '10001');
});

test('messageReady 来自当前绑定有效性，不是缓存对象存在', () => {
  const kernel = probe();
  (kernel as any).loginSucceeded = true;
  kernel.msgService = {};
  assert.equal(kernel.status().messageReady, false, '只有对象、没有绑定不算就绪');

  const session = {};
  const service = {};
  (kernel as any).session = session;
  kernel.msgService = service;
  (kernel as any).messageBinding = { session, service, id: 'listener-1' };
  assert.equal(kernel.status().messageReady, true);

  // 同会话换成另一个 service 对象：旧绑定立即失效
  kernel.msgService = {};
  assert.equal(kernel.status().messageReady, false);
});

test('会话失效后 account_state=signed_out，且不再报 authorized', () => {
  const kernel = probe();
  (kernel as any).loginSucceeded = true;
  (kernel as any).invalidateSession();
  const status = kernel.status();
  assert.equal(status.accountState, 'signed_out');
  assert.equal(status.authorized, false);
  assert.equal(status.uin, '');
});

/** 事件流持续失败时，发送能力（online）不得被翻转（M8）。 */
test('事件流连续失败不影响 online：只影响接收并写进 detail', async () => {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/status') {
      response.end(JSON.stringify({
        message_ready: true,
        message_service_ready: true,
        authorized: true,
        account_state: 'authorized',
        self_id: 10001,
        nickname: '会话账号',
        contract: 2,
        instance: 'rt-m8',
        phase: 'online',
      }));
      return;
    }
    if (url.pathname === '/api/events') {
      response.writeHead(500);
      response.end('{"error":"events broken"}');
      return;
    }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: `http://127.0.0.1:${port}` } });
  try {
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true, 8000);
    // 等事件轮询连续失败至少 3 次（驱动 1 秒一次）
    await waitFor(async () => {
      const status = await instance.call('GET', '/api/status');
      return String(status.json.account.detail ?? '').includes('事件流');
    }, 12_000);
    const status = await instance.call('GET', '/api/status');
    assert.equal(status.json.account.online, true, '事件流故障不得关闭发送能力');
    assert.equal(status.json.account.sessionState, 'authorized');
    assert.equal(status.json.account.messageReady, true);
  } finally {
    await instance.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
