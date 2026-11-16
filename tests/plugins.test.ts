import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { startInstance, waitFor } from './helpers.ts';

// The plugin is written as a plain file so the test covers the real loader path.
const PLUGIN = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "export const version = '1.2.3';",
  "export default function setup(ctx) {",
  "  ctx.logger.info('demo', 'plugin started');",
  "  ctx.onEvent((event) => {",
  "    fs.appendFileSync(path.join(ctx.dataDir, 'events.log'), JSON.stringify({ type: event.type, summary: event.summary }) + '\\n');",
  "  });",
  "  globalThis.__duskfoxDemoPlugin = ctx;",
  "}",
  "",
].join('\n');

test('插件加载、事件钩子与动作调用', async () => {
  const instance = await startInstance({ plugins: { 'demo.mjs': PLUGIN } });
  try {
    const status = await instance.call('GET', '/api/status');
    assert.equal(status.json.plugins.length, 1);
    assert.equal(status.json.plugins[0].id, 'demo');
    assert.equal(status.json.plugins[0].active, true);
    assert.equal(status.json.plugins[0].version, '1.2.3');
    assert.equal(status.json.capabilities.find((row: { key: string }) => row.key === 'plugins').state, 'yes');

    await instance.call('POST', '/api/account/login', { method: 'quick' });
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true);

    await instance.call('PUT', '/api/config', { onebot: { reportSelfMessage: true } });
    await instance.call('POST', '/api/action/send_private_msg', { user_id: 20001, message: '插件应收到这条' });

    const logFile = instance.root + '/data/plugins/demo/events.log';
    await waitFor(() => fs.existsSync(logFile), 5000);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    assert.equal(lines.some((line) => line.includes('message.private')), true);

    const pluginContext = (globalThis as Record<string, unknown>).__duskfoxDemoPlugin as {
      call: (action: string, params?: Record<string, unknown>) => Promise<{ status: string }>;
    };
    const answer = await pluginContext.call('get_login_info', {});
    assert.equal(answer.status, 'ok');
  } finally {
    delete (globalThis as Record<string, unknown>).__duskfoxDemoPlugin;
    await instance.stop();
  }
});
