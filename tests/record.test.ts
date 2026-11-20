import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { attachKernelEvents, createBridgeServer, toOb11Segments } from '../runtime/bridge/server.mjs';
import { SimKernel, TINY_AMR } from '../runtime/bridge/sim-kernel.mjs';
import { formatMessage, parseCqString, toCqString } from '../src/onebot/segments.ts';
import type { RecordSegment, Segment } from '../src/core/model.ts';
import { startInstance, waitFor } from './helpers.ts';

function recordOf(segments: readonly Segment[]): RecordSegment {
  const hit = segments.find((segment): segment is RecordSegment => segment.type === 'record');
  if (!hit) throw new Error('消息里没有 record 段');
  return hit;
}

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

interface FakeRuntime {
  readonly base: string;
  readonly calls: Array<{ url: string; body: any }>;
  close(): Promise<void>;
}

/** Minimal contract-v2 runtime so capability negotiation can be tested without QQ. */
async function fakeRuntime(status: Record<string, unknown>, media?: Record<string, unknown>): Promise<FakeRuntime> {
  const calls: Array<{ url: string; body: any }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += String(chunk)));
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      calls.push({ url: url.pathname + url.search, body: body ? JSON.parse(body) : null });
      response.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/status') {
        response.end(JSON.stringify(status));
        return;
      }
      if (url.pathname === '/api/events') {
        response.end(JSON.stringify({ cursor: 0, events: [] }));
        return;
      }
      if (url.pathname === '/api/send') {
        response.end(JSON.stringify({ message_id: 'rt-out-1' }));
        return;
      }
      if (url.pathname === '/api/media') {
        if (!media) {
          response.writeHead(501);
          response.end(JSON.stringify({ error: '运行时未实现媒体下载' }));
          return;
        }
        response.end(JSON.stringify(media));
        return;
      }
      response.writeHead(404);
      response.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    base: 'http://127.0.0.1:' + port,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BASE_STATUS = {
  message_ready: true,
  self_id: 10001,
  nickname: '契约测试运行时',
  contract: 2,
  instance: 'rt-fake-1',
  phase: 'online',
};

test('语音：原生 pttElement 归一化成 OneBot record 段', () => {
  // NapCat 的 pttElement 没有 originUrl：path 来自 RichMedia 落盘，url 只在
  // 运行时真的换到 http 链接（GetPttUrl）时才有。
  const full = toOb11Segments({
    elements: [
      {
        elementType: 4,
        pttElement: { fileName: 'a.amr', filePath: '/qq/RichMedia/a.amr', fileSize: '1024', pttUrl: 'https://x/a.amr' },
      },
    ],
  });
  assert.deepEqual(full, [
    { type: 'record', data: { file: 'a.amr', path: '/qq/RichMedia/a.amr', url: 'https://x/a.amr', file_size: '1024' } },
  ]);

  // 只有 md5 时用 md5 当文件名，不能编造 path/url。
  const localOnly = toOb11Segments({ elements: [{ pttElement: { md5HexStr: 'md5-b' } }] });
  assert.deepEqual(localOnly, [{ type: 'record', data: { file: 'md5-b' } }]);

  // 非 http 的本地路径不能当 url 发出去，但仍作为 path 保留。
  const localPath = toOb11Segments({
    elements: [{ pttElement: { fileName: 'b.silk', filePath: 'C:\\tmp\\b.silk', pttUrl: 'C:\\tmp\\b.silk' } }],
  });
  assert.deepEqual(localPath, [{ type: 'record', data: { file: 'b.silk', path: 'C:\\tmp\\b.silk' } }]);
});

test('语音：CQ 字符串与消息段数组都能往返', () => {
  const segments = parseCqString('[CQ:record,file=a.amr,url=https://x/a.amr]');
  assert.deepEqual(segments, [{ type: 'record', data: { file: 'a.amr', url: 'https://x/a.amr' } }]);
  assert.equal(toCqString(segments), '[CQ:record,file=a.amr,url=https://x/a.amr]');
  assert.deepEqual(formatMessage(segments, 'array'), [
    { type: 'record', data: { file: 'a.amr', url: 'https://x/a.amr' } },
  ]);
});

