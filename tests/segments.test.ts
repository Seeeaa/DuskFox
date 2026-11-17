import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMessage, parseCqString, parseMessage, toCqString } from '../src/onebot/segments.ts';
import { ActionError } from '../src/onebot/types.ts';

test('CQ 字符串解析：文本与表情、@、图片', () => {
  const segments = parseCqString('你好[CQ:face,id=14] [CQ:at,qq=all] [CQ:image,file=a.png,url=https://x/y.png]');
  assert.deepEqual(segments, [
    { type: 'text', text: '你好' },
    { type: 'face', id: '14' },
    { type: 'text', text: ' ' },
    { type: 'at', target: 'all' },
    { type: 'text', text: ' ' },
    { type: 'image', file: 'a.png', url: 'https://x/y.png' },
  ]);
});

test('CQ 字符串里的特殊字符往返不丢失', () => {
  const segments = [{ type: 'text', text: 'a&b[c],d' }] as const;
  const cq = toCqString(segments);
  assert.equal(cq, 'a&amp;b&#91;c&#93;&#44;d');
  assert.deepEqual(parseCqString(cq), [{ type: 'text', text: 'a&b[c],d' }]);
});

test('未闭合或未知的 CQ 片段当作普通文本保留', () => {
  assert.deepEqual(parseCqString('x[CQ:unknown,a=1]y'), [
    { type: 'text', text: 'x[CQ:unknown,a=1]y' },
  ]);
  assert.deepEqual(parseCqString('x[CQ:face,id=1'), [{ type: 'text', text: 'x[CQ:face,id=1' }]);
});

test('消息段数组与 CQ 字符串两种入参都能解析', () => {
  const fromArray = parseMessage([{ type: 'text', data: { text: 'hi' } }]);
  assert.deepEqual(fromArray, [{ type: 'text', text: 'hi' }]);
  const fromString = parseMessage('hi');
  assert.deepEqual(fromString, [{ type: 'text', text: 'hi' }]);
});

test('非法消息入参抛出参数错误', () => {
  assert.throws(() => parseMessage([]), ActionError);
  assert.throws(() => parseMessage(undefined), ActionError);
  assert.throws(() => parseMessage([{ data: {} }] as never), ActionError);
});

test('CQ 字符串格式输出按配置生效', () => {
  const segments = [
    { type: 'text', text: 'ping' },
    { type: 'face', id: '1' },
  ] as const;
  assert.equal(formatMessage(segments, 'string'), 'ping[CQ:face,id=1]');
  assert.deepEqual(formatMessage(segments, 'array'), [
    { type: 'text', data: { text: 'ping' } },
    { type: 'face', data: { id: '1' } },
  ]);
});

test('未知消息段保留为 unknown 而不是静默丢弃', () => {
  const segments = parseMessage([{ type: 'mface', data: { url: 'x' } }]);
  assert.equal(segments[0]?.type, 'unknown');
});

test('输出未知消息段时保留原始类型与负载，不变成空文本', () => {
  const out = formatMessage(
    [{ type: 'unknown', kind: 'mface', raw: { url: 'x', summary: '[动画表情]' } }],
    'array',
  );
  assert.deepEqual(out, [{ type: 'mface', data: { url: 'x', summary: '[动画表情]' } }]);
});
