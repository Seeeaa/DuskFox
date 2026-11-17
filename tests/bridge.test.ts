import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { startInstance, waitFor } from './helpers.ts';

interface BridgeCall {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

test('原生桥接驱动：状态、二维码、收发与事件轮询', async () => {
  const calls: BridgeCall[] = [];
  const queued: Array<Record<string, unknown>> = [];
  let cursor = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      calls.push({ method: request.method ?? '', url: request.url ?? '', body });
      response.setHeader('content-type', 'application/json');
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/status') {
        response.end(JSON.stringify({ message_ready: true, self_id: 10001, nickname: '桥接账号', pid: 4242, cpu: 1, memory_mb: 128, version: 'qq-bridge-test' }));
        return;
      }
      if (url.pathname === '/api/events') {
        if (queued.length === 0) {
          cursor += 1;
          queued.push({
            post_type: 'message',
            message_type: 'private',
            sub_type: 'friend',
            self_id: 10001,
            user_id: 30001,
            message_id: 'bridge-1',
            time: Math.floor(Date.now() / 1000),
            message: [{ type: 'text', data: { text: '来自桥接的问候' } }],
          });
        }
        response.end(JSON.stringify({ cursor, events: queued.splice(0).map((data) => ({ cursor, data })) }));
        return;
      }
      if (url.pathname === '/api/send-private') {
        response.end(JSON.stringify({ message_id: 'bridge-out-1' }));
        return;
      }
      if (url.pathname === '/api/qr/refresh' || url.pathname === '/api/qr') {
        response.end(JSON.stringify({ picture: Buffer.from('fake-png').toString('base64'), expires_at: Math.floor(Date.now() / 1000) + 120, seq: 7 }));
        return;
      }
      response.writeHead(404);
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const instance = await startInstance({
    driver: 'bridge',
    driverOptions: { endpoint: 'http://127.0.0.1:' + port },
  });
  try {
    await waitFor(async () => {
      const status = await instance.call('GET', '/api/status');
      return status.json.account.online === true;
    }, 8000);
    const status = await instance.call('GET', '/api/status');
    assert.equal(status.json.account.uin, '10001');
    assert.equal(status.json.account.nick, '桥接账号');
    assert.equal(status.json.account.loginType, 'session');
    assert.equal(status.json.capabilities.find((row: { key: string }) => row.key === 'group').state, 'no');

    const qr = await instance.call('POST', '/api/qr/refresh');
    assert.equal(qr.json.state, 'waiting');
    assert.match(qr.json.image, /^data:image\/png;base64,/);

    const send = await instance.call('POST', '/api/action/send_private_msg', { user_id: 30001, message: '桥接发送' });
    assert.equal(send.json.status, 'ok');
    const posted = calls.find((call) => call.url === '/api/send-private');
    assert.equal(JSON.parse(posted?.body ?? '{}').user_id, 30001);
    assert.match(posted?.body ?? '', /桥接发送/);

    const group = await instance.call('POST', '/api/action/send_group_msg', { group_id: 1, message: 'x' });
    assert.equal(group.json.retcode, 1200);

    await waitFor(async () => {
      const events = await instance.call('GET', '/api/events');
      return events.json.items.some((item: { type: string }) => item.type === 'message.private');
    }, 5000);
    const events = await instance.call('GET', '/api/events');
    const inbound = events.json.items.find((item: { type: string }) => item.type === 'message.private');
    assert.match(String(inbound.summary), /来自桥接的问候/);
  } finally {
    await instance.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('原生桥接驱动兼容异步二维码契约', async () => {
  let qrReady = false;
  let loginMode: 'active' | 'passive' = 'active';
  const image = `data:image/png;base64,${Buffer.from('fixture').toString('base64')}`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    response.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/status') {
      response.end(JSON.stringify({ message_ready: false, self_id: null, qr_ready: qrReady, login_mode: loginMode }));
    } else if (url.pathname === '/api/qr/refresh') {
      response.statusCode = 202;
      response.end(JSON.stringify({ accepted: true }));
      setTimeout(() => { qrReady = true; }, 100);
    } else if (url.pathname === '/api/qr') {
      response.statusCode = qrReady ? 200 : 404;
      response.end(JSON.stringify(qrReady ? { image } : { error: 'QR not available' }));
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: `http://127.0.0.1:${port}` } });
  try {
    const requested = await instance.call('POST', '/api/qr/refresh');
    assert.equal(requested.status, 200);
    // The refresh may return the async picture directly or after polling.
    assert.ok(requested.json.image === undefined || requested.json.image === image);
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.image === image, 5000);
    const qr = await instance.call('GET', '/api/qr');
    assert.equal(qr.json.state, 'waiting');
    assert.equal(qr.json.image, image);
    assert.notEqual(qr.json.refreshable, false);

    // Passive runtimes can mirror a code but cannot request one: the console
    // must show that as "partial", never as a fully working refresh.
    loginMode = 'passive';
    await waitFor(async () => {
      const status = await instance.call('GET', '/api/status');
      return status.json.capabilities.some(
          (row: { key: string; state: string; detail: string }) =>
            row.key === 'qr' && row.state === 'partial' && row.detail.includes('被动'),
        );
    }, 5000);
  } finally {
    await instance.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Contract v2 runtime: reports features, accepts any segment list, exposes
 * contact APIs and pushes notices/requests through the same event stream.
 */
test('桥接 v2：能力报告、群消息、资料查询、撤回、请求处理与通知事件', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const queued: Array<Record<string, unknown>> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      calls.push({ url: url.pathname + url.search, body: body ? JSON.parse(body) : null });
      response.setHeader('content-type', 'application/json');
      const features = {
        privateMessage: true,
        groupMessage: true,
        mediaImage: true,
        mediaFile: true,
        recall: true,
        friendList: true,
        groupList: true,
        strangerInfo: true,
        groupMemberInfo: true,
        groupMemberList: true,
        requestHandle: true,
      };
      if (url.pathname === '/api/status') {
        response.end(JSON.stringify({ message_ready: true, self_id: 10001, nickname: 'v2', login_mode: 'active', phase: 'online', features }));
        return;
      }
      if (url.pathname === '/api/events') {
        if (queued.length === 0) {
          queued.push({
            post_type: 'notice', notice_type: 'group_recall', self_id: 10001, group_id: 30001,
            user_id: 20001, operator_id: 20001, message_id: 42, time: Math.floor(Date.now() / 1000),
          });
          queued.push({
            post_type: 'request', request_type: 'friend', self_id: 10001, user_id: 20009,
            comment: '我是测试号', flag: 'flag-9', time: Math.floor(Date.now() / 1000),
          });
        }
        response.end(JSON.stringify({ cursor: Date.now(), events: queued.splice(0).map((data) => ({ data })) }));
        return;
      }
      if (url.pathname === '/api/send') { response.end(JSON.stringify({ message_id: 'v2-out-1' })); return; }
      if (url.pathname === '/api/recall') { response.end(JSON.stringify({ ok: true })); return; }
      if (url.pathname === '/api/friends') { response.end(JSON.stringify({ items: [{ user_id: 20001, nickname: '好友甲', remark: '甲' }] })); return; }
      if (url.pathname === '/api/groups') { response.end(JSON.stringify({ items: [{ group_id: 30001, group_name: '测试群', member_count: 3, max_member_count: 200 }] })); return; }
      if (url.pathname === '/api/stranger') { response.end(JSON.stringify({ user_id: 20002, nickname: '陌生人', sex: 'male', age: 20 })); return; }
      if (url.pathname === '/api/group-member') { response.end(JSON.stringify({ group_id: 30001, user_id: 20001, nickname: '好友甲', card: '甲', role: 'admin' })); return; }
      if (url.pathname === '/api/group-members') {
        response.end(JSON.stringify({ items: [
          { group_id: 30001, user_id: 20001, nickname: '好友甲', role: 'admin' },
          { group_id: 30001, user_id: 20002, nickname: '好友乙', role: 'member' },
        ] }));
        return;
      }
      if (url.pathname === '/api/request') { response.end(JSON.stringify({ ok: true })); return; }
      response.writeHead(404);
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: 'http://127.0.0.1:' + port } });
  try {
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true, 8000);
    const status = await instance.call('GET', '/api/status');
    const caps = Object.fromEntries(status.json.capabilities.map((row: { key: string; state: string }) => [row.key, row.state]));
    assert.equal(caps.group, 'yes');

    const groupSend = await instance.call('POST', '/api/action/send_group_msg', {
      group_id: 30001,
      message: [{ type: 'text', data: { text: '群里的消息' } }],
    });
    assert.equal(groupSend.json.status, 'ok');
    const sendCall = calls.find((call) => call.url === '/api/send');
    assert.equal(sendCall?.body.scene, 'group');
    assert.equal(sendCall?.body.peer_id, '30001');

    const friends = await instance.call('POST', '/api/action/get_friend_list', {});
    assert.deepEqual(friends.json.data, [{ user_id: 20001, nickname: '好友甲', remark: '甲' }]);
    const groups = await instance.call('POST', '/api/action/get_group_list', {});
    assert.equal(groups.json.data[0].group_name, '测试群');
    const stranger = await instance.call('POST', '/api/action/get_stranger_info', { user_id: 20002 });
    assert.equal(stranger.json.data.sex, 'male');
    const member = await instance.call('POST', '/api/action/get_group_member_info', { group_id: 30001, user_id: 20001 });
    assert.equal(member.json.data.role, 'admin');
    const memberList = await instance.call('POST', '/api/action/get_group_member_list', { group_id: 30001 });
    assert.equal(memberList.json.data.length, 2);

    const approve = await instance.call('POST', '/api/action/set_group_add_request', { flag: 'f1', approve: false, sub_type: 'invite' });
    assert.equal(approve.json.status, 'ok');
    const requestCall = calls.find((call) => call.url === '/api/request');
    assert.equal(requestCall?.body.approve, false);
    assert.equal(requestCall?.body.sub_type, 'invite');

    const recall = await instance.call('POST', '/api/action/delete_msg', { message_id: groupSend.json.data.message_id });
    assert.equal(recall.json.status, 'ok');
    assert.equal(calls.some((call) => call.url === '/api/recall'), true);

    await waitFor(async () => {
      const events = await instance.call('GET', '/api/events');
      const types = events.json.items.map((item: { type: string }) => item.type);
      return types.includes('notice.group_recall') && types.includes('request.friend');
    }, 6000);

    const stored = await instance.call('POST', '/api/action/get_msg', { message_id: groupSend.json.data.message_id });
    assert.equal(stored.json.status, 'ok');
    assert.equal(stored.json.data.message_type, 'group');
    assert.equal(stored.json.data.raw_message, '群里的消息');
  } finally {
    await instance.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Passive runtime: codes only appear when the QQ window asks for one. */
test('桥接二维码：被动模式提示不可主动刷新，切主动后等待异步图片', async () => {
  let mode: 'passive' | 'active' = 'passive';
  let pictureReady = false;
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/api/status') {
      response.end(JSON.stringify({
        message_ready: false, self_id: 0, login_mode: mode,
        phase: pictureReady ? 'scan_qr' : (mode === 'passive' ? 'waiting_official_qq_login' : 'waiting_login'),
        qr_ready: pictureReady,
      }));
      return;
    }
    if (url.pathname === '/api/qr') {
      if (!pictureReady) { response.writeHead(404); response.end('{"error":"QR not available"}'); return; }
      response.end(JSON.stringify({ picture: Buffer.from('png-' + Date.now()).toString('base64'), seq: 3 }));
      return;
    }
    if (url.pathname === '/api/qr/refresh') {
      if (mode === 'passive') { response.writeHead(409); response.end('{"error":"passive"}'); return; }
      response.writeHead(202);
      response.end(JSON.stringify({ accepted: true }));
      setTimeout(() => { pictureReady = true; }, 400);
      return;
    }
    if (url.pathname === '/api/events') { response.end(JSON.stringify({ cursor: 0, events: [] })); return; }
    response.writeHead(404);
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: 'http://127.0.0.1:' + port } });
  try {
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.state === 'unavailable', 8000);
    const passive = await instance.call('GET', '/api/qr');
    assert.equal(passive.json.loginMode, 'passive');
    assert.match(String(passive.json.hint), /被动模式/);

    const blocked = await instance.call('POST', '/api/qr/refresh');
    assert.equal(blocked.status, 200);
    assert.equal(blocked.json.refreshable, false);
    assert.match(String(blocked.json.hint), /被动模式/);

    pictureReady = true;
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.image !== undefined, 6000);
    const shown = await instance.call('GET', '/api/qr');
    assert.equal(shown.json.state, 'waiting');
    assert.match(shown.json.image, /^data:image\/png;base64,/);
    assert.equal(shown.json.refreshable, false);

    mode = 'active';
    pictureReady = false;
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.refreshable === true, 6000);
    const refreshed = await instance.call('POST', '/api/qr/refresh');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.state, 'waiting');
    assert.match(refreshed.json.image, /^data:image\/png;base64,/);
  } finally {
    await instance.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
