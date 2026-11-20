'use strict';
const { ContactsDomain } = require('./kernel/contacts.cjs');
const { DiagnosticsDomain } = require('./kernel/diagnostics.cjs');
const { ElementsDomain } = require('./kernel/elements.cjs');
const { GroupsDomain } = require('./kernel/groups.cjs');
const { LoginDomain } = require('./kernel/login.cjs');
const { MediaUploadDomain } = require('./kernel/media-upload.cjs');
const { MediaDomain } = require('./kernel/media.cjs');
const { MessagesDomain } = require('./kernel/messages.cjs');
const { MetaDomain } = require('./kernel/meta.cjs');
const { RequestsDomain } = require('./kernel/requests.cjs');
const { SessionDomain } = require('./kernel/session.cjs');
const { createNativeState } = require('./kernel/state.cjs');
const { OutboundTiming } = require('./kernel/timing.cjs');
const { ForwardDomain } = require('./kernel/forward.cjs');
const { StagingCleanup } = require('./kernel/staging-cleanup.cjs');
const { ELEMENT_TEXT, ELEMENT_PIC } = require('./kernel/shared.cjs');

/** Explicit facade; domains never modify the NativeKernel prototype. */
class NativeKernel {
  constructor(options = {}) {
    this.mode = 'native';
    this.version = 'qq-native-bridge/2.0';
    this.state = createNativeState();
    this.state.timing = new OutboundTiming();
    this.domains = {};
    const ctx = Object.freeze({ kernel: this, state: this.state, options });
    this.domains.contacts = new ContactsDomain(ctx);
    this.domains.diagnostics = new DiagnosticsDomain(ctx);
    this.domains.elements = new ElementsDomain(ctx);
    this.domains.groups = new GroupsDomain(ctx);
    this.domains.login = new LoginDomain(ctx);
    this.domains.mediaUpload = new MediaUploadDomain(ctx);
    this.domains.media = new MediaDomain(ctx);
    this.domains.messages = new MessagesDomain(ctx);
    this.domains.forward = new ForwardDomain(ctx);
    this.domains.staging = new StagingCleanup(ctx);
    this.domains.meta = new MetaDomain(ctx);
    this.domains.requests = new RequestsDomain(ctx);
    this.domains.session = new SessionDomain(ctx);
    try {
      this.state.metaPath = require('node:path').join(require('node:os').homedir(), '.duskfox-msg-meta.json');
      this.domains.meta.loadMetaCache();
    } catch (error) {
      this.state.metaPath = null;
      this.state.probe.metaLoadError = String(error?.stack || error);
      console.error('[bridge] metadata load failed:', error);
    }
  }

  get uin() { return this.state.uin; }
  get nick() { return this.state.nick; }
  get avatar() { return this.state.avatar; }
  get qrState() { return this.state.qrState; }
  get qrSeq() { return this.state.qrSeq; }
  get sendSegments() { return this.state.sendSegments; }
  get recvSegments() { return this.state.recvSegments; }
  get downloadSegments() { return this.state.downloadSegments; }
  get passwordLoginEnabled() { return this.state.passwordLoginEnabled; }
  get pendingNative() { return this.state.pendingNative; }
  outboundStatus() { return { ...this.state.timing.snapshot(), stagingCleanup: this.domains.staging.snapshot() }; }
  configureOutbound(config) {
    this.state.timing.update(config, true);
    this.domains.staging.reschedule();
    return this.outboundStatus();
  }
  recordStaging(...args) { return this.domains.staging.record(...args); }
  ensureStagingCapacity(...args) { return this.domains.staging.assertCapacity(...args); }

