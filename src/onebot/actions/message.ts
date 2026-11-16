import { Type } from '@sinclair/typebox';
import type { ActionContext, ActionDefinition } from './registry.ts';
import { GroupIdSchema, MessageIdSchema, MessageSchema, UserIdSchema } from './registry.ts';
import { ActionError, RETCODE } from '../types.ts';
import { parseMessage } from '../segments.ts';
import type { OutboundMessage, Scene, Segment } from '../../core/model.ts';

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

async function send(scene: Scene, peerId: number, params: SendParams, context: ActionContext): Promise<{ message_id: number }> {
  const segments = segmentsFrom(params);
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
  context.stats.incMessagesOut();
  const numericId = context.messageIds.register(result.messageId, scene, String(peerId));
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
