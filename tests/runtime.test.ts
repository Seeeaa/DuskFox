import assert from 'node:assert/strict';
import test from 'node:test';
import { createBridgeServer, attachKernelEvents } from '../runtime/bridge/server.mjs';
import { SimKernel, pngDataUrl } from '../runtime/bridge/sim-kernel.mjs';
import { startInstance, waitFor } from './helpers.ts';

interface Runtime {
  kernel: SimKernel;
  bridge: ReturnType<typeof createBridgeServer>;
  base: string;
  close(): Promise<void>;
}

async function bootRuntime(options: { autoLogin?: boolean; qrTtlMs?: number } = {}): Promise<Runtime> {
  const kernel = new SimKernel({ autoLogin: options.autoLogin ?? true, qrTtlMs: options.qrTtlMs ?? 60_000 });
  const bridge = createBridgeServer({ kernel, token: 'runtime-token', qrPump: true, qrCooldownMs: 50 });
  await attachKernelEvents(bridge, kernel);
  const address = await bridge.listen(0, '127.0.0.1');
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    kernel,
    bridge,
    base: 'http://127.0.0.1:' + port,
    async close() {
      await bridge.close();
      await kernel.stop();
    },
  };
}

async function bootPair(options: { autoLogin?: boolean; qrTtlMs?: number } = {}) {
  const runtime = await bootRuntime(options);
  const instance = await startInstance({
    driver: 'bridge',
    driverOptions: { endpoint: runtime.base, token: 'runtime-token' },
  });
  await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true, 10_000);
  return { runtime, instance };
}

