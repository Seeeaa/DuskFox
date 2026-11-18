import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeKernel } from '../runtime/bridge/native-kernel.cjs';
import { attachKernelEvents, createBridgeServer } from '../runtime/bridge/server.mjs';
import { SimKernel } from '../runtime/bridge/sim-kernel.mjs';
import { buildRequestEvent } from '../src/onebot/events.ts';
import type { AccountRequest } from '../src/core/model.ts';

interface Runtime {
  kernel: SimKernel;
  bridge: ReturnType<typeof createBridgeServer>;
  base: string;
  token: string;
  close(): Promise<void>;
}

async function bootRuntime(): Promise<Runtime> {
  const token = 'request-token';
  const kernel = new SimKernel({ autoLogin: true });
  const bridge = createBridgeServer({ kernel, token, qrPump: false });
  await attachKernelEvents(bridge, kernel);
  const address = await bridge.listen(0, '127.0.0.1');
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    kernel,
    bridge,
    token,
    base: 'http://127.0.0.1:' + port,
    async close() {
      await bridge.close();
      await kernel.stop();
    },
  };
}

async function rawEvents(runtime: Runtime): Promise<Array<Record<string, any>>> {
  const response = await fetch(runtime.base + '/api/events?after=0', {
    headers: { authorization: 'Bearer ' + runtime.token },
  });
  const body = (await response.json()) as { events: Array<{ data: Record<string, any> }> };
  return body.events.map((item) => item.data);
}

async function waitEvents(runtime: Runtime, count: number): Promise<Array<Record<string, any>>> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const list = await rawEvents(runtime);
    if (list.length >= count) return list;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('等待请求事件超时');
}

/** 原生内核 + 捕获 emit 的测试替身（不加载 QQ wrapper，只跑纯映射逻辑）。 */
function nativeProbe(session: Record<string, unknown> = {}): { kernel: NativeKernel; emitted: Array<Record<string, any>> } {
  const emitted: Array<Record<string, any>> = [];
  const kernel = new NativeKernel();
  kernel.emit = (event: unknown) => {
    emitted.push(event as Record<string, any>);
  };
  kernel.session = session;
  return { kernel, emitted };
}

/**
 * QQ 的好友申请只给字母数字 uid（如 u_aBcD1234efGh），没有 QQ 号。
 * Number(uid) || 0 会静默变成 user_id: 0，机器人会以为申请人就是 0 号。
 */
test('请求事件：字母数字 uid 解析不到 QQ 号时给出 user_id=0 和原始 uid，而不是假装 0 号', async () => {
  const runtime = await bootRuntime();
  try {
    runtime.kernel.request({ kind: 'friend', userId: 'u_aBcD1234efGh', comment: '我是好友申请' });
    const [event] = await waitEvents(runtime, 1);
    assert.equal(event?.post_type, 'request');
    assert.equal(event?.request_type, 'friend');
    assert.equal(event?.user_id, 0);
    // 未解析必须显式标注：原始 uid 随事件给出，flag 仍可用作处理凭据。
    assert.equal(event?.uid, 'u_aBcD1234efGh');
    assert.match(String(event?.flag), /^friend\|u_aBcD1234efGh\|/);
  } finally {
    await runtime.close();
  }
});

test('请求事件：uid 能经缓存解析成 QQ 号时给出真实 user_id，且不再带 uid', async () => {
  const runtime = await bootRuntime();
  try {
    runtime.kernel.mapUid('u_aBcD1234efGh', '20009');
    runtime.kernel.request({ kind: 'friend', userId: 'u_aBcD1234efGh', comment: '我是好友申请' });
    const [event] = await waitEvents(runtime, 1);
    assert.equal(event?.user_id, 20009);
    assert.equal(event?.uid, undefined);
  } finally {
    await runtime.close();
  }
});

test('请求事件：数字 QQ 号原样保留，不额外附带 uid', async () => {
  const runtime = await bootRuntime();
  try {
    runtime.kernel.request({ kind: 'friend', userId: '20009', comment: '数字账号申请' });
    const [event] = await waitEvents(runtime, 1);
    assert.equal(event?.user_id, 20009);
    assert.equal(event?.uid, undefined);
  } finally {
    await runtime.close();
  }
});

