import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigError, ConfigStore, normalise, NetworkConfigSchema, OnebotConfigSchema } from '../src/core/config.ts';
import { Logger } from '../src/core/logger.ts';
import { resolvePaths } from '../src/core/paths.ts';

function store(): ConfigStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duskfox-config-'));
  const paths = resolvePaths(root);
  const logger = new Logger(paths, { console: false, level: 'error' });
  const config = new ConfigStore(paths, logger);
  config.load();
  return config;
}

test('首次启动写入默认配置并生成控制台令牌', () => {
  const config = store();
  assert.equal(config.webui.token.length >= 16, true);
  assert.equal(config.network['http-server'].length, 1);
  assert.equal(config.network['http-server'][0]?.port, 3000);
  assert.equal(config.onebot.messagePostFormat, 'array');
  assert.equal(fs.existsSync(config.fileOf('webui')), true);
  const mode = fs.statSync(config.fileOf('webui')).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
});

test('字符串端口会被规范化成数字，未知字段被丢弃', () => {
  const value = normalise(NetworkConfigSchema, {
    'http-server': [{ name: 'x', port: '4321', extra: 'drop me' }],
  });
  assert.equal(value['http-server'][0]?.port, 4321);
  assert.equal('extra' in (value['http-server'][0] ?? {}), false);
  // ids are assigned by ConfigStore, not by schema normalisation
  assert.equal(value['http-server'][0]?.id, '');
});

test('非法端口会被拒绝并给出字段路径', () => {
  assert.throws(
    () => normalise(NetworkConfigSchema, { 'http-server': [{ port: 70000 }] }),
    (error: unknown) => {
      assert.equal(error instanceof ConfigError, true);
      const issues = (error as ConfigError).issues.join('\n');
      assert.match(issues, /port/);
      return true;
    },
  );
});

test('保存网络配置会持久化并报告变化的连接', () => {
  const config = store();
  const change = config.saveNetwork({
    'ws-client': [
      { name: 'bot', enabled: true, url: 'ws://127.0.0.1:6700/x', heartbeat: '15000', reconnect: '3000' },
    ],
  });
  assert.equal(change.section, 'network');
  assert.equal(change.changedConnections.length >= 1, true);
  const raw = JSON.parse(fs.readFileSync(config.fileOf('network'), 'utf8'));
  assert.equal(raw['ws-client'][0].heartbeat, 15000);
  assert.equal(raw['http-server'].length, 0);
  const reloaded = new ConfigStore(resolvePaths(path.dirname(path.dirname(config.fileOf('network')))), new Logger(resolvePaths(path.dirname(path.dirname(config.fileOf('network')))), { console: false, level: 'error' }));
  reloaded.load();
  assert.equal(reloaded.network['ws-client'][0]?.url, 'ws://127.0.0.1:6700/x');
});

test('OneBot 配置校验与恢复默认', () => {
  const config = store();
  config.saveOnebot({ messagePostFormat: 'string', heartbeatIntervalMs: '5000' });
  assert.equal(config.onebot.messagePostFormat, 'string');
  assert.equal(config.onebot.heartbeatIntervalMs, 5000);
  assert.throws(() => config.saveOnebot({ heartbeatIntervalMs: 10 }), ConfigError);
  config.reset('onebot');
  assert.equal(config.onebot.messagePostFormat, 'array');
});

test('勾选项缺省时由 schema 补默认值', () => {
  const value = normalise(OnebotConfigSchema, {});
  assert.deepEqual(value.events, {
    privateMessage: true,
    groupMessage: true,
    metaEvent: true,
    notice: true,
    request: true,
  });
  assert.equal(value.reportSelfMessage, false);
  assert.equal(value.messageIdMode, 'hash');
});
