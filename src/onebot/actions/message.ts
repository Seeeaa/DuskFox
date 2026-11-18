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
