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

(async () => {
  try {
    // 先装载官方 launcher（旧桥接同样的做法），失败不阻断桥接本身。
    require('./application.asar/app_launcher/index.js');
  } catch (error) {
    console.log('[bridge] official launcher load failed:', error && error.message);
  }

  const { NativeKernel } = require('./native-kernel.cjs');
  const { createBridgeServer, attachKernelEvents } = await import('./server.mjs');

  const kernel = new NativeKernel();
  const bridge = createBridgeServer({
    kernel,
    token,
    qrPump: process.env.QQ_BRIDGE_QR_PUMP !== '0',
    qrCooldownMs: Number(process.env.QQ_BRIDGE_QR_COOLDOWN_MS || 90000),
  });
  await attachKernelEvents(bridge, kernel);

  const port = Number(process.env.QQ_NATIVE_UI_PORT || 16082);
  const host = process.env.QQ_NATIVE_UI_HOST || '127.0.0.1';
  await bridge.listen(port, host);
  console.log('[bridge] listening http://' + host + ':' + port + ' mode=native');
})();
