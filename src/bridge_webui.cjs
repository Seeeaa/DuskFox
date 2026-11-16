'use strict';

// Experimental adapter loaded inside an isolated, official QQ Electron runtime.
// QQ owns its login flow; this file only observes native events and exposes a
// token-protected local management page. It does not print QR codes or chats.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const dataDir = path.join(process.env.HOME || '/home/node', '.qq-native-bridge');
const passiveLogin = process.env.QQ_NATIVE_LOGIN_MODE !== 'active';
const tokenFile = path.join(dataDir, 'admin.token');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(tokenFile)) {
  fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('base64url'), { mode: 0o600, flag: 'wx' });
}
const adminToken = fs.readFileSync(tokenFile, 'utf8').trim();
const ui = fs.readFileSync(path.join(__dirname, 'bridge_webui.html'), 'utf8');
const state = {
  phase: 'starting', qr: null, error: '', selfId: null, messageReady: false,
  messageEvents: 0, messageShape: null, loginHistoryCount: null,
  lastPrivateMessageReady: false, testReplySent: false, testReplyResult: null,
  nativeProbe: { msfStatus: null, sessionPresent: false, messagePresent: false, errorName: null,
    wrapperObserved: false, wrapperLoadedByBridge: false, sessionCaptures: 0 },
  loginEvents: { connected: 0, disconnected: 0, qrSucceeded: 0, logoutSucceeded: 0 },
};
let loginService = null;
let messageService = null;
let loginListenerReady = false;
let loginListener = null;
let messageListener = null;
let capturedSession = null;
let lastPrivatePeer = null;
const privatePeers = new Map();
const recentEvents = [];
const seenMessageIds = new Set();
let eventCursor = 0;

