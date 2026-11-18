import { Type } from '@sinclair/typebox';
import type { ActionContext, ActionDefinition } from './registry.ts';
import { GroupIdSchema, MessageIdSchema, MessageSchema, UserIdSchema } from './registry.ts';
import { ActionError, RETCODE } from '../types.ts';
import { formatMessage, parseMessage, toCqString } from '../segments.ts';
import type { OutboundMessage, Scene, Segment } from '../../core/model.ts';

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
function shapeMessage(input: MessageShape): Record<string, unknown> {
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
    message: formatMessage(input.segments, input.format),
    raw_message: toCqString(input.segments),
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
    return [{ type: 'text', text: params.message }];
  }
  return parseMessage(params.message as never);
}

function replyTarget(segments: readonly Segment[]): string | undefined {
  for (const segment of segments) {
    if (segment.type === 'reply') return segment.id;
  }
  return undefined;
}

/** 引用段的 id 由机器人按 OneBot 数字 id 传回；驱动层要的是原生 msgId。 */
function withNativeReplyIds(segments: readonly Segment[], context: ActionContext): Segment[] {
  return segments.map((segment) => {
    if (segment.type !== 'reply') return segment;
    const nativeId = context.messageIds.nativeIdOf(Number(segment.id));
    return nativeId ? { ...segment, id: nativeId } : segment;
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
  const result = await context.driver.sendMessage(outbound);
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
  const needs: Array<[Segment['type'], keyof typeof context.driver.capabilities, string]> = [
    ['image', 'mediaImage', '图片'],
    ['record', 'mediaRecord', '语音'],
    ['video', 'mediaVideo', '视频'],
    ['file', 'mediaFile', '文件'],
    ['at', 'at', '@ 提及'],
    ['face', 'face', '表情'],
    ['forward', 'forward', '合并转发'],
    ['json', 'json', 'JSON 卡片'],
    ['markdown', 'markdown', 'Markdown'],
  ];
  for (const [type, capability, label] of needs) {
    if (segments.some((segment) => segment.type === type) && !context.driver.capabilities[capability]) {
      return new ActionError(`当前驱动不支持${label}消息段`, RETCODE.unsupported);
    }
  }
  return null;
}

/**
 * 取回媒体字节的动作：get_image / get_record / get_file / get_video 共用一套定位与错误语义。
 * 下载是独立方向：媒体类型没在 download 里声明就直接 1200，不假装能给。
 */
function mediaDownloadActions(
  name: string,
  kind: 'image' | 'record' | 'file' | 'video',
  label: string,
): Array<ActionDefinition<any, any>> {
  return [
    {
      name,
      description: `取${label}消息的字节数据（base64）`,
      requires: ['mediaDownload'],
      params: Type.Object({
        message_id: Type.Optional(MessageIdSchema),
        // OneBot 规范用消息段的 file 定位；我们只能在自己的最近窗口里反查。
        file: Type.Optional(Type.String()),
      }),
      async handle(params: { message_id?: number; file?: string }, context: ActionContext) {
        if (!context.driver.capabilities.download[kind]) {
          throw new ActionError(`运行时没有声明可下载${label}`, RETCODE.unsupported);
        }
        let nativeId = '';
        if (params.message_id !== undefined) {
          nativeId = context.messageIds.resolve(params.message_id)?.nativeId ?? '';
        }
        const wanted = String(params.file ?? '');
        if (!nativeId && wanted) {
          const hit = context.messages
            .recent(500)
            .find((item) => item.segments.some((segment) => segment.type === kind && segment.file === wanted));
          nativeId = hit?.nativeId ?? '';
        }
        if (!nativeId) {
          throw new ActionError(`需要 message_id，或一个仍在保留窗口内的${label} file`, RETCODE.notFound);
        }
        if (!context.driver.fetchMedia) throw new ActionError('当前驱动不支持媒体下载', RETCODE.unsupported);
        try {
          const media = await context.driver.fetchMedia(nativeId, kind);
          if (!media) {
            throw new ActionError(`运行时取不到该${label}：消息可能在本地窗口之外`, RETCODE.notFound);
          }
          return { file: 'base64://' + media.base64, file_name: media.name, file_size: media.size };
        } catch (error) {
          // 字节还没落盘是可重试状态，用专用 retcode 和"消息不存在"区分开。
          const detail = error instanceof Error ? error.message : String(error);
          if (detail.includes('MEDIA_NOT_READY')) {
            throw new ActionError(`运行时还没有把该${label}落到本地，请稍后重试（跨容器时只能用本动作取字节）`, RETCODE.mediaNotReady);
          }
          throw error;
        }
      },
    },
  ];
}

export const messageActions: Array<ActionDefinition<any, any>> = [
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
        });
      }

      // The message fell out of the local window; ask the runtime (contract v2)
      // before admitting we cannot answer. Legacy runtimes return null here.
      const nativeId = context.messageIds.nativeIdOf(params.message_id);
      if (nativeId && context.driver.fetchMessage) {
        const fetched = await context.driver.fetchMessage(nativeId);
        if (fetched) {
          const ob11Id = context.messageIds.register(fetched.messageId, fetched.scene, fetched.peer.id);
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
          });
        }
      }
      throw new ActionError('消息不存在：本地窗口（最近 500 条）已淘汰，且运行时无法按该 ID 查询', RETCODE.notFound);
    },
  },
  ...mediaDownloadActions('get_image', 'image', '图片'),
  ...mediaDownloadActions('get_record', 'record', '语音'),
  ...mediaDownloadActions('get_file', 'file', '文件'),
  ...mediaDownloadActions('get_video', 'video', '视频'),
  {
    name: 'get_forward_msg',
    description: '按消息 ID 展开合并转发节点',
    requires: ['mediaDownload'],
    params: Type.Object({
      message_id: Type.Optional(MessageIdSchema),
      // 也允许直接用合并转发段的 id（部分框架就是这么调的）。
      id: Type.Optional(Type.String()),
    }),
    async handle(params: { message_id?: number; id?: string }, context: ActionContext) {
      let nativeId = String(params.id ?? '');
      if (!nativeId && params.message_id !== undefined) {
        nativeId = context.messageIds.resolve(params.message_id)?.nativeId ?? '';
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
          return { ...item, user_id: Number(item.user_id ?? 0) || 0 };
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
