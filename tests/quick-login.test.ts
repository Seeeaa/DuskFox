import assert from 'node:assert/strict';
import test from 'node:test';
import { startInstance } from './helpers.ts';

test('WebUI quick login passes the selected account to the driver', async () => {
  const instance = await startInstance();
  try {
    let selectedUin = '';
    const originalLogin = instance.app.driver.login.bind(instance.app.driver);
    instance.app.driver.login = async (request) => {
      selectedUin = request.uin ?? '';
      await originalLogin(request);
    };

    const list = await instance.call('GET', '/api/account/quick-list');
    assert.equal(list.status, 200);
    assert.equal(list.json.available, true);
    assert.deepEqual(list.json.items, []);

    const invalid = await instance.call('POST', '/api/account/login', { method: 'quick', uin: 'invalid' });
    assert.equal(invalid.status, 400);

    const accepted = await instance.call('POST', '/api/account/login', { method: 'quick', uin: '20001' });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.method, 'quick');
    assert.equal(selectedUin, '20001');
  } finally {
    await instance.stop();
  }
});
