'use strict';

// OneBot v11 text-only adapter for duskfox.
// Run with Node 24 in the same container as bridge_webui.cjs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

const dir = path.join(process.env.HOME || '/home/node', '.qq-native-bridge');
const nativeToken = fs.readFileSync(path.join(dir, 'admin.token'), 'utf8').trim();
const onebotTokenPath = path.join(dir, 'onebot.token');
if (!fs.existsSync(onebotTokenPath)) {
  fs.writeFileSync(onebotTokenPath, crypto.randomBytes(24).toString('base64url'),
    { flag: 'wx', mode: 0o600 });
}
const onebotToken = fs.readFileSync(onebotTokenPath, 'utf8').trim();
const nativeBase = 'http://127.0.0.1:16082';
const nativeHeaders = { Authorization: `Bearer ${nativeToken}` };
let cursor = 0;
let online = false;
let selfId = 0;
let reverse = null;
const reverseUrl = process.env.QQ_BRIDGE_REVERSE_WS || '';

async function native(pathname, method = 'GET', body) {
  const response = await fetch(nativeBase + pathname, {
    method, headers: { ...nativeHeaders, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`native HTTP ${response.status}`);
  return data;
}

function result(data, echo, error) {
  return { status: error ? 'failed' : 'ok', retcode: error ? 100 : 0,
    data: error ? null : data, message: error || '', wording: error || '', echo };
}

function plainText(input) {
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) throw new Error('message must be text or text segments');
  if (input.some(item => item?.type !== 'text')) throw new Error('only text segments are supported');
  return input.map(item => String(item.data?.text || '')).join('');
}

async function action(name, params = {}, echo) {
  try {
    if (name === 'get_status') return result({ online, good: online }, echo);
    if (name === 'get_login_info') {
      if (!selfId) throw new Error('QQ is offline');
      return result({ user_id: selfId, nickname: String(selfId) }, echo);
    }
    if (name === 'get_version_info') return result({ app_name: 'duskfox',
      app_version: '0.1.0', protocol_version: 'v11' }, echo);
    if (name === 'can_send_image' || name === 'can_send_record') return result({ yes: false }, echo);
    if (name === 'send_private_msg' || name === 'send_msg') {
      if (name === 'send_msg' && params.message_type && params.message_type !== 'private') {
        throw new Error('only private text chat is supported');
      }
      const userId = Number(params.user_id);
      const message = plainText(params.message);
      if (!Number.isSafeInteger(userId) || !message.trim() || message.length > 1000) {
        throw new Error('invalid private text message');
      }
      const sent = await native('/api/send-private', 'POST', { user_id: userId, message });
      return result({ message_id: sent.message_id }, echo);
    }
    throw new Error('unsupported OneBot action');
  } catch (error) { return result(null, echo, error.message); }
}

function authorized(request) {
  const supplied = String(request.headers.authorization || '').replace(/^Bearer /i, '');
  const a = Buffer.from(supplied), b = Buffer.from(onebotToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (!authorized(request)) { response.writeHead(401); response.end(); return; }
  let body = '';
  request.on('data', chunk => {
    body += chunk;
    if (body.length > 4096) request.destroy();
  });
  request.on('end', async () => {
    let params = {};
    try { params = body ? JSON.parse(body) : Object.fromEntries(url.searchParams); }
    catch (_) { response.writeHead(400); response.end(); return; }
    const answer = await action(url.pathname.slice(1), params);
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store' });
    response.end(JSON.stringify(answer));
  });
}).listen(Number(process.env.QQ_ONEBOT_PORT || 13001), '127.0.0.1');

async function poll() {
  try {
    const status = await native('/api/status');
    online = Boolean(status.message_ready);
    selfId = Number(status.self_id || 0);
  } catch (_) { online = false; return; }
  try {
    const batch = await native(`/api/events?after=${cursor}`);
    for (const item of batch.events || []) {
      cursor = Math.max(cursor, item.cursor);
      if (reverse?.readyState === WebSocket.OPEN) reverse.send(JSON.stringify(item.data));
    }
  } catch (_) { /* The native event route becomes available on next QQ startup. */ }
}

function connectReverse() {
  if (!reverseUrl || reverse) return;
  try {
    const ws = new WebSocket(reverseUrl);
    reverse = ws;
    ws.onmessage = async event => {
      try {
        const command = JSON.parse(event.data);
        const answer = await action(String(command.action || ''), command.params || {}, command.echo);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(answer));
      } catch (_) {}
    };
    ws.onclose = () => { reverse = null; };
    ws.onerror = () => {};
  } catch (_) { reverse = null; }
}

setInterval(() => { void poll(); connectReverse(); }, 1000);
void poll();
console.log('onebot_gateway_listening');
