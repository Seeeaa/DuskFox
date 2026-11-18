import type { AccountNotice, AccountRequest, InboundMessage } from '../core/model.ts';
import type { MessageIdRegistry } from '../core/message-id.ts';
import type { OnebotConfig } from '../core/config.ts';
import { formatMessage, toCqString } from './segments.ts';
import type { Ob11EventBase, Ob11Status } from './types.ts';

export interface EventContext {
  /** Numeric QQ id, 0 while the account is offline. */
  readonly selfId: () => number;
  readonly config: () => OnebotConfig;
  readonly messageIds: MessageIdRegistry;
}

function base(ctx: EventContext, postType: Ob11EventBase['post_type'], extra: Record<string, unknown>): Ob11EventBase {
  return { time: Math.floor(Date.now() / 1000), self_id: ctx.selfId(), post_type: postType, ...extra };
}

/**
 * Build `message` or `message_sent` events from an inbound driver message.
 *
 * OneBot defines `message_sent` for messages this account sent itself; NapCat
 * uses the same split, so frameworks that toggle `report_self_message` get the
 * event type they expect instead of a normal `message` with a self sender.
 */
export function buildMessageEvent(message: InboundMessage, ctx: EventContext): Ob11EventBase {
  const config = ctx.config();
  const format = config.messagePostFormat;
  const numericId = ctx.messageIds.register(message.messageId, message.scene, message.peer.id);
  const sender = {
    user_id: Number(message.sender.id) || 0,
    nickname: message.sender.name ?? '',
    ...(message.sender.card ? { card: message.sender.card } : {}),
    ...(message.sender.role ? { role: message.sender.role } : {}),
  };
  // 引用段的 id 来自桥接的原生 msgId；对外必须换成 OneBot 侧的数字 id，
  // 否则机器人拿到的 reply id 和 message_id 对不上，回引会失败。
  const segments = message.segments.map((segment) =>
    segment.type === 'reply'
      ? { ...segment, id: String(ctx.messageIds.register(segment.id, message.scene, message.peer.id)) }
      : segment,
  );
  const common = {
    message_id: numericId,
    message: formatMessage(segments, format),
    raw_message: toCqString(segments),
    font: 0,
    sender,
    ...(config.debug && message.raw !== undefined ? { raw: message.raw } : {}),
  };
  const postType = message.self ? 'message_sent' : 'message';
  if (message.scene === 'group') {
    return base(ctx, postType, {
      message_type: 'group',
      sub_type: 'normal',
      group_id: Number(message.peer.id) || 0,
      ...common,
    });
  }
  return base(ctx, postType, {
    message_type: 'private',
    sub_type: 'friend',
    user_id: Number(message.peer.id) || 0,
    ...common,
  });
}

/** Notice event, or a lifecycle meta event for session transitions. */
export function buildNoticeEvent(notice: AccountNotice, ctx: EventContext): Ob11EventBase | null {
  const groupId = Number(notice.peer.id) || 0;
  const userId = Number(notice.user.id) || 0;
  switch (notice.kind) {
    case 'friend_recall':
      return base(ctx, 'notice', {
        notice_type: 'friend_recall',
        user_id: userId,
        message_id: Number(notice.detail?.message_id ?? 0),
      });
    case 'group_recall':
      return base(ctx, 'notice', {
        notice_type: 'group_recall',
        group_id: groupId,
        user_id: userId,
        operator_id: Number(notice.detail?.operator_id ?? userId),
        message_id: Number(notice.detail?.message_id ?? 0),
      });
    case 'group_increase':
      return base(ctx, 'notice', {
        notice_type: 'group_increase',
        sub_type: String(notice.detail?.sub_type ?? 'approve'),
        group_id: groupId,
        operator_id: Number(notice.detail?.operator_id ?? 0),
        user_id: userId,
      });
    case 'group_decrease':
      return base(ctx, 'notice', {
        notice_type: 'group_decrease',
        sub_type: String(notice.detail?.sub_type ?? 'leave'),
        group_id: groupId,
        operator_id: Number(notice.detail?.operator_id ?? 0),
        user_id: userId,
      });
    case 'group_admin':
      return base(ctx, 'notice', {
        notice_type: 'group_admin',
        sub_type: String(notice.detail?.sub_type ?? 'set'),
        group_id: groupId,
        user_id: userId,
      });
    case 'group_ban':
      return base(ctx, 'notice', {
        notice_type: 'group_ban',
        sub_type: String(notice.detail?.sub_type ?? 'ban'),
        group_id: groupId,
        operator_id: Number(notice.detail?.operator_id ?? 0),
        user_id: userId,
        duration: Number(notice.detail?.duration ?? 0),
      });
    case 'group_upload':
      return base(ctx, 'notice', {
        notice_type: 'group_upload',
        group_id: groupId,
        user_id: userId,
        file: {
          id: String(notice.detail?.file_id ?? ''),
          name: String(notice.detail?.file_name ?? ''),
          size: Number(notice.detail?.file_size ?? 0),
          busid: Number(notice.detail?.busid ?? 0),
        },
      });
    default:
      return null;
  }
}

export function buildRequestEvent(request: AccountRequest, ctx: EventContext): Ob11EventBase {
  if (request.kind === 'friend') {
    return base(ctx, 'request', {
      request_type: 'friend',
      user_id: Number(request.user.id) || 0,
      comment: request.comment,
      flag: request.flag,
    });
  }
  return base(ctx, 'request', {
    request_type: 'group',
    sub_type: String(request.detail?.sub_type ?? 'add'),
    group_id: Number(request.peer.id) || 0,
    user_id: Number(request.user.id) || 0,
    comment: request.comment,
    flag: request.flag,
  });
}

export function buildLifecycleEvent(
  subtype: 'connect' | 'enable' | 'disable',
  ctx: EventContext,
  status: Ob11Status,
): Ob11EventBase {
  return base(ctx, 'meta_event', {
    meta_event_type: 'lifecycle',
    sub_type: subtype,
    status,
  });
}

export function buildHeartbeatEvent(ctx: EventContext, status: Ob11Status, interval: number): Ob11EventBase {
  return base(ctx, 'meta_event', {
    meta_event_type: 'heartbeat',
    status,
    interval,
  });
}