test('请求事件：群请求带上真实的 group_id，字母数字 uid 同样不静默变 0', async () => {
  const runtime = await bootRuntime();
  try {
    runtime.kernel.request({ kind: 'group', groupId: '30001', userId: 'u_gRpQ0001', comment: '我想加群' });
    const [event] = await waitEvents(runtime, 1);
    assert.equal(event?.request_type, 'group');
    assert.equal(event?.group_id, 30001);
    assert.equal(event?.user_id, 0);
    assert.equal(event?.uid, 'u_gRpQ0001');
  } finally {
    await runtime.close();
  }
});

test('请求事件：群邀请与加群申请分别保留 invite / add 的 sub_type', async () => {
  const runtime = await bootRuntime();
  try {
    runtime.kernel.request({ kind: 'group', groupId: '30001', userId: '20010', comment: '想加群', subType: 'add' });
    runtime.kernel.request({ kind: 'group', groupId: '30002', userId: '20011', comment: '邀请入群', subType: 'invite' });
    const list = await waitEvents(runtime, 2);
    const groupEvents = list.filter((event) => event.request_type === 'group');
    assert.equal(groupEvents.length, 2);
    assert.equal(groupEvents[0]?.sub_type, 'add');
    assert.equal(groupEvents[0]?.group_id, 30001);
    assert.equal(groupEvents[1]?.sub_type, 'invite');
    assert.equal(groupEvents[1]?.group_id, 30002);
  } finally {
    await runtime.close();
  }
});

/* ------------------------------------------------------------------ 原生内核映射 */

test('原生好友申请：按 buddyReqs 信封取字段，换不到 QQ 号时 user.id 为空并保留 uid', async () => {
  const { kernel, emitted } = nativeProbe();
  await kernel.handleBuddyRequests({
    unreadNums: 1,
    buddyReqs: [{ friendUid: 'u_aBcD1234efGh', reqTime: '1795000000', extWords: '加个好友吧' }],
  });
  assert.equal(emitted.length, 1);
  const request = emitted[0]?.request;
  assert.equal(request.kind, 'friend');
  assert.equal(request.user.uid, 'u_aBcD1234efGh');
  assert.equal(request.user.id, '', '换不到 QQ 号时不能填成 0 或 uid');
  assert.equal(request.comment, '加个好友吧');
  assert.equal(request.time, 1795000000);
  assert.equal(request.flag, 'friend|u_aBcD1234efGh|1795000000');
});

test('原生好友申请：UixConvert 能换号时填真实 QQ 号', async () => {
  const { kernel, emitted } = nativeProbe({
    getUixConvertService: () => ({
      getUin: async (list: string[]) => ({ uinInfo: new Map(list.map((uid) => [uid, '20009'])) }),
    }),
  });
  await kernel.handleBuddyRequests({
    buddyReqs: [{ friendUid: 'u_aBcD1234efGh', reqTime: '1795000000', extWords: '' }],
  });
  assert.equal(emitted[0]?.request.user.id, '20009');
  assert.equal(emitted[0]?.request.user.uid, 'u_aBcD1234efGh');
});

test('原生好友申请：自己发起、已处理、已读的请求不上报', async () => {
  const { kernel, emitted } = nativeProbe();
  await kernel.handleBuddyRequests({
    buddyReqs: [
      { friendUid: 'u_self', reqTime: '1', isInitiator: true },
      { friendUid: 'u_decided', reqTime: '2', isDecide: true },
      { friendUid: 'u_read', reqTime: '3', isUnread: false },
    ],
  });
  assert.equal(emitted.length, 0);
});

test('原生群通知：type=7 加群申请用 user1，type=1 群邀请用 user2，sub_type 分别 add / invite', async () => {
  const { kernel, emitted } = nativeProbe();
  await kernel.handleGroupNotifies([
    {
      seq: '111',
      type: 7,
      status: 1,
      group: { groupCode: '30001', groupName: '测试群' },
      user1: { uid: 'u_applicant', nickName: '申请人' },
      user2: { uid: 'u_operator', nickName: '操作人' },
      postscript: '我想加群',
    },
    {
      seq: '222',
      type: 1,
      status: 1,
      group: { groupCode: '30002', groupName: '另一个群' },
      user1: { uid: 'u_me', nickName: '我' },
      user2: { uid: 'u_inviter', nickName: '邀请人' },
      postscript: '',
    },
  ]);
  assert.equal(emitted.length, 2);
  const [add, invite] = emitted.map((item) => item.request);
  assert.equal(add.kind, 'group');
  assert.equal(add.detail.sub_type, 'add');
  assert.equal(add.user.uid, 'u_applicant');
  assert.equal(add.peer.id, '30001');
  assert.equal(add.comment, '我想加群');
  assert.equal(invite.detail.sub_type, 'invite');
  assert.equal(invite.user.uid, 'u_inviter');
  assert.equal(invite.peer.id, '30002');
  assert.equal(invite.flag, 'group|222|1|30002');
});

