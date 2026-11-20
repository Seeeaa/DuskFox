'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */
const { GROUP_NOTIFY_INVITED_BY_MEMBER, GROUP_NOTIFY_KUNHANDLE, GROUP_NOTIFY_SKIP } = require('./shared.cjs');

class RequestsDomain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /**
     * 好友/加群请求的监听与缓存。
     *
     * 字段契约（按 NapCat 的 NodeIKernelBuddyListener / NodeIKernelGroupListener）：
     *  - 好友：onBuddyReqChange({ unreadNums, buddyReqs: FriendRequest[] })；
     *    FriendRequest 里只有 friendUid（**字母数字 uid**）和 extWords，没有任何 QQ 号字段；
     *  - 群：onGroupNotifiesUpdated(doubt, GroupNotify[])；
     *    申请人/邀请人也只有 user1.uid / user2.uid，没有 uin 字段。
     * 所以这里的核心工作是把 uid 换成 QQ 号；换不到就保持 user_id=0 并保留 uid，
     * 由服务端显式标注"未解析"，绝不能把字母数字 uid 交给 Number() 变成 0 号。
     * 【待实机验证】回调形状与 resolveUin 的回退链。
     */
  attachRequestListeners(session) {
    // 好友与群监听分开注册：任一失败不拖累另一个（此前一次抛错会让群监听永远缺失）。
    if (!this.ctx.state.buddyListenerReady) {
      try {
        session.getBuddyService().addKernelBuddyListener({
          onBuddyReqChange: (data) => {
            if (this.ctx.state.session !== session || !this.ctx.kernel.online) return;
            void this.handleBuddyRequests(data).catch((error) => {
              this.ctx.state.probe.lastBuddyRequestError = String(error?.message || error);
            });
          },
        });
        this.ctx.state.buddyListenerReady = true;
      } catch (error) {
        this.ctx.state.probe.lastBuddyListenerError = String(error?.message || error?.name || error);
      }
    }
    if (!this.ctx.state.groupListenerReady) {
      try {
        session.getGroupService().addKernelGroupListener({
          // 不同版本回调签名不同：可能是 (list)、({ groupList }) 或 (isRefresh, list)。
          onGroupListUpdate: (...args) => {
            if (this.ctx.state.session === session && this.ctx.kernel.online) this.ctx.kernel.captureGroupListUpdate(args);
          },
          onGroupNotifiesUpdated: (_doubt, notifications) => {
            if (this.ctx.state.session !== session || !this.ctx.kernel.online) return;
            void this.handleGroupNotifies(notifications).catch((error) => {
              this.ctx.state.probe.lastGroupNotifyError = String(error?.message || error);
            });
          },
        });
        this.ctx.state.groupListenerReady = true;
      } catch (error) {
        this.ctx.state.probe.lastGroupListenerError = String(error?.message || error?.name || error);
      }
    }
  }

  /** 好友申请：信封是 { unreadNums, buddyReqs }，只报未读、未处理、非自己发起的那几条。 */
  async handleBuddyRequests(data) {
    // 【待实机验证】信封字段名：真机是 buddyReqs，RequestList/requestList 只作旧版兼容。
    const list = (data && (data.buddyReqs || data.RequestList || data.requestList)) || [];
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || !item.friendUid) continue;
      // 与 NapCat 同口径：自己发起、已处理、已读过的请求不再上报，避免每次连上都刷一遍。
      if (item.isInitiator === true) continue;
      if (item.isDecide === true) continue;
      if (item.isUnread === false) continue;
      const uid = String(item.friendUid);
      const uin = await this.ctx.kernel.resolveUin(uid);
      const flag = 'friend|' + uid + '|' + (item.reqTime || '');
      this.ctx.state.friendRequests.set(flag, { friendUid: uid, reqTime: String(item.reqTime || '') });
      this.ctx.state.emit({
        type: 'request',
        request: {
          kind: 'friend',
          time: Number(item.reqTime) || Math.floor(Date.now() / 1000),
          scene: 'private',
          peer: { id: uin || uid },
          // id 是 QQ 号（拿不到就给空串），uid 始终带着；服务端据此决定 user_id 与是否标注未解析。
          user: { id: uin, uid },
          comment: String(item.extWords || item.msg || item.comment || ''),
          flag,
        },
      });
    }
  }

  /** 群通知：按 GroupNotifyMsgType + status 判定 add / invite，其余类型直接忽略。 */
  async handleGroupNotifies(notifications) {
    const list = Array.isArray(notifications) ? notifications : [];
    for (const item of list) {
      if (!item || !item.seq) continue;
      // 只有"未处理"的通知是待办请求；已同意/已拒绝的不能再报一次。
      if (Number(item.status) !== GROUP_NOTIFY_KUNHANDLE) continue;
      const type = Number(item.type);
      if (GROUP_NOTIFY_SKIP.includes(type)) continue;
      // type=1 是"群成员邀请我入群"，操作者是 user2；type=5/7 的申请人是 user1。
      const subType = type === GROUP_NOTIFY_INVITED_BY_MEMBER ? 'invite' : 'add';
      const target = (subType === 'invite' ? item.user2 : item.user1) || {};
      const uid = String(target.uid || '');
      const uin = uid ? await this.ctx.kernel.resolveUin(uid) : '';
      const flag = 'group|' + item.seq + '|' + item.type + '|' + ((item.group && item.group.groupCode) || '');
      this.ctx.state.groupNotices.set(flag, item);
      this.ctx.state.emit({
        type: 'request',
        request: {
          kind: 'group',
          time: Math.floor(Date.now() / 1000),
          scene: 'group',
          peer: { id: String((item.group && item.group.groupCode) || '') },
          user: { id: uin, uid },
          comment: String(item.postscript || ''),
          flag,
          detail: { sub_type: subType },
        },
      });
    }
  }

  async handleRequest(input) {
    const session = this.ctx.state.session || this.ctx.kernel.requireSession();
    if (input.type === 'friend') {
      const hit = this.ctx.state.friendRequests.get(input.flag);
      if (!hit) throw new Error('好友请求已失效（运行时未缓存该 flag）');
      // 【待实机验证】accept 期望 boolean。
      await session.getBuddyService().approvalFriendRequest({
        friendUid: hit.friendUid,
        reqTime: hit.reqTime,
        accept: Boolean(input.approve),
      });
      this.ctx.state.friendRequests.delete(input.flag);
      return true;
    }
    const notice = this.ctx.state.groupNotices.get(input.flag);
    if (!notice) throw new Error('加群请求已失效（运行时未缓存该 flag）');
    // 【待实机验证】operateSysNotify 的 operateType 取值。
    const operateType = input.approve ? 1 : 2;
    await session.getGroupService().operateSysNotify(Boolean(notice.doubt), {
      operateType,
      targetMsg: {
        seq: notice.seq,
        type: notice.type,
        groupCode: notice.group && notice.group.groupCode,
        postscript: ' ',
      },
    });
    this.ctx.state.groupNotices.delete(input.flag);
    return true;
  }
}

module.exports = { RequestsDomain };
