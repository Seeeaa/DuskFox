'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */

function logoutMarkerPath() {
  const os = require('node:os');
  const path = require('node:path');
  return path.join(os.homedir(), '.duskfox-logged-out');
}

/** 清掉“已登出”标记：任意一次成功登录（扫码或快速）都意味着标记作废。 */
function clearLogoutMarker() {
  try { require('node:fs').rmSync(logoutMarkerPath(), { force: true }); } catch (error) { /* 忽略 */ }
}

function loginAtPath() {
  const os = require('node:os');
  const path = require('node:path');
  return path.join(os.homedir(), '.duskfox-login-at.json');
}

function readLoginAt() {
  try {
    const data = JSON.parse(require('node:fs').readFileSync(loginAtPath(), 'utf8'));
    const at = Number(data && data.at);
    return { at: Number.isFinite(at) && at > 0 ? at : 0, uin: String((data && data.uin) || '') };
  } catch (error) {
    return null;
  }
}

function writeLoginAt(at, uin) {
  try {
    require('node:fs').writeFileSync(loginAtPath(), JSON.stringify({ at, uin }));
  } catch (error) { /* 忽略 */ }
}

function clearLoginAt() {
  try { require('node:fs').rmSync(loginAtPath(), { force: true }); } catch (error) { /* 忽略 */ }
}

function accountPath() {
  const os = require('node:os');
  const path = require('node:path');
  return path.join(os.homedir(), '.duskfox-account.json');
}

/** 记住“这台机器上次登录的机器人账号”，避免重启后静默登录成另一个号。 */
function rememberAccount(uin) {
  try {
    if (!/^\d{5,12}$/.test(String(uin || ''))) return;
    require('node:fs').writeFileSync(accountPath(), JSON.stringify({ uin: String(uin), at: Date.now() }));
  } catch (error) { /* 忽略 */ }
}

function rememberedAccount() {
  try {
    const data = JSON.parse(require('node:fs').readFileSync(accountPath(), 'utf8'));
    const uin = String((data && data.uin) || '');
    return /^\d{5,12}$/.test(uin) ? uin : '';
  } catch (error) {
    return '';
  }
}

class MetaDomain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** 重启后恢复最近消息的 msgId -> 元数据，引用/撤回旧消息才不会丢。 */
  loadMetaCache() {
    const fs = require('node:fs');
    if (!this.ctx.state.metaPath || !fs.existsSync(this.ctx.state.metaPath)) return;
    const data = JSON.parse(fs.readFileSync(this.ctx.state.metaPath, 'utf8'));
    const messages = Array.isArray(data && data.messages) ? data.messages : [];
    for (const item of messages) {
      if (!item || !item.msgId) continue;
      const meta = {
        msgId: String(item.msgId),
        msgSeq: String(item.msgSeq ?? ''),
        msgTime: String(item.msgTime ?? ''),
        senderUid: String(item.senderUid ?? ''),
        senderUidStr: String(item.senderUidStr ?? ''),
        senderUin: String(item.senderUin ?? ''),
        peerUid: String(item.peerUid ?? ''),
        chatType: item.chatType,
      };
      this.ctx.state.metaByMsgId.set(meta.msgId, meta);
      if (meta.peerUid) {
        this.ctx.state.peerByMsgId.set(meta.msgId, { chatType: meta.chatType, peerUid: meta.peerUid, guildId: '' });
      }
    }
    this.ctx.state.probe.metaRestored = this.ctx.state.metaByMsgId.size;
  }

  /** 合并写盘：每条消息都写太吵，2 秒一次；只管最近 400 条。 */
  scheduleMetaFlush() {
    if (this.ctx.state.metaTimer) return;
    this.ctx.state.metaTimer = setTimeout(() => {
      this.ctx.state.metaTimer = null;
      try {
        const fs = require('node:fs');
        if (!this.ctx.state.metaPath) return;
        const messages = [];
        for (const [, meta] of this.ctx.state.metaByMsgId) messages.push(meta);
        // 保留更多消息元数据：Fox 重启后 get_msg/引用要在更长窗口内仍能反查。
        const recent = messages.slice(-2000);
        fs.writeFileSync(this.ctx.state.metaPath, JSON.stringify({ at: Date.now(), messages: recent }));
        this.ctx.state.probe.metaSaved = recent.length;
      } catch (error) {
        this.ctx.state.probe.metaSaveError = String(error?.message || error);
      }
    }, 2000);
    if (typeof this.ctx.state.metaTimer.unref === 'function') this.ctx.state.metaTimer.unref();
  }
}

module.exports = { MetaDomain, logoutMarkerPath, clearLogoutMarker, loginAtPath, readLoginAt, writeLoginAt, clearLoginAt, accountPath, rememberAccount, rememberedAccount };