// Observe the session QQ itself creates. This preserves the original return
// values and only records a reference for later read-only service checks.
const originalDlopen = process.dlopen;
process.dlopen = function (...args) {
  const result = Reflect.apply(originalDlopen, this, args);
  const [loadedModule, filename] = args;
  if (path.basename(String(filename)) !== 'wrapper.node' || state.nativeProbe.wrapperObserved) return result;
  state.nativeProbe.wrapperObserved = true;
  state.nativeProbe.wrapperLoadedByBridge = /attachLogin|attachMessages/.test(new Error().stack || '');
  const nativeExports = loadedModule.exports;
  const nativeSessionType = nativeExports.NodeIQQNTWrapperSession;
  if (!nativeSessionType) return result;

  const sessionFacade = new Proxy(function () {}.bind(null), {
    get(_target, key) {
      const member = Reflect.get(nativeSessionType, key, nativeSessionType);
      if (typeof member !== 'function' || (key !== 'create' && key !== 'getNTWrapperSession')) return member;
      return (...callArgs) => {
        const session = Reflect.apply(member, nativeSessionType, callArgs);
        if (session && typeof session.getMsgService === 'function') {
          capturedSession = session;
          state.nativeProbe.sessionCaptures += 1;
          state.nativeProbe.sessionPresent = true;
        }
        return session;
      };
    },
    has(_target, key) { return Reflect.has(nativeSessionType, key); },
    getPrototypeOf() { return Reflect.getPrototypeOf(nativeSessionType); },
    construct(_target, callArgs) { return Reflect.construct(nativeSessionType, callArgs); },
  });
  loadedModule.exports = new Proxy({}, {
    get(_target, key) {
      return key === 'NodeIQQNTWrapperSession' ? sessionFacade
        : Reflect.get(nativeExports, key, nativeExports);
    },
    has(_target, key) { return Reflect.has(nativeExports, key); },
    ownKeys() { return Reflect.ownKeys(nativeExports); },
    getOwnPropertyDescriptor(_target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(nativeExports, key);
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
  process.dlopen = originalDlopen;
  console.log('native_wrapper_observed');
  return result;
};

function isAuthorized(request) {
  const header = request.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(adminToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function respond(response, code, value, type = 'application/json; charset=utf-8') {
  response.writeHead(code, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  response.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
}

http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/') {
    return respond(response, 200, ui, 'text/html; charset=utf-8');
  }
  if (!isAuthorized(request)) return respond(response, 401, { error: 'unauthorized' });
  if (request.method === 'GET' && url.pathname === '/api/status') {
    return respond(response, 200, {
      phase: state.phase, error: state.error, self_id: state.selfId,
      qr_ready: Boolean(state.qr), message_ready: state.messageReady,
      message_events: state.messageEvents, message_shape: state.messageShape,
      last_private_message_ready: state.lastPrivateMessageReady,
      test_reply_sent: state.testReplySent, test_reply_result: state.testReplyResult,
      login_history_count: state.loginHistoryCount, login_mode: passiveLogin ? 'passive' : 'active',
      native_probe: state.nativeProbe, login_events: state.loginEvents,
    });
  }
  if (request.method === 'GET' && url.pathname === '/api/events') {
    const after = Number(url.searchParams.get('after') || 0);
    const events = recentEvents.filter(item => item.cursor > after).slice(0, 100);
    return respond(response, 200, { cursor: eventCursor, events });
  }
  if (request.method === 'POST' && url.pathname === '/api/send-private') {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 4096) request.destroy();
    });
    request.on('end', async () => {
      try {
        if (!state.messageReady || !messageService) return respond(response, 503, { error: 'offline' });
        const input = JSON.parse(body);
        const uin = String(input.user_id || '');
        const content = input.message;
        if (!/^\d{5,12}$/.test(uin) || typeof content !== 'string' || !content.trim() || content.length > 1000) {
          return respond(response, 400, { error: 'invalid private text message' });
        }
        const uid = privatePeers.get(uin);
        if (!uid) return respond(response, 404, { error: 'recipient has not messaged this session' });
        const element = { elementType: 1, elementId: '', textElement: {
          content, atType: 0, atUid: '', atTinyId: '', atNtUid: '' } };
        const result = await messageService.sendMsg('0', { chatType: 1, peerUid: uid }, [element], new Map());
        return respond(response, result?.result === 0 ? 200 : 502,
          { ok: result?.result === 0, message_id: result?.result === 0 ? ++eventCursor : null });
      } catch (_) { return respond(response, 500, { error: 'native send failed' }); }
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/qr') {
    return state.qr ? respond(response, 200, { image: state.qr })
      : respond(response, 404, { error: 'QR not available' });
  }
  if (request.method === 'POST' && url.pathname === '/api/qr/refresh') {
    if (passiveLogin) return respond(response, 409, { error: '请在 QQ 原窗口刷新二维码' });
    if (!loginService) return respond(response, 503, { error: 'QQ login service is starting' });
    try {
      state.phase = 'requesting_qr';
      state.qr = null;
      const accepted = Boolean(loginService.getQRCodePicture());
      return respond(response, accepted ? 202 : 503, { accepted });
    } catch (error) {
      state.phase = 'error';
      state.error = `${error.name}: QR request failed`;
      return respond(response, 503, { error: state.error });
    }
  }
  if (request.method === 'POST' && url.pathname === '/api/test-reply') {
    if (!state.messageReady || !messageService || !lastPrivatePeer) {
      return respond(response, 409, { error: 'no received private message to reply to' });
    }
    if (state.testReplySent) return respond(response, 409, { error: 'test reply already sent' });
    const element = {
      elementType: 1, elementId: '',
      textElement: { content: 'QQ 连接器原生消息发送验证', atType: 0,
        atUid: '', atTinyId: '', atNtUid: '' },
    };
    try {
      const pending = messageService.sendMsg('0', lastPrivatePeer, [element], new Map());
      state.testReplySent = true;
      state.testReplyResult = 'pending';
      Promise.resolve(pending).then(
        result => { state.testReplyResult = result?.result === 0 ? 'ok' : 'rejected'; },
        () => { state.testReplyResult = 'error'; }
      );
    } catch (_) {
      state.testReplyResult = 'error';
      return respond(response, 503, { error: 'native send call failed' });
    }
    return respond(response, 202, { accepted: true });
  }
  return respond(response, 404, { error: 'not found' });
}).listen(Number(process.env.QQ_NATIVE_UI_PORT || 16082), '0.0.0.0', () => {
  console.log('bridge_webui_listening');
});

try {
  require('./application.asar/app_launcher/index.js');
  console.log('official_launcher_loaded');
} catch (error) {
  state.phase = 'error';
  state.error = `${error.name}: official launcher failed`;
  console.log('official_launcher_error', error.name, error.message);
}

function attachLogin() {
  if (loginListenerReady || !state.nativeProbe.wrapperObserved) return;
  try {
    loginService = require('./wrapper.node').NodeIKernelLoginService.get();
    loginListener = new Proxy({
      onQRCodeGetPicture(value) {
        const input = value?.pngBase64QrcodeData;
        if (typeof input !== 'string') return;
        const base64 = input.replace(/^data:image\/png;base64,/, '');
        if (!/^[A-Za-z0-9+/=]+$/.test(base64) || base64.length > 2_000_000) return;
        state.qr = `data:image/png;base64,${base64}`;
        state.phase = 'scan_qr';
        state.error = '';
        console.log('native_qr_ready');
      },
      onQRCodeSessionUserScaned() { state.phase = 'confirm_on_phone'; state.qr = null; },
      onQRCodeLoginSucceed(result) {
        state.loginEvents.qrSucceeded += 1;
        state.selfId = /^\d+$/.test(String(result?.uin || '')) ? String(result.uin) : null;
        state.phase = 'authenticated';
        state.qr = null;
        state.error = '';
        console.log('native_login_succeeded');
      },
      onQRCodeSessionFailed() {
        if (state.selfId) return;
        state.phase = 'qr_failed'; state.qr = null; state.error = 'QR session failed; refresh to retry';
      },
      onLoginFailed() { if (!state.selfId) { state.phase = 'error'; state.error = 'QQ login failed'; } },
      onLoginConnected() {
        state.loginEvents.connected += 1;
        if (state.selfId && !state.messageReady) state.phase = 'checking_session';
      },
      onLoginDisConnected() {
        state.loginEvents.disconnected += 1;
        state.phase = 'checking_session';
      },
      onLogoutSucceed() {
        state.loginEvents.logoutSucceeded += 1;
        state.phase = 'checking_session'; state.messageReady = false;
        messageService = null; messageListener = null;
      },
    }, {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key === 'string' && key.startsWith('on')) return () => {};
        return undefined;
      },
    });
    loginService.addKernelLoginListener(loginListener);
    loginListenerReady = true;
    state.phase = passiveLogin ? 'waiting_official_qq_login' : 'waiting_login';
    loginService.getLoginList().then((result) => {
      state.loginHistoryCount = result?.LocalLoginInfoList?.length ?? null;
    }).catch(() => {});
    console.log('native_login_listener_ready');
    if (!passiveLogin) {
      setTimeout(() => {
        if (!state.selfId && state.phase === 'waiting_login') {
          try { loginService.getQRCodePicture(); } catch (_) {}
        }
      }, 3000);
    }
  } catch (error) {
    state.error = `${error.name}: login service unavailable`;
  }
}

