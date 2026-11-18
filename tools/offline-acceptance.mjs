#!/usr/bin/env node
/**
 * 离线验收：编译产物 + 模拟 QQ 内核 + 独立 OneBot HTTP/WS 端口。
 *
 * 运行：npm run build && node tools/offline-acceptance.mjs
 * 退出码 0 表示全部通过；任何一项失败都会打印原因并返回 1。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const RUNTIME_TOKEN = 'offline-runtime-token';
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, fn, timeoutMs = 15_000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(stepMs);
  }
  throw new Error('等待超时：' + label + (lastError ? '（最后错误：' + lastError + '）' : ''));
}

function spawnNode(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.getOutput = () => ({ stdout, stderr });
  return child;
}

async function startRuntime(port = 0) {
  const child = spawnNode(['runtime/bridge/offline-host.mjs', '--port', String(port), '--token', RUNTIME_TOKEN], {
    QQ_BRIDGE_SIM_ONLINE: '1',
    // Keep the pump quiet so the test controls QR issuance explicitly.
    QQ_BRIDGE_QR_COOLDOWN_MS: '600000',
  });
  const line = await waitFor('runtime listening', async () => {
    const match = child.getOutput().stdout.match(/\{"port":\d+[^\n]*\}/);
    if (match) return match[0];
    if (child.exitCode !== null) throw new Error('runtime exited: ' + child.getOutput().stderr);
    return null;
  }, 20_000);
  const info = JSON.parse(line);
  return { child, port: info.port, base: 'http://127.0.0.1:' + info.port };
}

async function startFramework(workdir, runtimeBase) {
  const child = spawnNode([
    'dist/main.js',
    '--workdir', workdir,
    '--port', '0',
    '--driver', 'bridge',
    '--bridge-url', runtimeBase,
    '--bridge-token', RUNTIME_TOKEN,
    '--log-level', 'warn',
  ]);
  const instanceFile = path.join(workdir, 'cache', 'instance.json');
  await waitFor('framework instance.json', () => fs.existsSync(instanceFile), 25_000);
  const info = JSON.parse(fs.readFileSync(instanceFile, 'utf8'));
  const token = JSON.parse(fs.readFileSync(path.join(workdir, 'config', 'webui.json'), 'utf8')).token;
  return { child, base: 'http://127.0.0.1:' + info.webui.port, token };
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'main.js'))) {
    console.error('缺少 dist/main.js，请先运行 npm run build');
    process.exit(1);
  }

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'duskfox-acceptance-'));
  let runtime = await startRuntime();
  const framework = await startFramework(workdir, runtime.base);
  let apiToken = '';
  let botServer = null;
  const botFrames = [];
  const botSockets = new Set();

  const api = async (method, pathname, body, token = apiToken) => {
    const response = await fetch(framework.base + pathname, {
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: response.status, json };
  };

  const runtimeApi = async (method, pathname, body) => {
    const response = await fetch(runtime.base + pathname, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + RUNTIME_TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.json();
  };

  try {
    // ------------------------------------------------------------ 启动与登录
    const login = await fetch(framework.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: framework.token }),
    });
    apiToken = (await login.json()).token ?? '';
    record('编译产物启动 + 控制台登录', login.status === 200 && Boolean(apiToken), framework.base);

    const status = await api('GET', '/api/status');
    record(
      'bridge 驱动连上模拟 QQ 内核并上线',
      status.json.account.online === true && status.json.app.driver.id === 'bridge',
      'uin=' + status.json.account.uin,
    );
    const caps = Object.fromEntries(status.json.capabilities.map((row) => [row.key, row.state]));
    // 媒体位按真实子能力报告：只有图片时必须是 partial，而不是假装全支持。
    record('能力位来自运行时契约（群/图片/查询/请求）',
      caps.group === 'yes' && caps.media === 'partial' && caps.query === 'yes' && caps.requests === 'yes',
      JSON.stringify(caps));

    // ------------------------------------------------------------ 二维码状态
    await runtimeApi('POST', '/sim/online', { value: false });
    await runtimeApi('POST', '/sim/qr', { action: 'issue', ttlMs: 2500 });
    const waiting = await waitFor('qr waiting', async () => {
      const qr = await api('GET', '/api/qr');
      return qr.json.state === 'waiting' ? qr.json : null;
    }, 15_000);
    record('扫码状态：出码且可刷新', Boolean(waiting.image) && waiting.refreshable !== false, 'seq=' + waiting.seq);
    const expired = await waitFor('qr expired', async () => {
      const qr = await api('GET', '/api/qr');
      return qr.json.state === 'expired' ? qr.json : null;
    }, 15_000);
    record('扫码状态：过期', expired.state === 'expired');
    const refreshed = await api('POST', '/api/qr/refresh');
    await waitFor('qr refresh waiting', async () => (await api('GET', '/api/qr')).json.state === 'waiting', 12_000);
    record('扫码状态：刷新得到新码', refreshed.status === 200);
    await runtimeApi('POST', '/sim/qr', { action: 'confirm' });
    await waitFor('online after qr', async () => (await api('GET', '/api/status')).json.account.online === true, 12_000);

    // ------------------------------------------------------------ 网络配置 + 独立端口
    botServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => botServer.once('listening', resolve));
    const botPort = botServer.address().port;
    botServer.on('connection', (socket) => {
      botSockets.add(socket);
      socket.on('message', (raw) => {
        try {
          botFrames.push(JSON.parse(raw.toString()));
        } catch {
          botFrames.push({ raw: String(raw) });
        }
      });
      socket.on('close', () => botSockets.delete(socket));
    });

    const network = {
      'http-server': [{ name: 'acceptance-http', enabled: true, host: '127.0.0.1', port: 0, token: '', cors: false, enableWs: true }],
      'ws-server': [{ name: 'acceptance-ws', enabled: true, host: '127.0.0.1', port: 0, token: '' }],
      'ws-client': [{ name: 'acceptance-bot', enabled: true, url: 'ws://127.0.0.1:' + botPort + '/ws', token: '', heartbeat: 30000, reconnect: 1000 }],
      'http-client': [],
      sse: [],
    };
    const saved = await api('PUT', '/api/config', { network });
    record('网络配置保存并热重载', saved.status === 200);

    await waitFor('bot connected', () => botSockets.size > 0 && botFrames.some((f) => f.meta_event_type === 'lifecycle'), 15_000);
    record('反向 WS：握手 + lifecycle.connect', botFrames.some((f) => f.meta_event_type === 'lifecycle'));

    const conns = await waitFor('http/ws servers listening', async () => {
      const current = await api('GET', '/api/status');
      const httpConn = current.json.onebot.connections.find((c) => c.kind === 'http-server' && c.status === 'listening');
      const wsConn = current.json.onebot.connections.find((c) => c.kind === 'ws-server' && c.status === 'listening');
      return httpConn && wsConn ? { http: httpConn.address, ws: wsConn.address, count: current.json.onebot.connections.length } : null;
    }, 15_000);
    record('独立 OneBot HTTP / 正向 WS 端口就绪', Boolean(conns.http && conns.ws), conns.http + ' | ' + conns.ws);

    // forward WS: framework's ws-server, a second bot connects in
    const forwardFrames = [];
    const forwardSocket = new WebSocket(conns.ws.replace(/^http/, 'ws'));
    forwardSocket.on('message', (raw) => {
      try {
        forwardFrames.push(JSON.parse(raw.toString()));
      } catch {
        /* ignore */
      }
    });
    await new Promise((resolve, reject) => {
      forwardSocket.once('open', resolve);
      forwardSocket.once('error', reject);
    });
    await waitFor('forward lifecycle', () => forwardFrames.some((f) => f.meta_event_type === 'lifecycle'), 10_000);
    record('正向 WS：Bot 连入并收到 lifecycle', true);

    // ------------------------------------------------------------ 私聊/群/图片 入站
    const emit = (payload) => runtimeApi('POST', '/sim/emit', payload);
    const waitBot = (predicate, label) => waitFor(label, () => botFrames.some(predicate), 12_000);

    await emit({ scene: 'private', peerId: '20001', userId: '20001', nick: '好友甲', text: '验收私聊' });
    await waitBot((f) => f.post_type === 'message' && f.message_type === 'private' && f.message?.[0]?.data?.text === '验收私聊', '私聊入站');
    record('私聊文本：模拟内核 → 反向 WS Bot', true);

    await emit({ scene: 'group', peerId: '30001', userId: '20001', nick: '好友甲', text: '验收群聊' });
    await waitBot((f) => f.post_type === 'message' && f.message_type === 'group' && f.group_id === 30001, '群聊入站');
    record('群聊文本：模拟内核 → 反向 WS Bot', true);

    const imageUrl = 'https://example.test/acceptance.png';
    await emit({ scene: 'private', peerId: '20002', userId: '20002', text: '看图', imageUrl });
    const imageEvent = await waitFor('图片入站', () => {
      const hit = botFrames.find((f) => f.post_type === 'message' && f.message_type === 'private' && Array.isArray(f.message) && f.message.some((s) => s.type === 'image'));
      return hit ?? null;
    }, 12_000);
    const imageSegment = imageEvent.message.find((s) => s.type === 'image');
    record('图片入站：url 段未被丢弃或降级', imageSegment?.data?.url === imageUrl, JSON.stringify(imageSegment));

    const voiceUrl = 'https://example.test/acceptance.amr';
    await emit({ scene: 'private', peerId: '20002', userId: '20002', voice: voiceUrl });
    const voiceEvent = await waitFor('语音入站', () => {
      const hit = botFrames.find((f) => f.post_type === 'message' && Array.isArray(f.message) && f.message.some((s) => s.type === 'record'));
      return hit ?? null;
    }, 12_000);
    const voiceSegment = voiceEvent.message.find((s) => s.type === 'record');
    record(
      '语音入站：record 段带 file/path/url/file_size',
      voiceSegment?.data?.url === voiceUrl &&
        /^voice-\d+\.amr$/.test(String(voiceSegment?.data?.file ?? '')) &&
        /voice\.amr$/.test(String(voiceSegment?.data?.path ?? '')) &&
        Number(voiceSegment?.data?.file_size) > 0,
      JSON.stringify(voiceSegment),
    );

    // ------------------------------------------------------------ request 事件（P0-1 回归）
    const friendRequest = await runtimeApi('POST', '/sim/request', {
      kind: 'friend',
      userId: '20009',
      comment: '离线验收好友申请',
    });
    const friendRequestFrame = await waitFor('好友申请入站', () => {
      const hit = botFrames.find((f) => f.post_type === 'request' && f.request_type === 'friend');
      return hit ?? null;
    }, 12_000);
    record(
      '请求事件：好友申请经模拟内核 → OneBot 事件',
      friendRequestFrame.user_id === 20009 && friendRequestFrame.flag === friendRequest.flag,
      JSON.stringify({ request_type: friendRequestFrame.request_type, user_id: friendRequestFrame.user_id }),
    );

    const groupRequest = await runtimeApi('POST', '/sim/request', {
      kind: 'group',
      groupId: '30001',
      userId: '20010',
      comment: '离线验收加群申请',
      subType: 'add',
    });
    const groupRequestFrame = await waitFor('加群申请入站', () => {
      const hit = botFrames.find((f) => f.post_type === 'request' && f.request_type === 'group');
      return hit ?? null;
    }, 12_000);
    record(
      '请求事件：加群申请带 group_id 与 sub_type',
      groupRequestFrame.group_id === 30001 && groupRequestFrame.sub_type === 'add' && groupRequestFrame.flag === groupRequest.flag,
      JSON.stringify({ group_id: groupRequestFrame.group_id, sub_type: groupRequestFrame.sub_type }),
    );

    // 字母数字 uid：真实好友申请只有 uid，不能静默变成 user_id=0 的"0 号用户"
    const uidOnlyRequest = await runtimeApi('POST', '/sim/request', {
      kind: 'friend',
      userId: 'u_accept0001',
      comment: '只有 uid 的申请',
    });
    const uidOnlyFrame = await waitFor('uid-only 好友申请入站', () => {
      const hit = botFrames.find((f) => f.post_type === 'request' && f.flag === uidOnlyRequest.flag);
      return hit ?? null;
    }, 12_000);
    record(
      '请求事件：字母数字 uid 保留在 uid 字段，user_id 明确为 0',
      uidOnlyFrame.user_id === 0 && uidOnlyFrame.uid === 'u_accept0001',
      JSON.stringify({ user_id: uidOnlyFrame.user_id, uid: uidOnlyFrame.uid }),
    );

    // ------------------------------------------------------------ 独立 OneBot HTTP 动作
    const h = { 'content-type': 'application/json' };
    const httpVersion = await fetch(conns.http + '/get_version_info', { headers: h });
    record('OneBot HTTP：get_version_info', httpVersion.status === 200 && (await httpVersion.json()).status === 'ok');
    const httpSend = await fetch(conns.http + '/send_group_msg', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ group_id: 30001, message: [{ type: 'text', data: { text: '经 HTTP 发到群里' } }] }),
    });
    record('OneBot HTTP：send_group_msg', httpSend.status === 200 && (await httpSend.json()).status === 'ok');
    const httpImage = await fetch(conns.http + '/send_private_msg', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ user_id: 20001, message: [{ type: 'image', data: { file: 'data:image/png;base64,iVBORw0KGgo=' } }] }),
    });
    record('OneBot HTTP：send_private_msg 图片', httpImage.status === 200 && (await httpImage.json()).status === 'ok');

    const canRecord = await fetch(conns.http + '/can_send_record', { headers: h });
    record('OneBot HTTP：can_send_record 与运行时段能力一致', (await canRecord.json()).data.yes === true);
    const voicePayload = 'base64://' + Buffer.concat([Buffer.from('#!AMR\n', 'latin1'), Buffer.alloc(16)]).toString('base64');
    const httpVoice = await fetch(conns.http + '/send_private_msg', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ user_id: 20001, message: [{ type: 'record', data: { file: voicePayload } }] }),
    });
    const httpVoiceJson = await httpVoice.json();
    record('OneBot HTTP：send_private_msg 语音', httpVoice.status === 200 && httpVoiceJson.status === 'ok', JSON.stringify(httpVoiceJson).slice(0, 120));
    const gotRecord = await fetch(conns.http + '/get_record', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ message_id: httpVoiceJson.data?.message_id ?? 0 }),
    });
    const gotRecordJson = await gotRecord.json();
    const gotRecordBytes = String(gotRecordJson.data?.file ?? '').startsWith('base64://')
      ? Buffer.from(String(gotRecordJson.data.file).slice('base64://'.length), 'base64')
      : Buffer.alloc(0);
    record(
      'OneBot HTTP：get_record 取回语音字节',
      gotRecordJson.status === 'ok' &&
        gotRecordBytes.toString('latin1', 0, 6) === '#!AMR\n' &&
        /^voice[^\\/]*\.amr$/.test(String(gotRecordJson.data?.file_name ?? '')),
      'name=' + String(gotRecordJson.data?.file_name ?? '') + ' bytes=' + gotRecordBytes.length,
    );

    // 处理动作必须真的回到运行时（/sim/state 的 requests 计数增加），而不只是返回 status=ok。
    const beforeRequests = (await runtimeApi('GET', '/sim/state')).requests;
    const approveRequest = await fetch(conns.http + '/set_friend_add_request', {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ flag: friendRequest.flag, approve: true }),
    });
    const approveJson = await approveRequest.json();
    const afterRequests = (await runtimeApi('GET', '/sim/state')).requests;
    record(
      'OneBot HTTP：set_friend_add_request 回到运行时',
      approveJson.status === 'ok' && afterRequests === beforeRequests + 1,
      'requests ' + beforeRequests + ' -> ' + afterRequests,
    );

    // ------------------------------------------------------------ WS 动作 + 控制台调试
    const wsAction = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS 动作超时')), 8000);
      const onMessage = (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.echo === 'acceptance-e1') {
          clearTimeout(timer);
          forwardSocket.off('message', onMessage);
          resolve(frame);
        }
      };
      forwardSocket.on('message', onMessage);
      forwardSocket.send(JSON.stringify({ action: 'get_friend_list', params: {}, echo: 'acceptance-e1' }));
    });
    record('OneBot 正向 WS：动作回包', wsAction.status === 'ok' && wsAction.data.length === 3);

    const debugInfo = await api('POST', '/api/action/get_login_info', {});
    record('控制台调试流程：动作调用', debugInfo.json.status === 'ok' && debugInfo.json.data.user_id === 10001);
    const debugSend = await api('POST', '/api/action/send_private_msg', { user_id: 20001, message: '调试页发送' });
    record('控制台调试流程：发送私聊', debugSend.json.status === 'ok');

    // ------------------------------------------------------------ 积压 150 条
    await runtimeApi('POST', '/sim/backlog', { count: 150 });
    const backlogCount = await waitFor('backlog delivered', async () => {
      const list = await api('GET', '/api/events?limit=300');
      const count = list.json.items.filter((item) => String(item.summary).includes('积压消息')).length;
      return count >= 150 ? count : null;
    }, 25_000);
    record('积压事件 >100 条无丢失', backlogCount >= 150, 'received=' + backlogCount);

    // ------------------------------------------------------------ 错误响应与恢复
    await runtimeApi('POST', '/sim/fault', { status: 500, ms: 4000 });
    await waitFor('account error on fault', async () => (await api('GET', '/api/status')).json.account.state === 'error', 12_000);
    record('运行时错误：控制台可见错误状态', true);
    await waitFor('account recovered', async () => (await api('GET', '/api/status')).json.account.online === true, 15_000);
    record('运行时恢复：自动重新在线', true);

    // ------------------------------------------------------------ 断线重连
    runtime.child.kill();
    await waitFor('offline after runtime kill', async () => (await api('GET', '/api/status')).json.account.online === false, 15_000);
    runtime = await startRuntime(runtime.port);
    await waitFor('reconnected to runtime', async () => (await api('GET', '/api/status')).json.account.online === true, 20_000);
    botFrames.length = 0;
    await emit({ scene: 'private', peerId: '20001', userId: '20001', text: '重连后的消息' });
    await waitFor('event after reconnect', () => botFrames.some((f) => f.message?.[0]?.data?.text === '重连后的消息'), 12_000);
    record('断线重连：重启运行时后事件继续送达', true);
  } catch (error) {
    record('验收中断', false, error instanceof Error ? error.message : String(error));
  } finally {
    try {
      if (botServer) for (const socket of botSockets) socket.terminate();
      if (botServer) await new Promise((resolve) => botServer.close(resolve));
    } catch {
      /* ignore */
    }
    runtime.child.kill();
    framework.child.kill();
    await delay(300);
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {
      /* windows keeps handles briefly */
    }
  }

  const failed = results.filter((item) => !item.ok);
  console.log('\n===== 离线验收结果 =====');
  for (const item of results) console.log((item.ok ? 'PASS' : 'FAIL') + '  ' + item.name + (item.detail ? '  [' + item.detail + ']' : ''));
  console.log('通过 ' + (results.length - failed.length) + ' / ' + results.length);
  if (failed.length > 0) process.exit(1);
}

void main();
