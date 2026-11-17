/**
 * 离线宿主：用模拟 QQ 内核跑真实的桥接服务代码。
 *
 * 用法：node runtime/bridge/offline-host.mjs --port 0 [--token xxx] [--passive]
 * 启动后在 stdout 打印一行 JSON：{"port":<实际端口>,"mode":"sim"}
 */
import { createSimKernelFromEnv } from './sim-kernel.mjs';
import { createBridgeServer, attachKernelEvents } from './server.mjs';

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  return value === undefined ? true : value;
}

const port = Number(arg('port', process.env.QQ_BRIDGE_PORT ?? 0));
const passive = Boolean(arg('passive', false)) || process.env.QQ_BRIDGE_LOGIN_MODE === 'passive';
const token = String(arg('token', process.env.QQ_BRIDGE_TOKEN ?? 'offline-test-token'));

const kernel = createSimKernelFromEnv();
const bridge = createBridgeServer({
  kernel,
  token,
  qrPump: !passive,
  qrCooldownMs: Number(process.env.QQ_BRIDGE_QR_COOLDOWN_MS ?? 2000),
});
await attachKernelEvents(bridge, kernel);
const address = await bridge.listen(port, '127.0.0.1');
const actual = typeof address === 'object' && address ? address.port : port;
console.log(JSON.stringify({ port: actual, mode: 'sim', passive }));

const shutdown = async () => {
  await bridge.close();
  await kernel.stop();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
