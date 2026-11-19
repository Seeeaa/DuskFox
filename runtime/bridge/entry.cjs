'use strict';
/**
 * 在 QQ 进程内启动桥接服务。
 *
 * 加载方式沿用旧桥接：由官方 launcher 替换 main 后 require 本文件
 * （或由外部注入器在进程内执行）。本文件不改变 QQ 的业务行为，
 * 只观测会话/登录回调并把事件暴露给 duskfox 框架。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dataDir = process.env.QQ_BRIDGE_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.qq-native-bridge');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const tokenFile = path.join(dataDir, 'admin.token');
if (!fs.existsSync(tokenFile)) {
  fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString('base64url'), { mode: 0o600, flag: 'wx' });
}
const token = process.env.QQ_BRIDGE_TOKEN || fs.readFileSync(tokenFile, 'utf8').trim();

// Capture the session created by the official launcher. On this QQ build the
// static getNTWrapperSession lookup can return no session even while QQ is
// logged in; the existing lab bridge verified this capture point in practice.
let capturedSession = null;
let wrapperObserved = false;
const observedSessions = new WeakSet();
const sessionAccounts = new WeakMap();

function observeSession(session) {
  if (!session || typeof session.getMsgService !== 'function') return session;
  if (!sessionAccounts.has(capturedSession)) capturedSession = session;
  if (observedSessions.has(session) || typeof session.init !== 'function') return session;
  observedSessions.add(session);
  const init = session.init;
  try {
    Object.defineProperty(session, 'init', {
      configurable: true,
      writable: true,
      value(...args) {
        const result = Reflect.apply(init, this, args);
        // The official client supplies the account when it initializes this session.
        const uin = String(args[0]?.selfUin ?? '');
        if (/^[1-9]\d{4,11}$/.test(uin)) {
          sessionAccounts.set(session, { uin });
          capturedSession = session;
        }
        return result;
      },
    });
  } catch (error) {
    console.warn('[bridge] cannot observe QQ session initialization:', error.message);
  }
  return session;
}

const originalDlopen = process.dlopen;
process.dlopen = function (...args) {
  const result = Reflect.apply(originalDlopen, this, args);
  const [loadedModule, filename] = args;
  if (path.basename(String(filename)) !== 'wrapper.node' || wrapperObserved) return result;
  wrapperObserved = true;
  const nativeExports = loadedModule.exports;
  const nativeSessionType = nativeExports.NodeIQQNTWrapperSession;
  if (nativeSessionType) {
    const sessionFacade = new Proxy(function () {}.bind(null), {
      get(_target, key) {
        const member = Reflect.get(nativeSessionType, key, nativeSessionType);
        if (typeof member !== 'function' || (key !== 'create' && key !== 'getNTWrapperSession')) return member;
        return (...callArgs) => observeSession(Reflect.apply(member, nativeSessionType, callArgs));
      },
      has(_target, key) { return Reflect.has(nativeSessionType, key); },
      getPrototypeOf() { return Reflect.getPrototypeOf(nativeSessionType); },
      construct(_target, callArgs) { return observeSession(Reflect.construct(nativeSessionType, callArgs)); },
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
  }
  process.dlopen = originalDlopen;
  return result;
};

(async () => {
  try {
    // 先装载官方 launcher（旧桥接同样的做法），失败不阻断桥接本身。
    require('./application.asar/app_launcher/index.js');
  } catch (error) {
    console.log('[bridge] official launcher load failed:', error && error.message);
  }

  const { NativeKernel } = require('./native-kernel.cjs');
  const { createBridgeServer, attachKernelEvents } = await import('./server.mjs');

  const kernel = new NativeKernel({
    wrapperObserved: () => wrapperObserved,
    sessionProvider: () => capturedSession,
    sessionAccount: (session) => sessionAccounts.get(session),
  });
  const bridge = createBridgeServer({
    kernel,
    token,
    qrPump: process.env.QQ_BRIDGE_QR_PUMP !== '0',
    autoQr: false,
  });
  await attachKernelEvents(bridge, kernel);

  const port = Number(process.env.QQ_NATIVE_UI_PORT || 16082);
  const host = process.env.QQ_NATIVE_UI_HOST || '127.0.0.1';

  // HTTP can recover independently of the QQ session, native listeners and event ring.
  const listen = async () => {
    try {
      await bridge.listen(port, host);
      console.log('[bridge] listening http://' + host + ':' + port + ' mode=native');
    } catch (error) {
      console.warn('[bridge] cannot listen:', error.message);
      if (error.code === 'EADDRINUSE' || error.code === 'EADDRNOTAVAIL') retryListen();
    }
  };
  const retryListen = () => setTimeout(listen, 2000).unref();
  bridge.server.on('close', retryListen);
  await listen();
})();
