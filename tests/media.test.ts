import assert from 'node:assert/strict';
import test from 'node:test';
import { attachKernelEvents, createBridgeServer } from '../runtime/bridge/server.mjs';
import { SimKernel, TINY_FILE, TINY_VIDEO } from '../runtime/bridge/sim-kernel.mjs';
import { startInstance, waitFor } from './helpers.ts';

async function bootPair() {
  const kernel = new SimKernel({ autoLogin: true, qrTtlMs: 60_000 });
  const bridge = createBridgeServer({ kernel, token: 'runtime-token', qrPump: true, qrCooldownMs: 50 });
  await attachKernelEvents(bridge, kernel);
  const address = await bridge.listen(0, '127.0.0.1');
  const port = typeof address === 'object' && address ? address.port : 0;
  const runtime = {
    kernel,
    base: 'http://127.0.0.1:' + port,
    async close() {
      await bridge.close();
      await kernel.stop();
    },
  };
  const instance = await startInstance({
    driver: 'bridge',
    driverOptions: { endpoint: runtime.base, token: 'runtime-token' },
  });
  await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true, 10_000);
  return { runtime, instance };
}

function storedWith(instance: any, kind: string) {
  const hit = instance.app.service.messages.recent(10).find((item: any) => item.segments.some((s: any) => s.type === kind));
  if (!hit) throw new Error('没有存下 ' + kind + ' 段的消息');
  return hit;
}

test('普通文件：入站带文件名/大小，get_file 取回字节，出站可发送', async () => {
  const { runtime, instance } = await bootPair();
  try {
    runtime.kernel.incoming({ file: { name: '报告.pdf' }, text: '文件来了' });
    await waitFor(() => instance.app.service.messages.recent(10).some((m: any) => m.segments.some((s: any) => s.type === 'file')), 8000);
    const stored = storedWith(instance, 'file');
    const segment = stored.segments.find((s: any) => s.type === 'file');
    assert.equal(segment.name, '报告.pdf');
    assert.equal(segment.size, TINY_FILE.length);
    // path 属于 QQ 运行时环境：跨容器不能直接读，只能靠 get_file 取字节。
    assert.equal(typeof segment.path, 'string');

    const got = await instance.call('POST', '/api/action/get_file', { message_id: stored.ob11Id });
    assert.equal(got.json.status, 'ok', JSON.stringify(got.json));
    assert.ok(Buffer.from(String(got.json.data.file).slice('base64://'.length), 'base64').equals(TINY_FILE));

    const sent = await instance.call('POST', '/api/action/send_private_msg', {
      user_id: 20001,
      message: [{ type: 'file', data: { file: 'report.pdf', name: 'report.pdf' } }],
    });
    assert.equal(sent.json.status, 'ok');
    assert.equal((runtime.kernel.sent[0] as any)?.segments?.[0]?.type, 'file');
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('视频：入站保留实际时长与文件名，get_video 取回字节', async () => {
  const { runtime, instance } = await bootPair();
  try {
    runtime.kernel.incoming({ video: { name: 'clip.mp4', duration: 12 } });
    await waitFor(() => instance.app.service.messages.recent(10).some((m: any) => m.segments.some((s: any) => s.type === 'video')), 8000);
    const stored = storedWith(instance, 'video');
    const segment = stored.segments.find((s: any) => s.type === 'video');
    assert.equal(segment.name, 'clip.mp4');
    assert.equal(segment.duration, 12);
    assert.equal(segment.size, TINY_VIDEO.length);

    const got = await instance.call('POST', '/api/action/get_video', { message_id: stored.ob11Id });
    assert.equal(got.json.status, 'ok');
    assert.ok(Buffer.from(String(got.json.data.file).slice('base64://'.length), 'base64').equals(TINY_VIDEO));
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('合并转发：入站拿到 id，get_forward_msg 展开节点并保留文本', async () => {
  const { runtime, instance } = await bootPair();
  try {
    runtime.kernel.incoming({
      forward: [
        { user_id: '20001', nickname: '甲', time: 1795000000, message: [{ type: 'text', data: { text: '第一条' } }] },
        { user_id: '20002', nickname: '乙', time: 1795000100, message: [{ type: 'text', data: { text: '第二条' } }] },
      ],
    });
    await waitFor(() => instance.app.service.messages.recent(10).some((m: any) => m.segments.some((s: any) => s.type === 'forward')), 8000);
    const stored = storedWith(instance, 'forward');
    const segment = stored.segments.find((s: any) => s.type === 'forward');
    assert.match(String(segment.id), /^sim-fwd-in-/);

    const expanded = await instance.call('POST', '/api/action/get_forward_msg', { message_id: stored.ob11Id });
    assert.equal(expanded.json.status, 'ok');
    assert.equal(expanded.json.data.messages.length, 2);
    assert.equal(expanded.json.data.messages[0].message[0].data.text, '第一条');
    assert.equal(expanded.json.data.messages[1].user_id, 20002);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('合并转发：只有 id 无法展开时明确报错，不返回空节点', async () => {
  const { runtime, instance } = await bootPair();
  try {
    const expanded = await instance.call('POST', '/api/action/get_forward_msg', { id: 'no-such-forward' });
    assert.notEqual(expanded.json.status, 'ok');
    assert.equal(expanded.json.retcode, 1404);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('媒体下载：对不支持的类型（文本消息）报错而不是给空字节', async () => {
  const { runtime, instance } = await bootPair();
  try {
    runtime.kernel.incoming({ text: '只是文本' });
    await waitFor(() => instance.app.service.messages.recent(10).some((m: any) => m.segments.some((s: any) => s.type === 'text')), 8000);
    const stored = storedWith(instance, 'text');
    const got = await instance.call('POST', '/api/action/get_file', { message_id: stored.ob11Id });
    assert.notEqual(got.json.status, 'ok');
  } finally {
    await instance.stop();
    await runtime.close();
  }
});
