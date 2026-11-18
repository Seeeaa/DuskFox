import fs from 'node:fs';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const tokenPath = '/run/bridge/admin.token';
let token = '';
for (let attempt = 0; attempt < 60; attempt += 1) {
  try { token = fs.readFileSync(tokenPath, 'utf8').trim(); } catch { /* QQ writes it on first start. */ }
  if (token) break;
  await delay(1000);
}
if (!token) throw new Error('QQ bridge token was not created within 60 seconds');
process.env.DUSKFOX_BRIDGE_TOKEN = token;

const configDir = '/state/config';
fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
const networkFile = `${configDir}/network.json`;
const onebotTokenFile = `${configDir}/onebot.token`;
if (!fs.existsSync(networkFile)) {
  let onebotToken = '';
  try { onebotToken = fs.readFileSync(onebotTokenFile, 'utf8').trim(); } catch { /* First start. */ }
  if (!onebotToken) {
    onebotToken = crypto.randomBytes(24).toString('base64url');
    fs.writeFileSync(onebotTokenFile, onebotToken, { mode: 0o600, flag: 'wx' });
  }
  const config = {
    'http-server': [{ id: '', name: 'OneBot HTTP + WS', enabled: true,
      host: '0.0.0.0', port: 3000, token: onebotToken, cors: false, enableWs: true }],
    'http-client': [], sse: [], 'ws-server': [], 'ws-client': [],
  };
  fs.writeFileSync(networkFile, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
}
process.argv = [process.execPath, '/app/dist/main.js',
  '--driver', 'bridge', '--bridge-url', 'http://qq:16082',
  '--workdir', '/state', '--host', '0.0.0.0', '--port', '6099'];
await import('/app/dist/main.js');
