import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Logger } from '../src/core/logger.ts';
import { resolvePaths } from '../src/core/paths.ts';
import { SmtpNotifications } from '../src/notify.ts';

test('SMTP 授权码落盘后不回传给控制台，空密码保存沿用旧值', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duskfox-notify-'));
  const paths = resolvePaths(root);
  fs.mkdirSync(paths.config, { recursive: true });
  const logger = new Logger(paths, { console: false });
  const notify = new SmtpNotifications(paths.config, logger);
  notify.update({ host: 'smtp.example.test', username: 'user', password: 'secret-value' });
  notify.update({ port: 587, password: '' });
  const publicValue = notify.publicSettings();
  assert.equal(publicValue.passwordConfigured, true);
  assert.equal('password' in publicValue, false);
  assert.equal(publicValue.port, 587);
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.config, 'notify.json'), 'utf8')).password, 'secret-value');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(paths.config, 'notify.json')).mode & 0o777, 0o600);
});
