import { Type } from '@sinclair/typebox';
import type { ActionContext, ActionDefinition } from './registry.ts';
import { GroupIdSchema } from './registry.ts';
import { ActionError, RETCODE } from '../types.ts';

/** Group roster and friend/group request handling. */
export const contactActions: Array<ActionDefinition<any, any>> = [
  {
    name: 'get_group_member_list',
    description: '获取群成员列表',
    requires: ['groupMemberList'],
    params: Type.Object({ group_id: GroupIdSchema }),
    async handle(params: { group_id: number }, context: ActionContext) {
      if (!context.driver.groupMemberList) throw new ActionError('当前驱动不提供群成员列表', RETCODE.unsupported);
      const members = await context.driver.groupMemberList(String(params.group_id));
      return members.map((member) => ({
        group_id: Number(member.groupId) || 0,
        user_id: Number(member.userId) || 0,
        nickname: member.name,
        card: member.card ?? '',
        role: member.role,
      }));
    },
  },
  {
    name: 'set_friend_add_request',
    description: '同意或拒绝好友请求',
    requires: ['requestHandle'],
    params: Type.Object({
      flag: Type.String({ minLength: 1 }),
      approve: Type.Optional(Type.Boolean({ default: true })),
      remark: Type.Optional(Type.String()),
    }),
    async handle(params: { flag: string; approve?: boolean }, context: ActionContext) {
      if (!context.driver.handleRequest) throw new ActionError('当前驱动不提供请求处理能力', RETCODE.unsupported);
      await context.driver.handleRequest({
        flag: params.flag,
        approve: params.approve !== false,
        type: 'friend',
      });
      return {};
    },
  },
  {
    name: 'set_group_add_request',
    description: '同意或拒绝加群 / 邀请请求',
    requires: ['requestHandle'],
    params: Type.Object({
      flag: Type.String({ minLength: 1 }),
      sub_type: Type.Optional(Type.Union([Type.Literal('add'), Type.Literal('invite')], { default: 'add' })),
      approve: Type.Optional(Type.Boolean({ default: true })),
      reason: Type.Optional(Type.String()),
    }),
    async handle(params: { flag: string; sub_type?: 'add' | 'invite'; approve?: boolean }, context: ActionContext) {
      if (!context.driver.handleRequest) throw new ActionError('当前驱动不提供请求处理能力', RETCODE.unsupported);
      await context.driver.handleRequest({
        flag: params.flag,
        approve: params.approve !== false,
        type: 'group',
        subType: params.sub_type ?? 'add',
      });
      return {};
    },
  },
];
