'use strict';

// OneBot v11 text-only adapter for duskfox.
// Run in a separate Node 24 process with access to the bridge token file.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const WebSocket = require('ws');

const dir = process.env.QQ_BRIDGE_DATA_DIR || path.join(process.env.HOME || '/home/node', '.qq-native-bridge');
const nativeToken = fs.readFileSync(path.join(dir, 'admin.token'), 'utf8').trim();
const onebotTokenPath = path.join(dir, 'onebot.token');
if (!fs.existsSync(onebotTokenPath)) {
  fs.writeFileSync(onebotTokenPath, crypto.randomBytes(24).toString('base64url'),
    { flag: 'wx', mode: 0o600 });
}
const onebotToken = fs.readFileSync(onebotTokenPath, 'utf8').trim();
const nativeBase = process.env.QQ_NATIVE_BASE || 'http://127.0.0.1:16082';
const nativeHeaders = { Authorization: `Bearer ${nativeToken}` };
let cursor = 0;
let cursorInitialized = false;
let online = false;
let eventsReady = false;
let selfId = 0;
let reverse = null;
let polling = false;
let lastConnectAttempt = 0;
const reverseUrl = process.env.QQ_BRIDGE_REVERSE_WS || '';
const reverseToken = process.env.QQ_BRIDGE_REVERSE_TOKEN || '';

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
    if (name === 'get_status') return result({ online, good: online && eventsReady }, echo);
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
}).listen(Number(process.env.QQ_ONEBOT_PORT || 13001), process.env.QQ_ONEBOT_HOST || '127.0.0.1');

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const status = await native('/api/status');
    online = Boolean(status.message_ready);
    selfId = Number(status.self_id || 0);
    if (!online || !Number.isSafeInteger(selfId) || selfId <= 0) return;
    try {
      const batch = await native(`/api/events?after=${cursor}`);
      eventsReady = true;
      if (!cursorInitialized) {
        // Start from the live edge so an adapter restart does not replay old chats.
        cursor = Number(batch.cursor || 0);
        cursorInitialized = true;
      } else if (Number(batch.cursor) < cursor) {
        // The QQ bridge restarted and its in-memory sequence began again.
        cursor = 0;
      } else if (reverse?.readyState === WebSocket.OPEN) {
        for (const item of batch.events || []) {
          if (!Number.isSafeInteger(item.cursor) || item.cursor <= cursor) continue;
          await new Promise((resolve, reject) => reverse.send(JSON.stringify(item.data),
            error => error ? reject(error) : resolve()));
          cursor = item.cursor;
        }
      }
    } catch (_) { eventsReady = false; /* An older QQ session may lack this route. */ }
    connectReverse();
  } catch (_) {
    online = false;
    eventsReady = false;
  } finally {
    polling = false;
  }
}

function sendMeta(type) {
  if (reverse?.readyState !== WebSocket.OPEN) return;
  const data = { time: Math.floor(Date.now() / 1000), self_id: selfId,
    post_type: 'meta_event', meta_event_type: type };
  if (type === 'lifecycle') data.sub_type = 'connect';
  else { data.status = { online, good: online && eventsReady }; data.interval = 30000; }
  reverse.send(JSON.stringify(data));
}

function connectReverse() {
  if (!reverseUrl || reverse || !online || !eventsReady || !selfId || Date.now() - lastConnectAttempt < 3000) return;
  lastConnectAttempt = Date.now();
  try {
    const headers = { 'X-Self-ID': String(selfId), 'X-Client-Role': 'Universal',
      'User-Agent': 'duskfox/0.1.0' };
    if (reverseToken) headers.Authorization = `Bearer ${reverseToken}`;
    const ws = new WebSocket(reverseUrl, { headers, handshakeTimeout: 5000,
      maxPayload: 65536, perMessageDeflate: false });
    reverse = ws;
    ws.on('open', () => { sendMeta('lifecycle'); void poll(); });
    ws.on('message', async raw => {
      try {
        const command = JSON.parse(raw.toString());
        if (!command || typeof command.action !== 'string') return;
        const answer = await action(command.action, command.params || {}, command.echo);
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(answer));
      } catch (_) { /* Ignore malformed or interrupted requests. */ }
    });
    ws.on('close', () => { if (reverse === ws) reverse = null; });
    ws.on('error', () => {});
  } catch (_) {
    reverse = null;
  }
}

setInterval(() => { void poll(); }, 1000);
setInterval(() => { sendMeta('heartbeat'); }, 30000);
void poll();
console.log('onebot_gateway_listening');
