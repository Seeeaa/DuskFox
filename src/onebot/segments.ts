import { ActionError, RETCODE, type Ob11Message, type Ob11Segment } from './types.ts';
import type { Segment } from '../core/model.ts';

const CQ_ESCAPE: ReadonlyArray<[string, string]> = [
  ['&', '&amp;'],
  ['[', '&#91;'],
  [']', '&#93;'],
  [',', '&#44;'],
];

const CQ_UNESCAPE: ReadonlyArray<[string, string]> = [
  ['&#44;', ','],
  ['&#91;', '['],
  ['&#93;', ']'],
  ['&amp;', '&'],
];

export function escapeCq(value: string): string {
  let output = value;
  for (const [from, to] of CQ_ESCAPE) output = output.split(from).join(to);
  return output;
}

export function unescapeCq(value: string): string {
  let output = value;
  for (const [from, to] of CQ_UNESCAPE) output = output.split(from).join(to);
  return output;
}


/** Structural aliases retained for callers. Neither function rewrites segment data. */
export function toOb11Segment(segment: Segment): Ob11Segment { return segment; }
export function fromOb11Segment(segment: Ob11Segment): Segment { return segment; }

/** CQ is only a serialization format. Array-form messages retain every extension field. */
export function toCqString(segments: readonly Segment[]): string {
  return segments.map(segment => {
    if (segment.type === 'text') return escapeCq(String(segment.data.text ?? ''));
    const fields = Object.entries(segment.data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => key + '=' + escapeCq(typeof value === 'object' ? JSON.stringify(value) : String(value)));
    return '[CQ:' + segment.type + (fields.length ? ',' + fields.join(',') : '') + ']';
  }).join('');
}

interface ParsedCq {
  readonly type: string;
  readonly data: Record<string, string>;
}

function parseCqBody(body: string): ParsedCq {
  const parts = body.split(',');
  const type = parts.shift()?.trim() ?? '';
  const data: Record<string, string> = {};
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    data[key] = unescapeCq(part.slice(index + 1));
  }
  return { type, data };
}

/** Split a CQ string into segments. Unbalanced brackets stay literal text. */
export function parseCqString(input: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = '';
  let index = 0;
  const flush = (): void => {
    if (buffer) {
      segments.push({ type: 'text', data: { text: unescapeCq(buffer) } });
      buffer = '';
    }
  };
  while (index < input.length) {
    const open = input.indexOf('[CQ:', index);
    if (open < 0) {
      buffer += input.slice(index);
      break;
    }
    const close = input.indexOf(']', open);
    if (close < 0) {
      buffer += input.slice(index);
      break;
    }
    buffer += input.slice(index, open);
    const body = input.slice(open + 4, close);
    const parsed = parseCqBody(body);
    const known = new Set([
      'text',
      'face',
      'image',
      'at',
      'reply',
      'record',
      'video',
      'file',
      'json',
      'markdown',
      'forward',
    ]);
    if (!known.has(parsed.type)) {
      buffer += input.slice(open, close + 1);
    } else {
      flush();
      const segment = fromOb11Segment({ type: parsed.type, data: parsed.data });
      segments.push(segment);
    }
    index = close + 1;
  }
  flush();
  return segments;
}

/**
 * Read CQ strings or accept existing segment arrays.
 * Accepts segment arrays, CQ strings and plain strings.
 */
export function parseMessage(message: Ob11Message | undefined | null): Segment[] {
  if (message === undefined || message === null) throw new ActionError('缺少 message 字段', RETCODE.badParam);
  if (typeof message === 'string') return parseCqString(message);
  if (!Array.isArray(message)) throw new ActionError('message 必须是字符串或消息段数组', RETCODE.badParam);
  const segments: Segment[] = [];
  for (const item of message) {
    if (!item || typeof item !== 'object') throw new ActionError('消息段必须是对象', RETCODE.badParam);
    const segment = item as Ob11Segment;
    if (typeof segment.type !== 'string') throw new ActionError('消息段缺少 type', RETCODE.badParam);
    segments.push(fromOb11Segment(segment));
  }
  if (segments.length === 0) throw new ActionError('消息不能为空', RETCODE.badParam);
  return segments;
}


export function formatMessage(segments: readonly Segment[], format: 'array' | 'string'): Ob11Message {
  return format === 'string' ? toCqString(segments) : segments as Ob11Segment[];
}