test('语音：模拟内核入站语音映射成 record 段，并可用 get_record 取回音频', async () => {
  const { runtime, instance } = await bootPair();
  try {
    const voiceUrl = 'https://example.test/voice.amr';
    runtime.kernel.incoming({ voice: voiceUrl, text: '听一下' });
    await waitFor(
      () => instance.app.service.messages.recent(5).some((item) => item.segments.some((segment) => segment.type === 'record')),
      8000,
    );
    const stored = instance.app.service.messages
      .recent(5)
      .find((item) => item.segments.some((segment) => segment.type === 'record'));
    assert.ok(stored, '入站语音没有被存进消息窗口');
    const segment = recordOf(stored.segments);
    assert.match(segment.file, /\.amr$/);
    assert.equal(segment.url, voiceUrl);
    // path 是 QQ 容器里的 RichMedia 落盘路径，AstrBot 在 file 只是文件名时靠它取音频。
    assert.match(String(segment.path ?? ''), /\.amr$/);
    assert.equal(segment.size, TINY_AMR.length);

    await waitFor(async () => {
      const events = await instance.call('GET', '/api/events');
      return events.json.items.some((item: { type: string; summary: string }) => item.type === 'message.private' && item.summary.includes('[语音]'));
    }, 8000);

    const got = await instance.call('POST', '/api/action/get_record', { message_id: stored.ob11Id });
    assert.equal(got.json.status, 'ok');
    assert.match(String(got.json.data.file), /^base64:\/\//);
    assert.ok(String(got.json.data.file_name).endsWith('.amr'), '音频文件名应带 .amr 扩展名');
    assert.ok(
      Buffer.from(String(got.json.data.file).slice('base64://'.length), 'base64').equals(TINY_AMR),
      '取回的字节应与模拟内核发出的音频一致',
    );

    // OneBot 规范用消息段的 file 定位：只要消息还在窗口里，没有 message_id 也要能取。
    const byFile = await instance.call('POST', '/api/action/get_record', { file: segment.file });
    assert.equal(byFile.json.status, 'ok');
    assert.equal(byFile.json.data.file, got.json.data.file);

    // 查不到时必须明确失败，不能返回空音频。
    const missing = await instance.call('POST', '/api/action/get_record', { file: 'does-not-exist.amr' });
    assert.equal(missing.json.retcode, 1404);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('语音：出站 record 段经运行时发送，can_send_record 与实际一致', async () => {
  const { runtime, instance } = await bootPair();
  try {
    const can = await instance.call('POST', '/api/action/can_send_record', {});
    assert.equal(can.json.data.yes, true);

    const payload = 'base64://' + TINY_AMR.toString('base64');
    const sent = await instance.call('POST', '/api/action/send_private_msg', {
      user_id: 20001,
      message: [{ type: 'record', data: { file: payload } }],
    });
    assert.equal(sent.json.status, 'ok');
    const wire = runtime.kernel.sent[0] as any;
    assert.equal(wire?.segments?.[0]?.type, 'record');
    assert.equal(wire?.segments?.[0]?.data?.file, payload);

    const stored = await instance.call('POST', '/api/action/get_msg', { message_id: sent.json.data.message_id });
    assert.equal(stored.json.status, 'ok');
    assert.equal(stored.json.data.message[0].type, 'record');
    assert.match(String(stored.json.data.raw_message), /^\[CQ:record,file=/);

    const media = await instance.call('POST', '/api/action/get_record', { message_id: sent.json.data.message_id });
    assert.equal(media.json.status, 'ok');
    assert.match(String(media.json.data.file), /^base64:\/\//);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('语音：运行时未声明语音出站时能力为假，动作被明确拒绝', async () => {
  // 能收语音、不能发语音：媒体位必须按方向如实收缩，不能因为能收就宣称能发。
  const runtime = await fakeRuntime({
    ...BASE_STATUS,
    features: { privateMessage: true, groupMessage: true, mediaImage: true, mediaRecord: true },
    send_segments: ['text', 'image'],
    recv_segments: ['text', 'image', 'record'],
  });
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: runtime.base } });
  try {
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true, 8000);
    const can = await instance.call('POST', '/api/action/can_send_record', {});
    assert.equal(can.json.data.yes, false);

    const sent = await instance.call('POST', '/api/action/send_private_msg', {
      user_id: 20001,
      message: [{ type: 'record', data: { file: 'base64://AAAA' } }],
    });
    assert.equal(sent.json.retcode, 1200);
    assert.equal(runtime.calls.some((call) => call.url === '/api/send'), false);

    // 运行时没有 media 接口：get_record 必须报"不支持"而不是返回空音频。
    const got = await instance.call('POST', '/api/action/get_record', { message_id: 1 });
    assert.equal(got.json.retcode, 1200);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});

test('语音：契约声明语音双向后，发送走 /api/send、get_record 走 /api/media', async () => {
  const runtime = await fakeRuntime(
    {
      ...BASE_STATUS,
      features: { privateMessage: true, groupMessage: true, mediaRecord: true, mediaDownload: true },
      send_segments: ['text', 'record'],
      recv_segments: ['text', 'record'],
      // 下载是独立方向：不声明它，get_record 会被正确拒绝。
      download_segments: ['record'],
    },
    { base64: TINY_AMR.toString('base64'), name: 'voice.amr', size: TINY_AMR.length },
  );
  const instance = await startInstance({ driver: 'bridge', driverOptions: { endpoint: runtime.base } });
  try {
    await waitFor(async () => (await instance.call('GET', '/api/status')).json.account.online === true, 8000);
    const can = await instance.call('POST', '/api/action/can_send_record', {});
    assert.equal(can.json.data.yes, true);

    const sent = await instance.call('POST', '/api/action/send_private_msg', {
      user_id: 20001,
      message: [{ type: 'record', data: { file: 'base64://AAAA' } }],
    });
    assert.equal(sent.json.status, 'ok');
    const sendCall = runtime.calls.find((call) => call.url === '/api/send');
    assert.equal(sendCall?.body?.segments?.[0]?.type, 'record');
    assert.equal(sendCall?.body?.segments?.[0]?.data?.file, 'base64://AAAA');

    const got = await instance.call('POST', '/api/action/get_record', { message_id: sent.json.data.message_id });
    assert.equal(got.json.status, 'ok');
    assert.equal(got.json.data.file, 'base64://' + TINY_AMR.toString('base64'));
    assert.equal(got.json.data.file_name, 'voice.amr');
    const mediaCall = runtime.calls.find((call) => call.url.startsWith('/api/media'));
    assert.match(mediaCall?.url ?? '', /kind=record/);
  } finally {
    await instance.stop();
    await runtime.close();
  }
});
