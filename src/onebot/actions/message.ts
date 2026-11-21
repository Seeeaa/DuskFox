import { Type } from '@sinclair/typebox';
import type { ActionContext, ActionDefinition } from './registry.ts';
import { GroupIdSchema, MessageIdSchema, MessageSchema, UserIdSchema } from './registry.ts';
import { ActionError, RETCODE } from '../types.ts';
import { formatMessage, parseMessage, toCqString } from '../segments.ts';
import type { OutboundMessage, Scene, Segment } from '../../core/model.ts';
import { mediaReference, parseMediaReference, type MediaKind } from '../media.ts';

interface MessageShape {
  readonly ob11Id: number;
  readonly nativeId: string;
  readonly selfId: number;
  readonly scene: Scene;
  readonly peerId: string;
  readonly senderId: string;
  readonly senderName?: string;
  readonly senderCard?: string;
  readonly senderRole?: 'owner' | 'admin' | 'member';
  readonly time: number;
  readonly segments: readonly Segment[];
  readonly format: 'array' | 'string';
}

/** The exact payload `get_msg` returns, whether from the window or the runtime. */
function shapeMessage(input: MessageShape, context?: ActionContext): Record<string, unknown> {
  const readable = context?.media?.decorate(input.nativeId, input.segments) || input.segments;
  const segments = context ? readable.map(segment => segment.type === 'reply'
    ? { ...segment, data: { ...segment.data, id: String(context.messageIds.register(String(segment.data.id || ''), input.scene, input.peerId)) } }
    : segment) : readable;
  return {
    // NapCat 的 get_msg 返回的是完整 message 事件形状，框架会直接把它当事件消费，
    // 只给 8 个字段会让读 post_type/self_id/sub_type 的插件拿不到值。
    post_type: 'message',
    self_id: input.selfId,
    message_id: input.ob11Id,
    message_seq: input.ob11Id,
    real_id: Number(input.nativeId) || 0,
    real_seq: input.ob11Id,
    message_type: input.scene,
    sub_type: input.scene === 'group' ? 'normal' : 'friend',
    ...(input.scene === 'group'
      ? { group_id: Number(input.peerId) || 0 }
      : { user_id: Number(input.peerId) || 0 }),
    sender: {
      user_id: Number(input.senderId) || 0,
      nickname: input.senderName ?? '',
      ...(input.senderCard ? { card: input.senderCard } : {}),
      ...(input.senderRole ? { role: input.senderRole } : {}),
    },
    time: input.time,
    font: 14,
    // 与 message 的实际序列化格式保持一致。
    message_format: input.format,
    message: formatMessage(segments, input.format),
    raw_message: toCqString(segments),
  };
}

interface SendParams {
  readonly message_type?: 'private' | 'group';
  readonly user_id?: number;
  readonly group_id?: number;
  readonly message: string | unknown[];
  readonly auto_escape?: boolean;
}

function segmentsFrom(params: SendParams): Segment[] {
  if (params.auto_escape && typeof params.message === 'string') {
    return [{ type: 'text', data: { text: params.message } }];
  }
  const parsed = parseMessage(params.message as never);
  return parsed.length && parsed.every(segment => segment.type === 'node')
    ? [{ type: 'forward', data: { content: parsed } }] : parsed;
}

function replyTarget(segments: readonly Segment[]): string | undefined {
  for (const segment of segments) {
    if (segment.type === 'reply') return String(segment.data.id ?? '');
  }
  return undefined;
}