test('原生群通知：管理员变更与已处理的通知不上报', async () => {
  const { kernel, emitted } = nativeProbe();
  await kernel.handleGroupNotifies([
    { seq: '1', type: 8, status: 1, group: { groupCode: '30001' }, user1: { uid: 'u_a' } },
    { seq: '2', type: 12, status: 1, group: { groupCode: '30001' }, user1: { uid: 'u_b' } },
    { seq: '3', type: 7, status: 2, group: { groupCode: '30001' }, user1: { uid: 'u_c' } },
    { seq: '4', type: 7, status: 3, group: { groupCode: '30001' }, user1: { uid: 'u_d' } },
  ]);
  assert.equal(emitted.length, 0);
});

test('原生请求事件 → bridge：好友申请带 uid 到 OneBot，群邀请按 invite 归一化', async () => {
  const native = nativeProbe();
  await native.kernel.handleBuddyRequests({
    buddyReqs: [{ friendUid: 'u_e2e0001', reqTime: '1795000001', extWords: '端到端申请' }],
  });
  await native.kernel.handleGroupNotifies([
    {
      seq: '333',
      type: 1,
      status: 1,
      group: { groupCode: '30002' },
      user2: { uid: 'u_e2e0002' },
      postscript: '邀请你入群',
    },
  ]);
  assert.equal(native.emitted.length, 2);

  const runtime = await bootRuntime();
  try {
    for (const event of native.emitted) runtime.bridge.ingest(event);
    const list = await waitEvents(runtime, 2);
    const friend = list.find((item) => item.request_type === 'friend');
    const group = list.find((item) => item.request_type === 'group');
    assert.ok(friend, '好友申请没有进入运行时事件环');
    assert.equal(friend?.user_id, 0);
    assert.equal(friend?.uid, 'u_e2e0001');
    assert.ok(group, '群邀请没有进入运行时事件环');
    assert.equal(group?.sub_type, 'invite');
    assert.equal(group?.group_id, 30002);
    assert.equal(group?.uid, 'u_e2e0002');
  } finally {
    await runtime.close();
  }
});

/* ------------------------------------------------------------------ OneBot 事件层 */

const eventContext = { selfId: () => 10001 } as unknown as Parameters<typeof buildRequestEvent>[1];

test('OneBot request 事件：user_id=0 时带 uid，解析到 QQ 号时不带', () => {
  const unresolved = buildRequestEvent(
    {
      kind: 'friend',
      time: 1,
      scene: 'private',
      peer: { id: 'u_x' },
      user: { id: '0', uid: 'u_x' },
      comment: 'hi',
      flag: 'friend|u_x|1',
    } as AccountRequest,
    eventContext,
  );
  assert.equal(unresolved.user_id, 0);
  assert.equal(unresolved.uid, 'u_x');

  const resolved = buildRequestEvent(
    {
      kind: 'friend',
      time: 1,
      scene: 'private',
      peer: { id: '20009' },
      user: { id: '20009' },
      comment: 'hi',
      flag: 'friend|20009|1',
    } as AccountRequest,
    eventContext,
  );
  assert.equal(resolved.user_id, 20009);
  assert.equal(resolved.uid, undefined);

  const invite = buildRequestEvent(
    {
      kind: 'group',
      time: 1,
      scene: 'group',
      peer: { id: '30001' },
      user: { id: '0', uid: 'u_y' },
      comment: 'join',
      flag: 'group|1|2|30001',
      detail: { sub_type: 'invite' },
    } as AccountRequest,
    eventContext,
  );
  assert.equal(invite.sub_type, 'invite');
  assert.equal(invite.group_id, 30001);
  assert.equal(invite.uid, 'u_y');
});
