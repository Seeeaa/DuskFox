import { Type } from '@sinclair/typebox';
import type { ActionDefinition, ActionContext } from './registry.ts';
import { GroupIdSchema, UserIdSchema } from './registry.ts';
import { ActionError, RETCODE } from '../types.ts';

/** Account and capability introspection. */
export const systemActions: Array<ActionDefinition<any, any>> = [
  {
    name: 'get_login_info',
    description: '获取当前登录账号的 QQ 号与昵称',
    requires: ['privateMessage'],
    async handle(_params: unknown, context: ActionContext) {
      const status = await context.driver.status();
      if (!status.online) throw new ActionError('账号未登录', RETCODE.notFound);
      return { user_id: Number(status.uin) || 0, nickname: status.nick };
    },
  },
  {
    name: 'get_status',
    description: '获取实例在线状态与统计',
    async handle(_params: unknown, context: ActionContext) {
      const status = await context.driver.status();
      const snapshot = context.stats.snapshot(0);
      return {
        online: status.online,
        good: status.online,
        stat: {
          packet_received: snapshot.rx,
          packet_sent: snapshot.tx,
          message_received: snapshot.rx,
          message_sent: snapshot.tx,
        },
      };
    },
  },
  {
    name: 'get_version_info',
    description: '获取实现版本信息',
    async handle(_params: unknown, context: ActionContext) {
      return {
        app_name: 'duskfox',
        app_version: context.version,
        protocol_version: 'v11',
        extra: { driver: context.driver.id, runtime: process.version },
      };
    },
  },
  {
    name: 'can_send_image',
    description: '是否支持发送图片',
    async handle(_params: unknown, context: ActionContext) {
      return { yes: context.driver.capabilities.mediaImage };
    },
  },
  {
    name: 'can_send_record',
    description: '是否支持发送语音',
    async handle(_params: unknown, context: ActionContext) {
      return { yes: context.driver.capabilities.mediaRecord };
    },
  },
  {
    name: 'get_friend_list',
    description: '获取好友列表',
    requires: ['friendList'],
    async handle(_params: unknown, context: ActionContext) {
      const friends = await context.driver.friendList();
      return friends.map((friend) => ({
        user_id: Number(friend.id) || 0,
        nickname: friend.name,
        remark: friend.remark ?? friend.name,
      }));
    },
  },
  {
    name: 'get_group_list',
    description: '获取群列表',
    requires: ['groupList'],
    async handle(_params: unknown, context: ActionContext) {
      const groups = await context.driver.groupList();
      return groups.map((group) => ({
        group_id: Number(group.id) || 0,
        group_name: group.name,
        member_count: group.memberCount ?? 0,
        max_member_count: group.maxMemberCount ?? 0,
      }));
    },
  },
  {
    name: 'get_stranger_info',
    description: '获取陌生人信息',
    requires: ['strangerInfo'],
    params: Type.Object({ user_id: UserIdSchema, no_cache: Type.Optional(Type.Boolean({ default: false })) }),
    async handle(params: { user_id: number }, context: ActionContext) {
      const info = await context.driver.strangerInfo(String(params.user_id));
      return {
        user_id: Number(info.id) || 0,
        nickname: info.name,
        sex: info.sex ?? 'unknown',
        age: info.age ?? 0,
      };
    },
  },
  {
    name: 'get_group_member_info',
    description: '获取群成员信息',
    requires: ['groupMemberInfo'],
    params: Type.Object({
      group_id: GroupIdSchema,
      user_id: UserIdSchema,
      no_cache: Type.Optional(Type.Boolean({ default: false })),
    }),
    async handle(params: { group_id: number; user_id: number }, context: ActionContext) {
      const member = await context.driver.groupMemberInfo(String(params.group_id), String(params.user_id));
      return {
        group_id: Number(member.groupId) || 0,
        user_id: Number(member.userId) || 0,
        nickname: member.name,
        card: member.card ?? '',
        role: member.role,
      };
    },
  },
];