/** 引用段的 id 由机器人按 OneBot 数字 id 传回；驱动层要的是原生 msgId。 */
function withNativeReplyIds(segments: readonly Segment[], context: ActionContext): Segment[] {
  return segments.map((segment) => {
    if (segment.type === 'forward') {
      const content = segment.data.content ?? segment.data.messages;
      return Array.isArray(content) ? { ...segment, data: {
        ...segment.data, content: withNativeReplyIds(content as Segment[], context),
      } } : segment;
    }
    if (segment.type === 'node') {
      const data = { ...segment.data };
      const id = data.id ?? data.message_id;
      if (id !== undefined) {
        const value = String(id);
        const resolved = /^\d{1,10}$/.test(value) ? context.messageIds.resolve(Number(value)) : null;
        if (resolved) {
          data.id = context.messages.get(Number(value))?.nativeId || resolved.nativeId;
          data.source_peer = { chatType: resolved.scene === 'group' ? 2 : 1, peerUid: resolved.peerId, guildId: '' };
        } else data.id = value;
      } else if (data.content !== undefined) {
        data.content = withNativeReplyIds(parseMessage(data.content as never), context);
      }
      return { ...segment, data };
    }
    if (segment.type !== 'reply') return segment;
    const nativeId = context.messages.get(Number(segment.data.id))?.nativeId || context.messageIds.nativeIdOf(Number(segment.data.id));
    return nativeId ? { ...segment, data: { ...segment.data, id: nativeId } } : segment;
  });
}

async function send(scene: Scene, peerId: number, params: SendParams, context: ActionContext): Promise<{ message_id: number }> {
  const parsed = segmentsFrom(params);
  const segments = withNativeReplyIds(parsed, context);
  const verdict = checkSegments(segments, scene, context);
  if (verdict) throw verdict;
  if (!context.online()) throw new ActionError('账号未登录，无法发送消息', RETCODE.notFound);
  const outbound: OutboundMessage = {
    scene,
    peerId: String(peerId),
    segments,
    ...(replyTarget(segments) ? { replyTo: replyTarget(segments) } : {}),
  };
  let result: { messageId: string };
  try {
    result = await context.driver.sendMessage(outbound);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes('SEND_RESULT_UNKNOWN')) {
      // 明确告知"结果未知"，并写进日志便于 08 对照真实投递。
      context.logger.warn('onebot', '发送结果未知：' + detail);
      throw new ActionError(
        '发送结果未知：消息可能已送达，但未取得可引用的 message_id；请勿自动重试以免重复发送',
        RETCODE.server,
      );
    }
    throw error;
  }
  context.logger.info(
    'onebot',
    '发 ' + (scene === 'group' ? '群 ' + peerId : '私聊 ' + peerId) +
      ' [' + segments.map((segment) => segment.type).join(',') + ']' +
      (outbound.replyTo ? ' 引用=' + outbound.replyTo : ''),
  );
  context.stats.incMessagesOut();
  const numericId = context.messageIds.register(result.messageId, scene, String(peerId));
  context.messages.save({
    nativeId: result.messageId,
    ob11Id: numericId,
    scene,
    peerId: String(peerId),
    senderId: String(context.selfId() || ''),
    time: Math.floor(Date.now() / 1000),
    self: true,
    segments,
  });
  return { message_id: numericId };
}

/** Refuse segment kinds the driver cannot deliver instead of silently dropping them. */
function checkSegments(segments: readonly Segment[], scene: Scene, context: ActionContext): ActionError | null {
  if (scene === 'group' && !context.driver.capabilities.groupMessage) {
    return new ActionError('当前驱动不支持群消息', RETCODE.unsupported);
  }
  if (scene === 'private' && !context.driver.capabilities.privateMessage) {
    return new ActionError('当前驱动不支持私聊消息', RETCODE.unsupported);
  }
  if (segments.length === 0) return new ActionError('消息不能为空', RETCODE.badParam);
  // 出站只看 send 方向：以前读 mediaImage 等"双向"兼容位（= send && recv），
  // "能发不能收"的驱动会被错误拒绝。
  const send = context.driver.capabilities.send;
  const labels: Record<string, string> = {
    image: '图片',
    record: '语音',
    video: '视频',
    file: '文件',
    at: '@ 提及',
    face: '表情',
    forward: '合并转发',
    json: 'JSON 卡片',
    markdown: 'Markdown',
  };
  for (const segment of segments) {
    if (segment.type === 'text' || segment.type === 'reply') continue;
    if (!send[segment.type as keyof typeof send]) {
      return new ActionError(`当前驱动不支持发送${labels[segment.type] ?? segment.type}消息段`, RETCODE.unsupported);
    }
  }
  return null;
}

interface MediaParams {
  readonly message_id?: number;
  readonly file?: string;
  readonly file_id?: string;
}