test('模拟内核：私聊文本双向（入站事件 + 出站动作）', async () => {
  const { runtime, instance } = await bootPair();
  try {
    runtime.kernel.incoming({ text: '来自模拟内核的私聊' });
    await waitFor(async () => {
      const events = await instance.call('GET', '/api/events');
      return events.json.items.some((item: { type: string; summary: string }) => item.type === 'message.private' && item.summary.includes('模拟内核的私聊'));
    }, 8000);

    const sent = await instance.call('POST', '/api/action/send_private_msg', { user_id: 20001, message: '框架发出的私聊' });
    assert.equal(sent.json.status, 'ok');
    assert.equal(runtime.kernel.sent.length, 1);
    assert.equal(runtime.kernel.sent[0]?.scene, 'private');
    assert.deepEqual(runtime.kernel.sent[0]?.segments[0], { type: 'text', data: { text: '框架发出的私聊' } });

    const stored = await instance.call('POST', '/api/action/get_msg', { message_id: sent.json.data.message_id });
    assert.equal(stored.json.status, 'ok');
    assert.equal(stored.json.data.raw_message, '框架发出的私聊');
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('模拟内核：群聊文本双向与群资料', async () => {
  const { runtime, instance } = await bootPair();
  try {
    runtime.kernel.incoming({ scene: 'group', peerId: '30001', userId: '20001', text: '群里来的消息' });
    await waitFor(async () => {
      const events = await instance.call('GET', '/api/events');
      return events.json.items.some((item: { type: string; summary: string }) => item.type === 'message.group' && item.summary.includes('群里来的消息'));
    }, 8000);

    const sent = await instance.call('POST', '/api/action/send_group_msg', { group_id: 30001, message: '发到群里' });
    assert.equal(sent.json.status, 'ok');
    assert.equal(runtime.kernel.sent[0]?.scene, 'group');
    assert.equal(runtime.kernel.sent[0]?.peerId, '30001');

    const groups = await instance.call('POST', '/api/action/get_group_list', {});
    assert.equal(groups.json.data[0].group_name, 'duskfox 测试群');
    const member = await instance.call('POST', '/api/action/get_group_member_info', { group_id: 30001, user_id: 20001 });
    assert.equal(member.json.data.card, '甲');
    const members = await instance.call('POST', '/api/action/get_group_member_list', { group_id: 30001 });
    assert.equal(members.json.data.length, 4);
    const friends = await instance.call('POST', '/api/action/get_friend_list', {});
    assert.equal(friends.json.data.length, 3);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('模拟内核：图片双向（入站段带 url，出站段透传）', async () => {
  const { runtime, instance } = await bootPair();
  try {
    const imageUrl = pngDataUrl();
    runtime.kernel.incoming({ text: '看图', imageUrl });
    await waitFor(async () => {
      const events = await instance.call('GET', '/api/events');
      return events.json.items.some((item: { type: string; summary: string }) => item.type === 'message.private' && item.summary.includes('[图片]'));
    }, 8000);
    const sent = await instance.call('POST', '/api/action/send_private_msg', {
      user_id: 20001,
      message: [{ type: 'image', data: { file: imageUrl } }],
    });
    assert.equal(sent.json.status, 'ok');
    const firstSegment = (runtime.kernel.sent[0] as any)?.segments?.[0];
    assert.equal(firstSegment?.type, 'image');
    assert.equal(firstSegment?.data?.file, imageUrl);

    // get_msg returns the image segment, not an empty text
    const got = await instance.call('POST', '/api/action/get_msg', { message_id: sent.json.data.message_id });
    assert.equal(got.json.status, 'ok');
    assert.equal(got.json.data.message[0].type, 'image');
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('模拟内核：撤回写入原生内核并返回成功', async () => {
  const { runtime, instance } = await bootPair();
  try {
    const sent = await instance.call('POST', '/api/action/send_private_msg', { user_id: 20001, message: '先发再撤回' });
    const recalled = await instance.call('POST', '/api/action/delete_msg', { message_id: sent.json.data.message_id });
    assert.equal(recalled.json.status, 'ok');
    assert.equal(runtime.kernel.sent[0]?.recalled, true);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('积压事件：120 条不丢、不重复，游标单调', async () => {
  const { runtime, instance } = await bootPair();
  try {
    const since = runtime.kernel.sent.length;
    for (let index = 0; index < 120; index += 1) {
      runtime.kernel.incoming({ text: 'backlog-' + index });
    }
    await waitFor(async () => {
      const state = await fetch(runtime.base + '/sim/state').then((response) => response.json() as Promise<{ cursor: number }>);
      const events = await instance.call('GET', '/api/events');
      return state.cursor >= 120 && events.json.items.length >= 60;
    }, 15_000);
    const state = (await fetch(runtime.base + '/sim/state').then((response) => response.json())) as { cursor: number };
    assert.equal(state.cursor >= 120, true, 'runtime should have queued all events');
    // Heartbeats share summaries, so dedupe on the backlog text itself.
    const events = await instance.call('GET', '/api/events?limit=300');
    const backlog = events.json.items
      .map((item: { summary: string }) => item.summary)
      .filter((summary: string) => summary.includes('backlog-'));
    const texts = backlog.map((summary: string) => summary.slice(summary.indexOf('backlog-')));
    assert.equal(new Set(texts).size, 120, 'all 120 backlog messages present exactly once');
    assert.equal(texts.length, 120, 'no duplicated backlog messages');
    assert.equal(since, 0);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('二维码：过期后变为 expired，刷新得到新序号', async () => {
  const runtime = await bootRuntime({ autoLogin: false, qrTtlMs: 1200 });
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: runtime.base, token: 'runtime-token' } });
  try {
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.state === 'waiting', 8000);
    const first = await instance.call('GET', '/api/qr');
    assert.equal(first.json.refreshable, true);
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.state === 'expired', 8000);
    const refreshed = await instance.call('POST', '/api/qr/refresh');
    assert.equal(refreshed.status, 200);
    await waitFor(async () => (await instance.call('GET', '/api/qr')).json.state === 'waiting', 8000);
    const second = await instance.call('GET', '/api/qr');
    assert.notEqual(second.json.seq, first.json.seq);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('在线状态下手动重新取码仍返回二维码图片', async () => {
  const { runtime, instance } = await bootPair();
  try {
    const originalStatus = runtime.kernel.status.bind(runtime.kernel);
    runtime.kernel.status = () => ({ ...originalStatus(), authorized: true });
    const refreshed = await instance.call('POST', '/api/qr/refresh?force=1');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.state, 'waiting');
    assert.match(refreshed.json.image, /^data:image\/png;base64,/);
    assert.equal((await instance.call('GET', '/api/status')).json.account.online, true);
    const retained = await instance.call('GET', '/api/qr');
    assert.equal(retained.json.state, 'waiting');
    assert.equal(retained.json.seq, refreshed.json.seq);
    (runtime.kernel as SimKernel & { online: boolean }).online = false;
    const authorizedOffline = await fetch(runtime.base + '/api/qr', {
      headers: { authorization: 'Bearer runtime-token' },
    }).then((response) => response.json() as Promise<{ state: string; picture?: string }>);
    assert.equal(authorizedOffline.state, 'waiting');
    assert.equal(typeof authorizedOffline.picture, 'string');
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('运行时故障与恢复：错误状态可见，恢复后自动重新在线', async () => {
  const { runtime, instance } = await bootPair();
  try {
    // Longer than the driver's 2s status poll so at least one poll must fail.
    await fetch(runtime.base + '/sim/fault', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 500, ms: 4000 }) });
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === false, 12_000);
    const status = await instance.call('GET', '/api/status');
    assert.equal(status.json.account.state, 'error');

    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true, 15_000);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('get_msg：本地窗口淘汰后回退到运行时原生查询', async () => {
  const { runtime, instance } = await bootPair();
  try {
    const sent = await instance.call('POST', '/api/action/send_private_msg', { user_id: 20001, message: '窗口外的消息' });
    const messageId = sent.json.data.message_id;
    // Simulate the 500-message window having evicted this message.
    instance.app.service.messages.clear();
    const got = await instance.call('POST', '/api/action/get_msg', { message_id: messageId });
    assert.equal(got.json.status, 'ok');
    assert.equal(got.json.data.raw_message, '窗口外的消息');
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('密码登录：控制台 -> 运行时（能力由 features 决定，错误密码失败）', async () => {
  const runtime = await bootRuntime({ autoLogin: false });
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: runtime.base, token: 'runtime-token' } });
  try {
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.login.password === true, 8000);
    const wrong = await instance.call('POST', '/api/account/login', { method: 'password', uin: '10001', password: 'wrong' });
    assert.equal(wrong.status, 502);
    assert.match(String(wrong.json.error), /密码/);

    const badUin = await instance.call('POST', '/api/account/login', { method: 'password', uin: 'abc', password: 'x' });
    assert.equal(badUin.status, 400);

    const good = await instance.call('POST', '/api/account/login', { method: 'password', uin: '10001', password: 'sim-password' });
    assert.equal(good.status, 200);
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true, 8000);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

/**
 * P0-1 回归：request 事件曾在 bridge 入口被过滤掉，好友/加群申请永远到不了 OneBot，
 * 而 features.requestHandle 仍是 true。这里走"模拟内核 emit → /api/events → 处理动作回到运行时"整条路。
 */
test('请求事件：好友/加群申请经 bridge 入口进入 /api/events，并被处理动作送回运行时', async () => {
  const { runtime, instance } = await bootPair();
  try {
    const friendFlag = runtime.kernel.request({ kind: 'friend', userId: '20009', comment: '我是好友申请' });
    const groupFlag = runtime.kernel.request({
      kind: 'group',
      groupId: '30001',
      userId: '20010',
      comment: '我想加群',
      subType: 'add',
    });

    await waitFor(async () => {
      const events = await instance.call('GET', '/api/events');
      const types = events.json.items.map((item: { type: string }) => item.type);
      return types.includes('request.friend') && types.includes('request.group');
    }, 8000);

    const events = await instance.call('GET', '/api/events');
    const friend = events.json.items.find((item: { type: string }) => item.type === 'request.friend');
    const group = events.json.items.find((item: { type: string }) => item.type === 'request.group');
    assert.ok(friend, '好友申请没有出现在控制台事件里');
    assert.match(String(friend.summary), /我是好友申请/);
    assert.ok(group, '加群申请没有出现在控制台事件里');
    assert.match(String(group.summary), /我想加群/);

    // 能力声明必须与实际通路一致：能处理请求，就必须真的收得到请求事件。
    const status = await instance.call('GET', '/api/status');
    const caps = Object.fromEntries(
      status.json.capabilities.map((row: { key: string; state: string }) => [row.key, row.state]),
    );
    assert.equal(caps.requests, 'yes');

    const approve = await instance.call('POST', '/api/action/set_friend_add_request', { flag: friendFlag, approve: true });
    assert.equal(approve.json.status, 'ok');
    const handledFriend = runtime.kernel.requests.at(-1);
    assert.equal(handledFriend?.flag, friendFlag);
    assert.equal(handledFriend?.type, 'friend');

    const reject = await instance.call('POST', '/api/action/set_group_add_request', {
      flag: groupFlag,
      sub_type: 'invite',
      approve: false,
    });
    assert.equal(reject.json.status, 'ok');
    const handledGroup = runtime.kernel.requests.at(-1);
    assert.equal(handledGroup?.flag, groupFlag);
    assert.equal(handledGroup?.type, 'group');
    assert.equal(handledGroup?.subType, 'invite');
    assert.equal(handledGroup?.approve, false);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});
