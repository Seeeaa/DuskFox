#!/usr/bin/env node
/**
 * 实机联调脚本（需要真实 QQ 运行时与测试号）。
 *
 * 只通过环境变量拿参数，绝不把密码写入文件或日志：
 *   RUNTIME_URL / RUNTIME_TOKEN     运行时桥接地址与令牌
 *   CONSOLE_URL / CONSOLE_TOKEN     框架控制台
 *   ACCOUNT / PASSWORD              可选：先做密码登录（测试号）
 *   PEER_UIN                        私聊测试对象 QQ
 *   GROUP_ID                        群测试对象
 *   IMAGE_PATH                      图片发送用本地文件（PNG/JPG）
 *   HTTP_PORT                       OneBot HTTP 端口（可选，默认从 /api/status 读）
 *
 * 用法：
 *   $env:CONSOLE_URL="http://127.0.0.1:6099"; ...
 *   node tools/live-test.mjs
 */
import fs from 'node:fs';

const env = process.env;
const RUNTIME_URL = (env.RUNTIME_URL || 'http://127.0.0.1:16082').replace(/\/$/, '');
const RUNTIME_TOKEN = env.RUNTIME_TOKEN || '';
const CONSOLE_URL = (env.CONSOLE_URL || 'http://127.0.0.1:6099').replace(/\/$/, '');
const CONSOLE_TOKEN = env.CONSOLE_TOKEN || '';
const PEER_UIN = env.PEER_UIN || '';
const GROUP_ID = env.GROUP_ID || '';
const IMAGE_PATH = env.IMAGE_PATH || '';
const ACCOUNT = env.ACCOUNT || '';
const PASSWORD = env.PASSWORD || '';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

let session = '';

