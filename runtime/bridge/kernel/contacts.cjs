'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */
const { withTimeout, peerKey } = require('./shared.cjs');

class ContactsDomain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /**
     * uid -> QQ 号。好友申请与群通知只给字母数字 uid，OneBot 的 user_id 必须是 QQ 号。
     * 回退链与 NapCat 的 getUinByUidV2 对齐：UixConvert → Profile(FriendsServiceImpl) → Group。
     * 三步都失败就返回空串，由上游按 user_id=0 + uid 上报——不冒充 0 号。
     * 【待实机验证】getUixConvertService / getProfileService.getUinByUid / getGroupService.getUinByUids 的返回形状。
     */
  async resolveUin(uid) {
    const key = String(uid || '');
    if (!key) return '';
    const cached = this.uinOfUid(key);
    if (cached) return cached;
    const session = this.ctx.state.session;
    if (!session) return '';
    const attempt = async (run) => {
      try {
        return String((await withTimeout(Promise.resolve(run()), 3000, 'resolveUin')) || '');
      } catch (error) {
        return '';
      }
    };
    const asUin = (value) => {
      const text = String(value ?? '');
      return /^\d{5,12}$/.test(text) ? text : '';
    };
    let uin = '';
    if (typeof session.getUixConvertService === 'function') {
      uin = asUin(await attempt(async () => {
        const data = await session.getUixConvertService().getUin([key]);
        const map = data && data.uinInfo;
        return map && typeof map.get === 'function' ? map.get(key) : '';
      }));
    }
    if (!uin && typeof session.getProfileService === 'function') {
      uin = asUin(await attempt(() => {
        const map = session.getProfileService().getUinByUid('FriendsServiceImpl', [key]);
        return map && typeof map.get === 'function' ? map.get(key) : '';
      }));
    }
    if (!uin && typeof session.getGroupService === 'function') {
      uin = asUin(await attempt(async () => {
        const data = await session.getGroupService().getUinByUids([key]);
        const map = data && data.uins;
        return map && typeof map.get === 'function' ? map.get(key) : '';
      }));
    }
    const clean = asUin(uin);
    if (clean) {
      this.ctx.state.uinByUid.set(key, clean);
      return clean;
    }
    // 诊断用：换号失败在 /api/status.probe 里可见，不用翻日志。
    this.ctx.state.probe.lastResolveUinMiss = { uid: key.slice(0, 16), at: Date.now() };
    return '';
  }

  /** uid -> QQ 号；@ 段与群成员解析都靠它。 */
  uinOfUid(uid) {
    if (!uid) return '';
    const key = String(uid);
    const direct = this.ctx.state.uinByUid.get(key);
    if (direct) return direct;
    // 没见过这个人的消息时，从已缓存的群成员列表里找（成员对象带 uin）。
    for (const entry of this.ctx.state.memberListCache.values()) {
      const hit = (entry.list || []).find((item) => String(item && item.uid) === key);
      if (hit && hit.uin) {
        this.ctx.state.uinByUid.set(key, String(hit.uin));
        if (hit.nick) this.ctx.state.nickByUin.set(String(hit.uin), String(hit.nick));
        return String(hit.uin);
      }
    }
    return '';
  }

  /** uin -> 昵称（好友或群成员），@ 文案用。 */
  nickOfUin(uin) {
    if (!uin) return '';
    return this.ctx.state.nickByUin.get(String(uin)) || '';
  }

  /** uin -> uid；群聊优先用成员列表，私聊用好友列表。 */
  async resolveAtUid(uin, scene, peerId) {
    const key = String(uin);
    const groupKey = peerKey(peerId, key);
    const cached = this.ctx.state.uidByGroupKey.get(groupKey) || this.ctx.state.uidByUin.get(key);
    if (cached) return cached;
    try { await this.friends(); } catch (error) { /* 好友列表失败不致命 */ }
    if (this.ctx.state.uidByUin.has(key)) return this.ctx.state.uidByUin.get(key);
    if (scene === 'group') {
      try {
        const members = await this.ctx.kernel.groupMembers(peerId);
        const hit = members.find((member) => String(member.user_id) === key);
        if (hit && hit.uid) return hit.uid;
      } catch (error) { /* 成员列表失败则落到报错 */ }
    }
    throw new Error('无法解析 @ 目标的 uid：' + key);
  }

  /**
     * 陌生人/任意 QQ 号的基本资料。
     * 拿不到原生资料就退化成缓存里的昵称，绝不因为查不到而抛错——
     * 框架会周期性轮询这个接口，抛错只会把日志刷满。
     */
  async stranger(uin) {
    const key = String(uin || '');
    if (!/^\d{5,12}$/.test(key)) throw new Error('QQ 号格式不正确');
    const session = this.ctx.state.session || this.ctx.kernel.requireSession();
    let detail = null;
    try {
      const profile = typeof session.getProfileService === 'function' ? session.getProfileService() : null;
      if (profile && typeof profile.getUserDetailInfoByUin === 'function') {
        const raw = await withTimeout(profile.getUserDetailInfoByUin(key), 5000, 'getUserDetailInfoByUin');
        detail = (raw && (raw.detail || raw.result || raw)) || null;
        this.ctx.state.probe.strangerKeys = detail && typeof detail === 'object' ? Object.keys(detail).slice(0, 12) : null;
      }
    } catch (error) {
      this.ctx.state.probe.strangerError = String(error?.message || error);
    }
    const core = (detail && detail.simpleInfo && detail.simpleInfo.coreInfo) || {};
    const base = (detail && detail.simpleInfo && detail.simpleInfo.baseInfo) || {};
    let nickname = String(core.nick || (detail && detail.nick) || '');
    if (!nickname) nickname = this.nickOfUin(key);
    if (!nickname && detail && detail.uin) nickname = this.nickOfUin(String(detail.uin));
    const sex = base.sex === 1 ? 'male' : base.sex === 2 ? 'female' : 'unknown';
    return {
      user_id: Number(key),
      nickname,
      sex,
      age: Number(base.age || 0) || 0,
      qid: String((detail && detail.qid) || ''),
      level: Number((detail && detail.commonExt && detail.commonExt.qqLevel) || 0) || 0,
      uid: String((detail && detail.uid) || this.ctx.state.uidByUin.get(key) || ''),
    };
  }

  /** uin -> uid：发送私聊时必须用 uid。 */
  async resolveUid(uin) {
    const key = String(uin);
    if (this.ctx.state.uidByUin.has(key)) return this.ctx.state.uidByUin.get(key);
    await this.friends();
    const hit = this.ctx.state.uidByUin.get(key);
    if (!hit) throw new Error('好友列表中没有 QQ ' + key + '，无法确定私聊会话');
    return hit;
  }

  // ---------------------------------------------------------------- 资料

  async friends() {
    const session = this.ctx.state.session || this.ctx.kernel.requireSession();
    const buddy = session.getBuddyService();
    // getBuddyListV2 返回的是分组（category + buddyUids），不是用户行；
    // 必须再用资料服务把 uid 映射成 uin/nick（与 NC 一致）。
    const result = await withTimeout(buddy.getBuddyListV2('0', true, 0), 6000, 'getBuddyListV2');
    const categories = Array.isArray(result && result.data) ? result.data : [];
    const uids = [...new Set(categories.flatMap((item) =>
      Array.isArray(item && item.buddyUids) ? item.buddyUids.map(String) : []))];
    if (uids.length === 0) return [];
    const profile = session.getProfileService();
    const infos = await withTimeout(profile.getCoreAndBaseInfo('nodeStore', uids), 6000, 'getCoreAndBaseInfo');
    if (!(infos instanceof Map)) throw new Error('好友资料服务未返回 UID 映射');
    return uids.flatMap((uid) => {
      const item = infos.get(uid);
      if (!item) return [];
      const core = item.coreInfo || {};
      const uin = Number(item.uin || core.uin || 0);
      if (uin && uid) this.ctx.state.uidByUin.set(String(uin), uid);
      // 好友列表里也包含自己，顺手补上昵称，避免控制台显示空昵称。
      if (uin && String(uin) === String(this.ctx.state.uin)) this.ctx.state.nick = String(core.nick || this.ctx.state.nick || '');
      return [{
        user_id: uin,
        nickname: String(core.nick || ''),
        remark: String(core.remark || ''),
        uid,
      }];
    });
  }
}

module.exports = { ContactsDomain };
