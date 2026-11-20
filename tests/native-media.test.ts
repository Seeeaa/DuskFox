import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NativeKernel } from '../runtime/bridge/native-kernel.cjs';

function probe(stub: Record<string, unknown> = {}) {
  const kernel = new NativeKernel();
  const emitted: Array<Record<string, any>> = [];
  kernel.state.emit = (event: unknown) => { emitted.push(event as Record<string, any>); };
  kernel.state.session = {};
  kernel.state.uin = '10001';
  kernel.state.msgService = stub;
  return { kernel, emitted };
}

function tempFile(name: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duskfox-native-media-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

function richMediaStub(): { getRichMediaFilePathForGuild?: unknown; calls: any[] } {
  const calls: any[] = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duskfox-richmedia-'));
  return {
    calls,
    getRichMediaFilePathForGuild: (args: any) => {
      calls.push(args);
      return path.join(dir, String(args.fileName || 'x.bin'));
    },
  };
}

test('原生文件发送：走 RichMedia 复制并构造 fileElement（ElementType.FILE=3）', async () => {
  const source = tempFile('报告.pdf', '%PDF-1.4 duskfox');
  const stub = richMediaStub();
  const { kernel } = probe(stub);
  const element = await kernel.buildFileElement(source, '报告.pdf');
  assert.equal(element.elementType, 3);
  assert.equal(element.fileElement.fileName, '报告.pdf');
  assert.equal(element.fileElement.fileSize, String(fs.statSync(source).size));
  assert.match(String(element.fileElement.fileMd5), /^[0-9a-f]{32}$/);
  assert.equal(stub.calls.length, 1, '必须调用 getRichMediaFilePathForGuild');
  assert.ok(fs.existsSync(element.fileElement.filePath), '复制后的 RichMedia 文件应当存在');
});

test('原生视频发送：fileTime 用真实时长，fileFormat=2，不编造元数据', async () => {
  const source = tempFile('clip.mp4', 'ftypmp42-duskfox');
  const stub = richMediaStub();
  const { kernel } = probe(stub);
  const element = await kernel.buildVideoElement(source, 'clip.mp4', 12);
  assert.equal(element.elementType, 5);
  assert.equal(element.videoElement.fileTime, 12);
  assert.equal(element.videoElement.fileFormat, 2);
  assert.equal(element.videoElement.fileName, 'clip.mp4');
  const unknownDuration = await kernel.buildVideoElement(source, 'clip.mp4', 0);
  assert.equal(unknownDuration.videoElement.fileTime, 0, '拿不到时长就写 0，不能瞎填');
});

test('原生发送：客户端没有 RichMedia 接口时明确报错，不假装成功', async () => {
  const source = tempFile('x.bin', 'x');
  const { kernel } = probe({});
  await assert.rejects(() => kernel.buildFileElement(source, 'x.bin'), /RichMedia/);
});

test('原生发送：http 链接直接拒绝，避免把远端内容当本地文件', async () => {
  const { kernel } = probe(richMediaStub());
  await assert.rejects(() => kernel.buildFileElement('https://example.test/a.pdf', 'a.pdf'), /URL/);
});

test('原生合并转发展开：按 getMultiMsg(parentPeer, 最外层id, msgId) 调用并返回节点', async () => {
  const calls: any[] = [];
  const { kernel } = probe({
    getMultiMsg: async (...args: any[]) => {
      calls.push(args);
      return { msgList: [{ msgId: 'inner-1' }, { msgId: 'inner-2' }] };
    },
  });
  kernel.getMessage = async () => ({
    msgId: 'fwd-outer',
    chatType: 2,
    peerUid: '30001',
    parentMsgIdList: ['fwd-outer'],
    elements: [{ multiForwardMsgElement: { resId: 'res-1' } }],
  });
  const nodes = await kernel.getForward('fwd-outer');
  assert.ok(nodes, '展开失败时不应返回 null');
  assert.equal(nodes.length, 2);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], { chatType: 2, guildId: '', peerUid: '30001' });
  assert.equal(calls[0][1], 'fwd-outer');
  assert.equal(calls[0][2], 'fwd-outer');
});

test('原生合并转发展开：缺 parentMsgPeer/parentMsgIdList 时用 chatType+peerUid 兜底', async () => {
  const calls: any[] = [];
  const { kernel } = probe({
    getMultiMsg: async (...args: any[]) => {
      calls.push(args);
      return { msgList: [{ msgId: 'inner-1' }] };
    },
  });
  kernel.getMessage = async () => ({
    msgId: 'fwd-private',
    chatType: 1,
    peerUid: 'u_20001',
    elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'res-2', xmlContent: '', fileName: '摘要' } }],
  });
  const nodes = await kernel.getForward('fwd-private');
  assert.ok(nodes);
  assert.equal(nodes.length, 1);
  assert.deepEqual(calls[0][0], { chatType: 1, guildId: '', peerUid: 'u_20001' });
  assert.equal(calls[0][1], 'fwd-private', '没有 parentMsgIdList 时最外层 id 退回自身');
});

test('原生合并转发展开：返回结构认不出时返回 null，不把 raw 对象当节点', async () => {
  const { kernel } = probe({ getMultiMsg: async () => ({ unexpected: true }) });
  kernel.getMessage = async () => ({ msgId: 'x', chatType: 1, peerUid: 'u', elements: [] });
  assert.equal(await kernel.getForward('x'), null);
});

test('原生在线判据：已授权 + 消息服务在即在线，空闲 6 分钟不算掉线', () => {
  const { kernel } = probe({});
  kernel.state.uin = '10001';
  (kernel as any).state.loginSucceeded = true;
  kernel.state.msgService = {};
  (kernel as any).state.messageBinding = { session: kernel.state.session, service: kernel.state.msgService, id: 'listener-1' };
  kernel.state.lastMsgAt = Date.now() - 6 * 60_000;
  const status = kernel.status();
  assert.equal(status.online, true, '空闲不等于掉线，否则所有发送会被 1404 拒绝');
  assert.ok(status.idleMs >= 5 * 60_000, '空闲时长要单独暴露给控制台');
});

test('原生转发展开：按 resId 查询时用缓存的所属消息与 peer', async () => {
  const calls: any[] = [];
  const { kernel } = probe({
    getMultiMsg: async (...args: any[]) => {
      calls.push(args);
      return { result: { msgList: [{ msgId: 'inner-1' }] } };
    },
  });
  kernel.getMessage = async () => null;
  kernel.onNativeMessage({
    msgId: 'owner-msg',
    chatType: 2,
    peerUid: '30001',
    elements: [{ elementType: 16, multiForwardMsgElement: { resId: 'res-cache', xmlContent: '', fileName: '摘要' } }],
  });
  const nodes = await kernel.getForward('res-cache');
  assert.ok(nodes, 'resId 应能通过缓存展开');
  assert.equal(nodes.length, 1);
  assert.deepEqual(calls[0][0], { chatType: 2, guildId: '', peerUid: '30001' });
  assert.equal(calls[0][2], 'owner-msg', '要用所属消息的 msgId 去展开');
});

test('原生合并转发展开：客户端没有 getMultiMsg 时必须报错而不是返回空节点', async () => {
  const { kernel } = probe({});
  await assert.rejects(() => kernel.getForward('any'), /getMultiMsg/);
});