async function consoleApi(method, pathname, body) {
  const result = await jsonFetch(CONSOLE_URL + pathname, {
    method,
    headers: {
      accept: 'application/json',
      ...(session ? { authorization: 'Bearer ' + session } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return result;
}

async function runtimeApi(method, pathname, body) {
  return jsonFetch(RUNTIME_URL + pathname, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(RUNTIME_TOKEN ? { authorization: 'Bearer ' + RUNTIME_TOKEN } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function waitOnline(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await consoleApi('GET', '/api/status');
    if (status.body?.account?.online) return status.body;
    await delay(1000);
  }
  throw new Error('账号在超时时间内未上线');
}

async function main() {
  if (!CONSOLE_TOKEN) throw new Error('缺少 CONSOLE_TOKEN');
  const login = await consoleApi('POST', '/api/auth/login', { token: CONSOLE_TOKEN });
  if (login.status !== 200 || !login.body?.token) throw new Error('控制台登录失败：' + JSON.stringify(login.body));
  session = login.body.token;

  const runtimeStatus = await runtimeApi('GET', '/api/status');
  record('运行时在线且模式可读', runtimeStatus.status === 200, 'mode=' + (runtimeStatus.body?.mode ?? '?'));
  if (Array.isArray(runtimeStatus.body?.pending_native) && runtimeStatus.body.pending_native.length > 0) {
    console.log('待实机验证的原生调用：' + runtimeStatus.body.pending_native.join('；'));
  }

  if (ACCOUNT && PASSWORD) {
    const started = Date.now();
    const loginResult = await consoleApi('POST', '/api/account/login', {
      method: 'password',
      uin: ACCOUNT,
      password: PASSWORD,
    });
    record('密码登录请求', loginResult.status === 200, JSON.stringify(loginResult.body));
    if (loginResult.status !== 200) {
      console.log('密码登录失败，后续需要账号已在线才能继续；错误：' + JSON.stringify(loginResult.body));
    } else {
      await waitOnline(90_000);
      record('密码登录后账号上线', true, Math.round((Date.now() - started) / 1000) + 's');
    }
  } else {
    console.log('未提供 ACCOUNT/PASSWORD：跳过登录，仅验证已在线会话。');
  }

  const status = await waitOnline(30_000);
  record('控制台可见账号在线', status.account.online === true, 'uin=' + status.account.uin);

  const info = await consoleApi('POST', '/api/action/get_login_info', {});
  record('get_login_info', info.body?.status === 'ok', JSON.stringify(info.body?.data ?? info.body));

  // 私聊文本 + 撤回 + get_msg
  if (!PEER_UIN) {
    record('私聊文本发送', false, '缺少 PEER_UIN');
  } else {
    const sent = await consoleApi('POST', '/api/action/send_private_msg', {
      user_id: Number(PEER_UIN),
      message: 'duskfox 实机测试：私聊文本 ' + new Date().toISOString(),
    });
    record('私聊文本发送', sent.body?.status === 'ok', JSON.stringify(sent.body?.data ?? sent.body));
    const messageId = sent.body?.data?.message_id;
    if (messageId) {
      const got = await consoleApi('POST', '/api/action/get_msg', { message_id: messageId });
      record('get_msg 查询刚发送的消息', got.body?.status === 'ok', JSON.stringify(got.body?.data?.raw_message ?? got.body));
      const recall = await consoleApi('POST', '/api/action/delete_msg', { message_id: messageId });
      record('撤回刚发送的私聊', recall.body?.status === 'ok', JSON.stringify(recall.body));
    }
  }

  // 群文本
  if (!GROUP_ID) {
    record('群文本发送', false, '缺少 GROUP_ID');
  } else {
    const sent = await consoleApi('POST', '/api/action/send_group_msg', {
      group_id: Number(GROUP_ID),
      message: 'duskfox 实机测试：群文本 ' + new Date().toISOString(),
    });
    record('群文本发送', sent.body?.status === 'ok', JSON.stringify(sent.body?.data ?? sent.body));
  }

  // 图片
  if (!IMAGE_PATH) {
    record('图片发送', false, '缺少 IMAGE_PATH');
  } else if (!fs.existsSync(IMAGE_PATH)) {
    record('图片发送', false, '文件不存在：' + IMAGE_PATH);
  } else {
    const target = GROUP_ID
      ? { action: 'send_group_msg', body: { group_id: Number(GROUP_ID), message: [{ type: 'image', data: { file: IMAGE_PATH } }] } }
      : { action: 'send_private_msg', body: { user_id: Number(PEER_UIN), message: [{ type: 'image', data: { file: IMAGE_PATH } }] } };
    const sent = await consoleApi('POST', '/api/action/' + target.action, target.body);
    record('图片发送', sent.body?.status === 'ok', JSON.stringify(sent.body?.data ?? sent.body));
  }

  // OneBot HTTP（独立端口）动作
  const httpConn = status.onebot.connections.find((c) => c.kind === 'http-server' && c.status === 'listening');
  if (!httpConn) {
    record('OneBot HTTP 独立端口', false, '没有启用的 HTTP 服务端');
  } else {
    const version = await jsonFetch(httpConn.address + '/get_version_info');
    record('OneBot HTTP get_version_info', version.status === 200 && version.body?.status === 'ok', httpConn.address);
  }

  // 入站等待：由另一个账号/群里发消息
  console.log('');
  console.log('现在请在测试对象（' + (PEER_UIN || '<peer>') + '）向我发一条私聊，或在群里发一条消息…');
  const before = (await consoleApi('GET', '/api/events?limit=200')).body?.items?.length ?? 0;
  const deadline = Date.now() + 90_000;
  let inbound = null;
  while (Date.now() < deadline) {
    const events = await consoleApi('GET', '/api/events?limit=200');
    const items = events.body?.items ?? [];
    inbound = items.find((item) => item.type === 'message.private' || item.type === 'message.group');
    if (inbound) break;
    await delay(1500);
  }
  record('入站消息进入 OneBot 事件流', Boolean(inbound), inbound ? inbound.type + ' · ' + inbound.summary : '90 秒内未收到');

  console.log('');
  const failed = results.filter((r) => !r.ok);
  console.log('通过 ' + (results.length - failed.length) + ' / ' + results.length);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('实机测试中断：', error instanceof Error ? error.message : error);
  process.exit(1);
});
