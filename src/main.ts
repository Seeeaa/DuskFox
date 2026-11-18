#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { Application } from './app.ts';
import { VERSION } from './version.ts';

const HELP = `duskfox ${VERSION} — QQ → OneBot v11 连接器（Windows / Linux）

用法：
  duskfox [选项]

选项：
  -w, --workdir <目录>     实例工作目录（默认 ~/.duskfox，或 DUSKFOX_WORKDIR）
      --driver <id>       账号驱动：mock | bridge（默认 mock）
      --host <地址>        控制台监听地址（覆盖配置）
  -p, --port <端口>        控制台端口（覆盖配置，0 表示随机）
      --bridge-url <地址>  原生桥接服务地址（bridge 驱动）
      --bridge-token <令牌> 原生桥接服务令牌
      --simulate           mock 驱动产生模拟入站消息
      --no-auto-login      mock 驱动不自动登录
      --log-level <级别>   debug | info | warn | error
  -h, --help               显示帮助
  -v, --version            显示版本

说明：
  控制台令牌保存在 <工作目录>/config/webui.json，首次启动自动生成。
  停止：Ctrl+C 或 SIGTERM，进程会先关闭监听再退出。
`;

function fail(message: string): never {
  process.stderr.write(`duskfox: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: false,
      options: {
        workdir: { type: 'string', short: 'w' },
        driver: { type: 'string' },
        host: { type: 'string' },
        port: { type: 'string', short: 'p' },
        'bridge-url': { type: 'string' },
        'bridge-token': { type: 'string' },
        simulate: { type: 'boolean' },
        'no-auto-login': { type: 'boolean' },
        'log-level': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const values = parsed.values;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) fail('端口必须是 0-65535 的整数');
  const logLevel = values['log-level'] as 'debug' | 'info' | 'warn' | 'error' | undefined;
  if (logLevel && !['debug', 'info', 'warn', 'error'].includes(logLevel)) fail('日志级别只能是 debug / info / warn / error');

  const app = new Application({
    ...(values.workdir ? { root: values.workdir } : {}),
    driver: values.driver ?? 'mock',
    driverOptions: {
      ...(values['bridge-url'] ? { endpoint: values['bridge-url'] } : {}),
      ...(values['bridge-token'] ? { token: values['bridge-token'] } : {}),
      simulate: Boolean(values.simulate),
      autoLogin: !values['no-auto-login'],
    },
    ...(values.host ? { webuiHost: values.host } : {}),
    ...(port !== undefined ? { webuiPort: port } : {}),
    ...(logLevel ? { logLevel } : {}),
  });

  // 计数是防抖写盘的：进程退出前同步 flush，Fox 重启后计数才能延续。
  process.once('exit', () => app.stats.flush());

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    app.logger.warn('app', `收到 ${signal}，正在停止`);
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (error) => {
    app.logger.failure('app', '未捕获异常', error);
    process.exitCode = 1;
  });
  process.on('unhandledRejection', (reason) => {
    app.logger.failure('app', '未处理的 Promise 拒绝', reason);
  });

  try {
    await app.start();
  } catch (error) {
    app.logger.failure('app', '启动失败', error);
    process.exit(1);
  }
}

void main();