function locateMedia(params: MediaParams, kind: MediaKind, context: ActionContext): string {
  const wanted = String(params.file_id || params.file || '');
  if (!wanted && params.message_id === undefined) throw new ActionError('需要 message_id、file 或 file_id', RETCODE.badParam);
  const explicit = context.media?.locate(wanted) || parseMediaReference(wanted);
  if (explicit) {
    if (explicit.kind !== kind) throw new ActionError('媒体标识类型不匹配', RETCODE.badParam);
    return mediaReference(explicit.nativeId, kind, explicit.selector);
  }
  let nativeId = params.message_id === undefined ? '' : context.messageIds.resolve(params.message_id)?.nativeId || '';
  let selector = '';
  const records = context.messages.recent(500);
  const hit = records.find(item => (!nativeId || item.nativeId === nativeId) &&
    item.segments.some(segment => segment.type === kind && (!wanted ||
      [segment.data.file_id, segment.data.file, segment.data.url, segment.data.name].some(value => String(value || '') === wanted))));
  if (hit) {
    const segment = hit.segments.find(segment => segment.type === kind && (!wanted ||
      [segment.data.file_id, segment.data.file, segment.data.url, segment.data.name].some(value => String(value || '') === wanted)));
    const ref = parseMediaReference(String(segment?.data.file_id || ''));
    nativeId = hit.nativeId;
    selector = ref?.selector || '';
  }
  if (!nativeId) throw new ActionError('需要有效的 message_id、file 或 file_id', RETCODE.notFound);
  return mediaReference(nativeId, kind, selector);
}