function attachMessages() {
  if (!loginListenerReady || !capturedSession || state.messageReady) return;
  try {
    const msfStatus = loginService.getMsfStatus();
    state.nativeProbe.msfStatus = msfStatus;
    if (!state.selfId && msfStatus !== 2) return;
    const session = capturedSession;
    state.nativeProbe.sessionPresent = Boolean(session);
    const candidate = session?.getMsgService?.();
    state.nativeProbe.messagePresent = Boolean(candidate);
    if (!candidate) return;
    messageService = candidate;
    messageListener = new Proxy({
      onRecvMsg(messages) {
        if (!Array.isArray(messages)) return;
        state.messageEvents += messages.length;
        if (!state.messageShape && messages[0] && typeof messages[0] === 'object') {
          state.messageShape = Object.keys(messages[0]).sort();
        }
        for (const msg of messages) {
          if (msg?.chatType !== 1 || !msg.senderUid || !msg.peerUid || msg.isImportMsg === true) continue;
          if (state.selfId && String(msg.senderUin) === state.selfId) continue;
          lastPrivatePeer = { chatType: 1, peerUid: String(msg.peerUid) };
          state.lastPrivateMessageReady = true;
          const uin = String(msg.senderUin || '');
          if (!/^\d{5,12}$/.test(uin)) continue;
          privatePeers.set(uin, String(msg.peerUid));
          if (privatePeers.size > 1024) privatePeers.delete(privatePeers.keys().next().value);
          const rawTime = Number(msg.msgTime || msg.timeStamp || 0);
          const timestamp = rawTime > 1e12 ? Math.floor(rawTime / 1000) : rawTime;
          if (!timestamp || Math.abs(Date.now() / 1000 - timestamp) > 120) continue;
          const content = (Array.isArray(msg.elements) ? msg.elements : [])
            .map(element => element?.textElement?.content || '').join('');
          if (!content) continue;
          const nativeId = String(msg.msgId && String(msg.msgId) !== '0'
            ? msg.msgId : (msg.msgSeq || ''));
          if (nativeId) {
            const key = `${uin}:${nativeId}`;
            if (seenMessageIds.has(key)) continue;
            seenMessageIds.add(key);
            if (seenMessageIds.size > 1024) seenMessageIds.delete(seenMessageIds.values().next().value);
          }
          const cursor = ++eventCursor;
          recentEvents.push({ cursor, data: { time: Math.floor(Date.now() / 1000),
            self_id: Number(state.selfId), post_type: 'message', message_type: 'private',
            sub_type: 'friend', message_id: cursor, user_id: Number(uin),
            message: [{ type: 'text', data: { text: content } }], raw_message: content,
            font: 0, sender: { user_id: Number(uin), nickname: String(msg.sendNickName || uin) } } });
          if (recentEvents.length > 512) recentEvents.shift();
        }
      },
    }, {
      get(target, key) {
        if (key in target) return target[key];
        if (typeof key === 'string' && key.startsWith('on')) return () => {};
        return undefined;
      },
    });
    candidate.addKernelMsgListener(messageListener);
    state.messageReady = true;
    state.phase = 'online';
    state.nativeProbe.errorName = null;
    console.log('native_message_service_ready');
  } catch (error) {
    state.nativeProbe.errorName = String(error?.name || 'Error').slice(0, 40);
  }
}

setInterval(() => { attachLogin(); attachMessages(); }, 2000);
