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

/** Which internal segment type maps to which OneBot segment type. */
const INTERNAL_TO_OB11: Record<string, string> = {
  text: 'text',
  face: 'face',
  image: 'image',
  at: 'at',
  reply: 'reply',
  record: 'record',
  video: 'video',
  file: 'file',
  json: 'json',
  markdown: 'markdown',
  forward: 'forward',
};

const OB11_TO_INTERNAL = new Set(Object.values(INTERNAL_TO_OB11));

/** Internal segment -> OneBot segment. Unknown types are preserved verbatim. */
export function toOb11Segment(segment: Segment): Ob11Segment {
  switch (segment.type) {
    case 'text':
      return { type: 'text', data: { text: segment.text } };
    case 'face':
      return { type: 'face', data: { id: segment.id } };
    case 'image': {
      const data: Record<string, unknown> = { file: segment.file };
      if (segment.url) data.url = segment.url;
      if (segment.summary) data.summary = segment.summary;
      return { type: 'image', data };
    }
    case 'at':
      return { type: 'at', data: { qq: segment.target, ...(segment.name ? { name: segment.name } : {}) } };
    case 'reply':
      return { type: 'reply', data: { id: segment.id } };
    case 'record': {
      const data: Record<string, unknown> = { file: segment.file };
      // NapCat 习惯额外给 path / file_size，AstrBot 在 file 只是文件名时会用 path。
      if (segment.url) data.url = segment.url;
      if (segment.path) data.path = segment.path;
      if (segment.size !== undefined) data.file_size = segment.size;
      return { type: 'record', data };
    }
    case 'video': {
      const data: Record<string, unknown> = { file: segment.file };
      if (segment.url) data.url = segment.url;
      return { type: 'video', data };
    }
    case 'file': {
      const data: Record<string, unknown> = { file: segment.file };
      if (segment.name) data.name = segment.name;
      if (segment.size !== undefined) data.file_size = segment.size;
      if (segment.url) data.url = segment.url;
      return { type: 'file', data };
    }
    case 'json':
      return { type: 'json', data: { data: segment.data } };
    case 'markdown':
      return { type: 'markdown', data: { content: segment.content } };
    case 'forward':
      return { type: 'forward', data: { id: segment.id } };
    default: {
      // Never silently drop a segment: keep the original type and payload so a
      // bot can at least see that something unsupported arrived.
      const kind = segment.type === 'unknown' ? segment.kind : 'unknown';
      const raw = segment.type === 'unknown' ? segment.raw : undefined;
      return { type: kind, data: raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>) } : {} };
    }
  }
}

/** OneBot segment -> internal segment. Throws on shapes the driver cannot use. */
export function fromOb11Segment(segment: Ob11Segment): Segment {
  const type = String(segment?.type ?? '');
  const data = (segment?.data ?? {}) as Record<string, unknown>;
  switch (type) {
    case 'text':
      return { type: 'text', text: String(data.text ?? '') };
    case 'face':
      return { type: 'face', id: String(data.id ?? '') };
    case 'image':
      return {
        type: 'image',
        file: String(data.file ?? data.url ?? ''),
        ...(data.url ? { url: String(data.url) } : {}),
        ...(data.summary ? { summary: String(data.summary) } : {}),
      };
    case 'at': {
      const target = String(data.qq ?? '');
      return { type: 'at', target: target === 'all' ? 'all' : target, ...(data.name ? { name: String(data.name) } : {}) };
    }
    case 'reply':
      return { type: 'reply', id: String(data.id ?? '') };
    case 'record':
      return {
        type: 'record',
        file: String(data.file ?? data.url ?? ''),
        ...(data.url ? { url: String(data.url) } : {}),
        ...(data.path ? { path: String(data.path) } : {}),
        ...(data.file_size !== undefined ? { size: Number(data.file_size) } : {}),
      };
    case 'video':
      return { type: 'video', file: String(data.file ?? data.url ?? ''), ...(data.url ? { url: String(data.url) } : {}) };
    case 'file':
      return {
        type: 'file',
        file: String(data.file ?? data.url ?? ''),
        ...(data.name ? { name: String(data.name) } : {}),
        ...(data.file_size !== undefined ? { size: Number(data.file_size) } : {}),
        ...(data.url ? { url: String(data.url) } : {}),
      };
    case 'json':
      return { type: 'json', data: typeof data.data === 'string' ? data.data : JSON.stringify(data.data ?? {}) };
    case 'markdown':
      return { type: 'markdown', content: String(data.content ?? data.data ?? '') };
    case 'forward':
      return { type: 'forward', id: String(data.id ?? '') };
    default:
      if (OB11_TO_INTERNAL.has(type)) return { type: 'text', text: '' };
      return { type: 'unknown', kind: type, raw: segment };
  }
}

/** Rendered CQ string used for `raw_message` and string format messages. */
export function toCqString(segments: readonly Segment[]): string {
  return segments
    .map((segment) => {
      switch (segment.type) {
        case 'text':
          return escapeCq(segment.text);
        case 'face':
          return `[CQ:face,id=${segment.id}]`;
        case 'image': {
          const parts = [`file=${escapeCq(segment.file)}`];
          if (segment.url) parts.push(`url=${escapeCq(segment.url)}`);
          if (segment.summary) parts.push(`summary=${escapeCq(segment.summary)}`);
          return `[CQ:image,${parts.join(',')}]`;
        }
        case 'at':
          return `[CQ:at,qq=${escapeCq(segment.target)}]`;
        case 'reply':
          return `[CQ:reply,id=${segment.id}]`;
        case 'record': {
          const parts = [`file=${escapeCq(segment.file)}`];
          if (segment.url) parts.push(`url=${escapeCq(segment.url)}`);
          return `[CQ:record,${parts.join(',')}]`;
        }
        case 'video':
          return `[CQ:video,file=${escapeCq(segment.file)}]`;
        case 'file': {
          const parts = [`file=${escapeCq(segment.file)}`];
          if (segment.name) parts.push(`name=${escapeCq(segment.name)}`);
          if (segment.size !== undefined) parts.push(`file_size=${segment.size}`);
          return `[CQ:file,${parts.join(',')}]`;
        }
        case 'json':
          return `[CQ:json,data=${escapeCq(segment.data)}]`;
        case 'markdown':
          return `[CQ:markdown,content=${escapeCq(segment.content)}]`;
        case 'forward':
          return `[CQ:forward,id=${escapeCq(segment.id)}]`;
        default: {
          const kind = segment.type === 'unknown' ? segment.kind : 'unknown';
          return `[CQ:${escapeCq(kind)}]`;
        }
      }
    })
    .join('');
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
      segments.push({ type: 'text', text: unescapeCq(buffer) });
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
 * Normalise whatever a bot sent into internal segments.
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

/** Render internal segments for a bot, honouring the configured format. */
export function formatMessage(segments: readonly Segment[], format: 'array' | 'string'): Ob11Message {
  if (format === 'string') return toCqString(segments);
  return segments.map(toOb11Segment);
}