function mediaDownloadActions(name: string, kind: MediaKind, label: string): Array<ActionDefinition<any, any>> {
  return [{
    name,
    description: '取得' + label + '的下载地址和实际字节',
    timeoutMs: kind === 'file' ? 260000 : undefined,
    requires: ['mediaDownload'],
    params: Type.Object({
      message_id: Type.Optional(MessageIdSchema),
      file: Type.Optional(Type.String()),
      file_id: Type.Optional(Type.String()),
    }),
    async handle(params: MediaParams, context: ActionContext) {
      if (!context.driver.capabilities.download[kind]) {
        throw new ActionError('运行时没有声明可下载' + label, RETCODE.unsupported);
      }
      const reference = locateMedia(params, kind, context);
      const ref = parseMediaReference(reference)!;
      if (!context.driver.fetchMedia) throw new ActionError('当前驱动不支持媒体下载', RETCODE.unsupported);
      try {
        const media = context.media
          ? await context.media.read(ref)
          : await context.driver.fetchMedia(ref.nativeId, kind, ref.selector);
        if (!media) throw new ActionError('运行时取不到该' + label, RETCODE.notFound);
        const url = context.media?.url(reference, media.name) || '';
        return {
          file: url || 'base64://' + media.base64,
          url,
          file_id: reference,
          file_name: media.name,
          name: media.name,
          file_size: media.size,
          size: media.size,
          base64: media.base64,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (detail.includes('MEDIA_NOT_READY')) throw new ActionError(detail, RETCODE.mediaNotReady);
        throw error;
      }
    },
  }];
}

/** AstrBot calls these when a file segment has no direct HTTP URL. */
function fileUrlAction(name: string): ActionDefinition<any, any> {
  return {
    name,
    description: '取得文件的 HTTP 下载地址',
    params: Type.Object({
      file_id: Type.String(),
      group_id: Type.Optional(GroupIdSchema),
      user_id: Type.Optional(UserIdSchema),
      busid: Type.Optional(Type.Number()),
    }),
    async handle(params: { file_id: string }, context: ActionContext) {
      const reference = locateMedia(params, 'file', context);
      if (!context.media) return context.call('get_file', { file_id: reference });
      const record = context.messages.recent(500).flatMap(item => item.segments)
        .find(segment => segment.type === 'file' && String(segment.data.file_id || '') === reference);
      const name = String(record?.data.file_name || record?.data.name || record?.data.file || '');
      return { url: context.media.url(reference, name || 'file'), file_id: reference, file_name: name, name };
    },
  };
}

function forwardSendAction(name: string, scene: Scene): ActionDefinition<any, any> {
  return {
    name, description: '发送合并转发（已有消息或自定义 text/image 节点）',
    params: Type.Object({
      ...(scene === 'group' ? { group_id: GroupIdSchema } : { user_id: UserIdSchema }),
      messages: Type.Array(Type.Unknown(), { minItems: 1 }),
    }),
    async handle(params: { group_id?: number; user_id?: number; messages: unknown[] }, context: ActionContext) {
      return send(scene, Number(scene === 'group' ? params.group_id : params.user_id), {
        message: [{ type: 'forward', data: { content: params.messages } }],
      }, context);
    },
  };
}

function uploadFileAction(name: string, scene: Scene): ActionDefinition<any, any> {
  return {
    name, description: '通过现有 RichMedia 发送文件',
    params: Type.Object({
      ...(scene === 'group' ? { group_id: GroupIdSchema } : { user_id: UserIdSchema }),
      file: Type.String(), name: Type.Optional(Type.String()),
    }),
    async handle(params: { group_id?: number; user_id?: number; file: string; name?: string }, context: ActionContext) {
      return send(scene, Number(scene === 'group' ? params.group_id : params.user_id), {
        message: [{ type: 'file', data: { file: params.file, name: params.name || '' } }],
      }, context);
    },
  };
}

export const messageActions: Array<ActionDefinition<any, any>> = [
  forwardSendAction('send_group_forward_msg', 'group'),
  forwardSendAction('send_private_forward_msg', 'private'),
  uploadFileAction('upload_group_file', 'group'),
  uploadFileAction('upload_private_file', 'private'),
  {
    name: 'send_private_msg',
    description: '发送私聊消息',
    requires: ['privateMessage'],
    params: Type.Object({
      user_id: UserIdSchema,
      message: MessageSchema,
      auto_escape: Type.Optional(Type.Boolean({ default: false })),
    }),
    async handle(params: SendParams & { user_id: number }, context: ActionContext) {
      return send('private', params.user_id, params, context);
    },
  },
  {
    name: 'send_group_msg',
    description: '发送群消息',
    requires: ['groupMessage'],
    params: Type.Object({
      group_id: GroupIdSchema,
      message: MessageSchema,
      auto_escape: Type.Optional(Type.Boolean({ default: false })),
    }),
    async handle(params: SendParams & { group_id: number }, context: ActionContext) {
      return send('group', params.group_id, params, context);
    },
  },
  {
    name: 'send_msg',
    description: '发送消息（按 message_type 或 id 字段推断会话）',
    requires: ['privateMessage'],
    params: Type.Object({
      message_type: Type.Optional(Type.Union([Type.Literal('private'), Type.Literal('group')])),
      user_id: Type.Optional(UserIdSchema),
      group_id: Type.Optional(GroupIdSchema),
      message: MessageSchema,
      auto_escape: Type.Optional(Type.Boolean({ default: false })),
    }),
    async handle(params: SendParams, context: ActionContext) {
      const type = params.message_type ?? (params.group_id !== undefined ? 'group' : 'private');
      if (type === 'group') {
        if (params.group_id === undefined) throw new ActionError('缺少 group_id', RETCODE.badParam);
        return send('group', params.group_id, params, context);
      }
      if (params.user_id === undefined) throw new ActionError('缺少 user_id', RETCODE.badParam);
      return send('private', params.user_id, params, context);
    },
  },
  {
    name: 'get_msg',
    description: '按 message_id 查询最近收发的消息',
    params: Type.Object({ message_id: MessageIdSchema }),
    async handle(params: { message_id: number }, context: ActionContext) {
      const record = context.messages.get(params.message_id);
      if (record) {
        return shapeMessage({
          ob11Id: record.ob11Id,
          nativeId: record.nativeId,
          scene: record.scene,
          peerId: record.peerId,
          selfId: context.selfId(),
          senderId: record.senderId,
          senderName: record.senderName,
          senderCard: record.senderCard,
          senderRole: record.senderRole,
          time: record.time,
          segments: record.segments,
          format: context.config.messagePostFormat,
        }, context);
      }

      // The message fell out of the local window; ask the runtime (contract v2)
      // before admitting we cannot answer. Legacy runtimes return null here.
      const resolved = context.messageIds.resolve(params.message_id);
      const nativeId = resolved?.nativeId;
      if (nativeId && context.driver.fetchMessage) {
        const fetched = await context.driver.fetchMessage(nativeId, resolved ? { scene: resolved.scene, peerId: resolved.peerId } : undefined);
        if (fetched) {
          const ob11Id = params.message_id;
          context.messages.save({
            nativeId: fetched.messageId, ob11Id,
            scene: fetched.scene, peerId: fetched.peer.id,
            senderId: fetched.sender.id, senderName: fetched.sender.name,
            senderCard: fetched.sender.card, senderRole: fetched.sender.role,
            time: fetched.time, self: fetched.self, segments: fetched.segments,
          });
          return shapeMessage({
            ob11Id,
            nativeId: fetched.messageId,
            scene: fetched.scene,
            peerId: fetched.peer.id,
            selfId: context.selfId(),
            senderId: fetched.sender.id,
            senderName: fetched.sender.name,
            senderCard: fetched.sender.card,
            senderRole: fetched.sender.role,
            time: fetched.time,
            segments: fetched.segments,
            format: context.config.messagePostFormat,
          }, context);
        }
      }
      throw new ActionError('消息未找到：缓存未命中，原生消息与引用回查均未取得内容', RETCODE.notFound);
    },
  },
  ...mediaDownloadActions('get_image', 'image', '图片'),
  ...mediaDownloadActions('get_record', 'record', '语音'),
  ...mediaDownloadActions('get_file', 'file', '文件'),
  ...mediaDownloadActions('get_video', 'video', '视频'),
  fileUrlAction('get_group_file_url'),
  fileUrlAction('get_private_file_url'),
  {
    name: 'get_forward_msg',
    description: '按消息 ID 展开合并转发节点',
    params: Type.Object({
      message_id: Type.Optional(Type.Union([Type.String(), MessageIdSchema])),
      // AstrBot may pass a resId as message_id rather than id.
      id: Type.Optional(Type.String()),
    }),
    async handle(params: { message_id?: number | string; id?: string }, context: ActionContext) {
      let nativeId = String(params.id ?? '');
      if (!nativeId && params.message_id !== undefined) {
        nativeId = context.messageIds.resolve(Number(params.message_id))?.nativeId || String(params.message_id);
      }
      if (!nativeId) throw new ActionError('需要 message_id 或合并转发段的 id', RETCODE.notFound);
      if (!context.driver.fetchForward) {
        throw new ActionError('当前驱动不支持展开合并转发', RETCODE.unsupported);
      }
      const nodes = await context.driver.fetchForward(nativeId);
      if (!nodes) {
        // 只有 id、运行时又不能展开：明确报错，绝不返回空节点列表冒充成功。
        throw new ActionError('运行时无法展开该合并转发（缺少原生展开能力或节点已失效）', RETCODE.notFound);
      }
      // 把 user_id 归一化成数字：OneBot 的节点里它是 number，原始节点可能给字符串。
      return {
        messages: nodes.map((node) => {
          const item = (node ?? {}) as Record<string, unknown>;
          const data = item.type === 'node' && item.data && typeof item.data === 'object'
            ? item.data as Record<string, unknown> : item;
          const sender = (data.sender || {}) as Record<string, unknown>;
          const userId = Number(data.user_id || sender.user_id || data.uin || 0);
          const nickname = String(data.nickname || sender.nickname || data.name || '');
          const source = data.message ?? data.content ?? [];
          const parsed = Array.isArray(source) && source.length === 0 ? [] : parseMessage(source as never);
          const segments = context.media?.decorate(String(data.message_id || data.msgId || nativeId), parsed) || parsed;
          return {
            ...data,
            user_id: userId,
            nickname,
            sender: { ...sender, user_id: userId, nickname },
            message: segments,
            content: segments,
          };
        }),
      };
    },
  },
  {
    name: 'delete_msg',
    description: '撤回已发送或收到的消息',
    requires: ['recall'],
    params: Type.Object({ message_id: MessageIdSchema }),
    async handle(params: { message_id: number }, context: ActionContext) {
      const resolved = context.messageIds.resolve(params.message_id);
      if (!resolved) throw new ActionError('消息 ID 不存在或已超出保留窗口', RETCODE.notFound);
      await context.driver.recall(resolved.nativeId);
      return {};
    },
  },
];
