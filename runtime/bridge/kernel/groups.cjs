'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */
const { withTimeout, peerKey } = require('./shared.cjs');

class GroupsDomain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** 归一化 onGroupListUpdate 的各种回调形态，并记录原始签名供排障。 */
  captureGroupListUpdate(args) {
    const candidates = [];
    const shape = [];
    for (const arg of args) {
      if (!arg) {
        shape.push(typeof arg);
        continue;
      }
      if (Array.isArray(arg)) {
        shape.push('array(' + arg.length + ')');
        candidates.push(arg);
        continue;
      }
      if (typeof arg === 'object') {
        shape.push('{' + Object.keys(arg).slice(0, 12).join(',') + '}');
        const nested = [arg.groupList, arg.data, arg.result];
        if (arg.data && typeof arg.data === 'object') nested.push(arg.data.groupList);
        if (arg.result && typeof arg.result === 'object') nested.push(arg.result.groupList);
        for (const value of nested) {
          if (Array.isArray(value)) candidates.push(value);
        }
        continue;
      }
      shape.push(typeof arg + ':' + String(arg).slice(0, 40));
    }
    const list = candidates.find((item) => item.length > 0) || candidates[0] || null;
    this.ctx.state.probe.groupListUpdate = { shape, count: list ? list.length : -1, at: Date.now() };
    if (list && list.length > 0) {
      this.ctx.state.groupListCache = list;
    } else if (list === null && !this.ctx.state.groupListCache) {
      this.ctx.state.probe.groupListEmpty = true;
    }
    // 内核会反复推同一个列表，只在数量变化时记一行，别把日志刷满。
    if (this.ctx.state.probe.groupListLoggedCount !== (list ? list.length : -1)) {
      this.ctx.state.probe.groupListLoggedCount = list ? list.length : -1;
      console.log('[bridge] onGroupListUpdate', JSON.stringify(shape), 'count=', list ? list.length : -1);
    }
  }

  /** 从 getGroupList 的返回里挑出群数组。 */
  pickGroupArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return null;
    const nested = [value.groupList, value.data, value.result];
    if (value.data && typeof value.data === 'object') nested.push(value.data.groupList);
    if (value.result && typeof value.result === 'object') nested.push(value.result.groupList);
    for (const candidate of nested) {
      if (Array.isArray(candidate)) return candidate;
    }
    return null;
  }

  /** 把返回值压成一行摘要，写进错误信息便于远程排障。 */
  summarizeGroupValue(value) {
    if (Array.isArray(value)) return 'array(' + value.length + ')';
    if (!value) return String(value);
    if (typeof value === 'object') return '{' + Object.keys(value).slice(0, 12).join(',') + '}';
    return typeof value + ':' + String(value).slice(0, 60);
  }

  /**
     * 群消息到达时后台补一次成员表，把 uid -> uin 映射填满。
     * @ 段的 qq 必须是数字 QQ 号；没有这层预热，新群里第一次 @ 会退化成 uid，框架直接解析失败。
     */
  warmGroupMembers(groupId) {
    if (!groupId || typeof this.groupMembers !== 'function') return;
    const key = String(groupId);
    const last = this.ctx.state.memberWarmAt.get(key) || 0;
    if (Date.now() - last < 60_000) return;
    this.ctx.state.memberWarmAt.set(key, Date.now());
    Promise.resolve()
      .then(() => this.groupMembers(key))
      .catch((error) => { this.ctx.state.probe.memberWarmError = String(error && error.message ? error.message : error); });
  }

  /** 群号 -> 群名（来自 onGroupListUpdate 缓存），消息事件里补 group_name 用。 */
  groupNameOf(groupId) {
    const code = String(groupId ?? '');
    if (!code) return '';
    for (const item of Array.isArray(this.ctx.state.groupListCache) ? this.ctx.state.groupListCache : []) {
      if (String(item && item.groupCode) === code) return String(item.groupName || '');
    }
    return '';
  }

  /** 群号+QQ号 -> 成员角色（owner/admin/member），消息事件 sender.role 用。 */
  memberRoleOf(groupId, uin) {
    const key = String(groupId ?? '');
    const target = String(uin ?? '');
    if (!key || !target) return '';
    const entry = this.ctx.state.memberListCache.get(key);
    const hit = (entry && Array.isArray(entry.list) ? entry.list : []).find((item) => String(item && item.uin) === target);
    if (!hit) return '';
    return hit.role === 4 ? 'owner' : hit.role === 3 ? 'admin' : 'member';
  }

  /** 收到群消息时把成员表准备好（60 秒缓存），保证 @ 能映射成数字 QQ 号。 */
  async warmGroup(message) {
    const chatType = Number(message?.chatType);
    const peerUid = String(message?.peerUid ?? '');
    if (chatType !== 2 || !/^\d{5,}$/.test(peerUid)) return;
    await this.groupMembers(peerUid);
  }

  /** 记住一个群成员的 uid/昵称，后续 @ 直接用。 */
  cacheMember(key, info) {
    if (!info) return;
    const uid = String(info.uid ?? '');
    const uin = String(info.uin ?? '');
    const nick = String(info.cardName || info.nick || '');
    if (uid && uin) this.ctx.state.uinByUid.set(uid, uin);
    if (uin && nick) this.ctx.state.nickByUin.set(uin, nick);
    if (uid && key) this.ctx.state.uidByGroupKey.set(key, uid);
  }

  async groups() {
    const session = this.ctx.state.session || this.ctx.kernel.requireSession();
    this.ctx.kernel.attachRequestListeners(session);
    const groupService = session.getGroupService();
    const returns = [];
    // 直接返回值在不同客户端版本里可能是 void / 数组 / { groupList }：逐个试并留证据。
    for (const args of [[false], [true], []]) {
      try {
        const value = await groupService.getGroupList(...args);
        returns.push(this.summarizeGroupValue(value));
        const direct = this.pickGroupArray(value);
        if (direct && direct.length > 0) this.ctx.state.groupListCache = direct;
      } catch (error) {
        returns.push('throw:' + String(error?.message || error?.name || error).slice(0, 80));
      }
    }
    if (!this.ctx.state.probe.groupListReturnsLogged) {
      this.ctx.state.probe.groupListReturnsLogged = true;
      console.log('[bridge] getGroupList returns', JSON.stringify(returns));
    }
    let list = Array.isArray(this.ctx.state.groupListCache) && this.ctx.state.groupListCache.length > 0 ? this.ctx.state.groupListCache : null;
    // 群列表在登录后由内核异步推送：等到非空或超时（冷启动时可能落后十几秒）。
    let deadline = Date.now() + 4000;
    while (!list && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (Array.isArray(this.ctx.state.groupListCache) && this.ctx.state.groupListCache.length > 0) list = this.ctx.state.groupListCache;
    }
    if (!list && this.ctx.state.groupsSeen && this.ctx.state.groupsSeen.size > 0) {
      // 内核一直不推列表时，退化成“从实际群消息里见过的群”，至少保证控制台可用。
      list = [...this.ctx.state.groupsSeen.keys()].map((code) => ({ groupCode: code, groupName: this.ctx.state.groupsSeen.get(code) || '', memberCount: 0, maxMemberCount: 0 }));
      console.log('[bridge] getGroupList fallback groupsSeen=', list.length);
    }
    if (!Array.isArray(list)) {
      const detail = JSON.stringify({
        update: this.ctx.state.probe.groupListUpdate ?? null,
        returns,
        error: this.ctx.state.probe.lastGroupListenerError ?? null,
      });
      console.log('[bridge] groups probe', detail.slice(0, 400));
      throw new Error('群列表尚未就绪：' + detail.slice(0, 700));
    }
    return list.map((item) => ({
      group_id: Number(item.groupCode || 0),
      group_name: String(item.groupName || ''),
      member_count: Number(item.memberCount || 0),
      max_member_count: Number(item.maxMemberCount || 0),
    }));
  }

  /** getAllMemberList 的返回结构在不同版本里是数组 / { infos } / 嵌套 result，这里统一成数组。 */
  memberArrayOf(value, depth = 0) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object' || depth > 3) return null;
    const direct = [value.infos, value.memberList, value.members, value.memberInfos, value.list];
    for (const candidate of direct) {
      if (Array.isArray(candidate)) return candidate;
    }
    const nested = [value.result, value.data, value.payload];
    for (const candidate of nested) {
      const found = this.memberArrayOf(candidate, depth + 1);
      if (found) return found;
    }
    // 兜底：uin -> 成员对象 的字典。
    const values = Object.values(value);
    if (values.length > 0 && values.every((item) => item && typeof item === 'object' && (item.uin != null || item.uid != null))) {
      return values;
    }
    return null;
  }

  async rawMemberArray(groupId) {
    const cacheKey = String(groupId);
    const cached = this.ctx.state.memberListCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 60_000) return cached.list;
    const session = this.ctx.state.session || this.ctx.kernel.requireSession();
    const result = await withTimeout(session.getGroupService().getAllMemberList(String(groupId), false), 8000, 'getAllMemberList');
    const core = result && typeof result === 'object' ? (result.result ?? result) : result;
    const infos = core && typeof core === 'object' ? core.infos : null;
    const ids = core && typeof core === 'object' ? core.ids : null;
    console.log('[bridge] getAllMemberList shape', JSON.stringify({
      type: Object.prototype.toString.call(infos),
      ids: Array.isArray(ids) ? ids.length : typeof ids,
      infosSize: infos instanceof Map ? infos.size : infos && typeof infos === 'object' ? Object.keys(infos).length : typeof infos,
      sample: infos instanceof Map ? [...infos.keys()].slice(0, 2) : infos && typeof infos === 'object' ? Object.keys(infos).slice(0, 2) : String(infos).slice(0, 30),
    }).slice(0, 300));
    let list = this.memberArrayOf(result);
    if (!list && infos instanceof Map) list = [...infos.values()];
    if (!list && infos && typeof infos === 'object') {
      const values = Object.values(infos).filter((item) => item && typeof item === 'object');
      if (values.length > 0) list = values;
    }
    if (!list && Array.isArray(ids) && infos && typeof infos === 'object') {
      list = ids.map((id) => infos[id]).filter((item) => item && typeof item === 'object');
    }
    if (!Array.isArray(list) || list.length === 0) {
      const shape = JSON.stringify({
        keys: result && typeof result === 'object' ? Object.keys(result).slice(0, 10) : String(result).slice(0, 40),
        coreKeys: core && typeof core === 'object' ? Object.keys(core).slice(0, 10) : String(core).slice(0, 40),
      }).slice(0, 300);
      console.log('[bridge] getAllMemberList unknown shape', shape);
      throw new Error('群成员列表返回结构未知：' + shape);
    }
    this.ctx.state.memberListCache.set(cacheKey, { at: Date.now(), list });
    while (this.ctx.state.memberListCache.size > 32) {
      const oldest = this.ctx.state.memberListCache.keys().next();
      if (oldest.done) break;
      this.ctx.state.memberListCache.delete(oldest.value);
    }
    return list;
  }

  /** 原生成员对象 -> OneBot 成员视图。内核给的是 uid 键的 Map，uin 可能在对象里也可能不在。 */
  memberView(groupId, item) {
    const uid = String(item.uid || '');
    const uin = String(item.uin ?? item.memberUin ?? item.userUin ?? this.ctx.state.uinByUid.get(uid) ?? '');
    if (uin) this.cacheMember(peerKey(groupId, uin), item);
    return {
      group_id: Number(groupId),
      user_id: Number(uin || 0),
      nickname: String(item.nick || item.memberName || item.cardName || this.ctx.kernel.nickOfUin(uin) || ''),
      card: String(item.cardName || item.card || ''),
      role: item.role === 4 ? 'owner' : item.role === 3 ? 'admin' : 'member',
      uid,
    };
  }

  async groupMember(groupId, userId) {
    const infos = await this.rawMemberArray(groupId);
    const target = String(userId);
    let hit = infos.find((item) => String(item.uin ?? item.memberUin ?? item.userUin ?? '') === target);
    if (!hit) {
      // 调用方也可能给 uid（AstrBot 一般给 QQ 号）。
      hit = infos.find((item) => String(item.uid ?? '') === target);
    }
    if (!hit) {
      const uid = await this.ctx.kernel.resolveUid(target).catch(() => '');
      if (uid) hit = infos.find((item) => String(item.uid ?? '') === String(uid));
    }
    if (!hit) {
      console.log('[bridge] groupMember miss', target, infos[0] ? JSON.stringify(Object.keys(infos[0]).slice(0, 14)) : 'empty');
      throw new Error('群成员不存在');
    }
    return this.memberView(groupId, hit);
  }

  async groupMembers(groupId) {
    const infos = await this.rawMemberArray(groupId);
    return infos.map((item) => this.memberView(groupId, item));
  }
}

module.exports = { GroupsDomain };