  resolveUin(...args) { return this.domains.contacts.resolveUin(...args); }
  uinOfUid(...args) { return this.domains.contacts.uinOfUid(...args); }
  nickOfUin(...args) { return this.domains.contacts.nickOfUin(...args); }
  resolveAtUid(...args) { return this.domains.contacts.resolveAtUid(...args); }
  stranger(...args) { return this.domains.contacts.stranger(...args); }
  resolveUid(...args) { return this.domains.contacts.resolveUid(...args); }
  friends(...args) { return this.domains.contacts.friends(...args); }
  diagnostics(...args) { return this.domains.diagnostics.diagnostics(...args); }
  methodsOf(...args) { return this.domains.diagnostics.methodsOf(...args); }
  rememberNativeShape(...args) { return this.domains.diagnostics.rememberNativeShape(...args); }
  atProbe(...args) { return this.domains.diagnostics.atProbe(...args); }
  buildAtElement(...args) { return this.domains.elements.buildAtElement(...args); }
  buildReplyElement(...args) { return this.domains.elements.buildReplyElement(...args); }
  toNativeElements(...args) { return this.domains.elements.toNativeElements(...args); }
  captureGroupListUpdate(...args) { return this.domains.groups.captureGroupListUpdate(...args); }
  pickGroupArray(...args) { return this.domains.groups.pickGroupArray(...args); }
  summarizeGroupValue(...args) { return this.domains.groups.summarizeGroupValue(...args); }
  warmGroupMembers(...args) { return this.domains.groups.warmGroupMembers(...args); }
  groupNameOf(...args) { return this.domains.groups.groupNameOf(...args); }
  memberRoleOf(...args) { return this.domains.groups.memberRoleOf(...args); }
  warmGroup(...args) { return this.domains.groups.warmGroup(...args); }
  cacheMember(...args) { return this.domains.groups.cacheMember(...args); }
  groups(...args) { return this.domains.groups.groups(...args); }
  memberArrayOf(...args) { return this.domains.groups.memberArrayOf(...args); }
  rawMemberArray(...args) { return this.domains.groups.rawMemberArray(...args); }
  memberView(...args) { return this.domains.groups.memberView(...args); }
  groupMember(...args) { return this.domains.groups.groupMember(...args); }
  groupMembers(...args) { return this.domains.groups.groupMembers(...args); }
  get quickLoginSupported() { return this.domains.login.quickLoginSupported; }
  quickList(...args) { return this.domains.login.quickList(...args); }
  quickLogin(...args) { return this.domains.login.quickLogin(...args); }
  attach(...args) { return this.domains.login.attach(...args); }
  requestQr(...args) { return this.domains.login.requestQr(...args); }
  currentQr(...args) { return this.domains.login.currentQr(...args); }
  markOnline(...args) { return this.domains.login.markOnline(...args); }
  login(...args) { return this.domains.login.login(...args); }
  logout(...args) { return this.domains.login.logout(...args); }
  get logoutSupported() { return this.domains.login.logoutSupported; }
  buildPicElement(...args) { return this.domains.mediaUpload.buildPicElement(...args); }
  buildPttElement(...args) { return this.domains.mediaUpload.buildPttElement(...args); }
  buildFileElement(...args) { return this.domains.mediaUpload.buildFileElement(...args); }
  buildVideoElement(...args) { return this.domains.mediaUpload.buildVideoElement(...args); }
  uploadForRichMedia(...args) { return this.domains.mediaUpload.uploadForRichMedia(...args); }
  media(...args) { return this.domains.media.media(...args); }
  getForward(...args) { return this.domains.media.getForward(...args); }
  onRichMediaDownloadComplete(...args) { return this.domains.media.onRichMediaDownloadComplete(...args); }
  downloadRichMedia(...args) { return this.domains.media.downloadRichMedia(...args); }
  onNativeMessage(...args) { return this.domains.messages.onNativeMessage(...args); }
  cacheMessage(...args) { return this.domains.messages.cacheMessage(...args); }
  getMessage(...args) { return this.domains.messages.getMessage(...args); }
  peerOf(...args) { return this.domains.messages.peerOf(...args); }
  aioMessages(...args) { return this.domains.messages.aioMessages(...args); }
  selfSeqWatermark(...args) { return this.domains.messages.selfSeqWatermark(...args); }
  confirmSentMessage(...args) { return this.domains.messages.confirmSentMessage(...args); }
  outboundKey(scene, peerId) {
    let id = String(peerId);
    if (scene === 'private' && id.startsWith('u_')) {
      for (const [uin, uid] of this.state.uidByUin) if (uid === id) { id = uin; break; }
      id = this.uinOfUid(id) || id;
    }
    return scene + ':' + id;
  }
  send(input) {
    return this.state.timing.run(this.outboundKey(input.scene, input.peerId), () => this.domains.messages.send(input));
  }
  sendNative(input) { return this.domains.messages.send(input); }
  sendForward(input) { return this.domains.forward.send(input); }
  recall(messageId) {
    const peer = this.state.peerByMsgId.get(String(messageId));
    const key = peer ? this.outboundKey(peer.chatType === 2 ? 'group' : 'private', peer.peerUid) : 'recall:' + messageId;
    return this.state.timing.run(key, () => this.domains.messages.recall(messageId));
  }
  loadMetaCache(...args) { return this.domains.meta.loadMetaCache(...args); }
  scheduleMetaFlush(...args) { return this.domains.meta.scheduleMetaFlush(...args); }
  attachRequestListeners(...args) { return this.domains.requests.attachRequestListeners(...args); }
  handleBuddyRequests(...args) { return this.domains.requests.handleBuddyRequests(...args); }
  handleGroupNotifies(...args) { return this.domains.requests.handleGroupNotifies(...args); }
  handleRequest(input) {
    const group = this.state.groupNotices.get(input.flag);
    const friend = this.state.friendRequests.get(input.flag);
    const key = input.type === 'group'
      ? this.outboundKey('group', group?.group?.groupCode || input.flag)
      : this.outboundKey('private', friend?.friendUid || input.flag);
    return this.state.timing.run(key, () => this.domains.requests.handleRequest(input));
  }
  async start(...args) {
    await this.domains.session.start(...args);
    this.domains.staging.start();
  }
  async stop(...args) {
    try { await this.domains.staging.stop(); }
    finally { await this.domains.session.stop(...args); }
  }
  get authorized() { return this.domains.session.authorized; }
  get online() { return this.domains.session.online; }
  refreshMsf(...args) { return this.domains.session.refreshMsf(...args); }
  invalidateBinding(...args) { return this.domains.session.invalidateBinding(...args); }
  invalidateSession(...args) { return this.domains.session.invalidateSession(...args); }
  bindingValid(...args) { return this.domains.session.bindingValid(...args); }
  status(...args) { return this.domains.session.status(...args); }
  attachMessages(...args) { return this.domains.session.attachMessages(...args); }
  requireSession(...args) { return this.domains.session.requireSession(...args); }
}

module.exports = { NativeKernel, ELEMENT_TEXT, ELEMENT_PIC };
