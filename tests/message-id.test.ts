import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageIdRegistry } from '../src/core/message-id.ts';

test('哈希模式下同一消息得到相同 id', () => {
  const registry = new MessageIdRegistry('hash');
  const first = registry.register('native-1', 'private', '20001');
  const second = registry.register('native-1', 'private', '20001');
  assert.equal(first, second);
  assert.equal(first > 0, true);
  assert.equal(registry.resolve(first)?.nativeId, 'native-1');
});

test('不同会话的同一原生 id 映射到不同数字 id', () => {
  const registry = new MessageIdRegistry('hash');
  const a = registry.register('m1', 'private', '20001');
  const b = registry.register('m1', 'group', '30001');
  assert.notEqual(a, b);
  assert.equal(registry.resolve(a)?.scene, 'private');
  assert.equal(registry.resolve(b)?.scene, 'group');
});

test('自增模式按顺序发号', () => {
  const registry = new MessageIdRegistry('seq');
  assert.equal(registry.register('a', 'private', '1'), 1);
  assert.equal(registry.register('b', 'private', '1'), 2);
  assert.equal(registry.nativeIdOf(2), 'b');
});

test('容量上限会淘汰最旧的映射', () => {
  const registry = new MessageIdRegistry('seq', 3);
  const ids = ['a', 'b', 'c', 'd'].map((id) => registry.register(id, 'private', '1'));
  assert.equal(registry.size, 3);
  assert.equal(registry.resolve(ids[0] ?? 0), null);
  assert.equal(registry.resolve(ids[3] ?? 0)?.nativeId, 'd');
});

test('切换 id 策略会清空旧映射，避免返回不可解析的 id', () => {
  const registry = new MessageIdRegistry('hash');
  const id = registry.register('x', 'private', '1');
  registry.mode = 'seq';
  assert.equal(registry.resolve(id), null);
  assert.equal(registry.size, 0);
});
