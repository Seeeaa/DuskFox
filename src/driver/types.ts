import type {
  AccountRequest,
  AccountStatus,
  AccountNotice,
  DriverEvent,
  Friend,
  Group,
  GroupMember,
  InboundMessage,
  LoginRequest,
  OutboundMessage,
  ProcessInfo,
  QrPayload,
  StrangerInfo,
} from '../core/model.ts';
import type { Logger } from '../core/logger.ts';
import type { RuntimePaths } from '../core/paths.ts';
import type { OnebotConfig } from '../core/config.ts';

/**
 * Feature switches a driver advertises. OneBot actions declare which keys they
 * need, so an unsupported feature is refused centrally instead of failing deep
 * inside a driver with an opaque error.
 */
/** 消息段类型的统一键名，收发两个方向各自声明一份。 */
export type SegmentKind =
  | 'text'
  | 'image'
  | 'record'
  | 'file'
  | 'video'
  | 'forward'
  | 'at'
  | 'reply'
  | 'face'
  | 'json'
  | 'markdown';

/** 某个方向上支持哪些消息段。能收不等于能发，所以每个方向各一个。 */
export type SegmentCapabilities = Readonly<Record<SegmentKind, boolean>>;

/** 能不能把某类媒体取回本地字节（get_record / get_file …）。 */
export type DownloadCapabilities = Readonly<Record<'image' | 'record' | 'file' | 'video' | 'forward', boolean>>;

export interface Capabilities {
  readonly privateMessage: boolean;
  readonly groupMessage: boolean;
  /** 出站：这些段真的能被发出去。 */
  readonly send: SegmentCapabilities;
  /** 入站：这些段真的能被解析成 OneBot 事件。 */
  readonly recv: SegmentCapabilities;
  /** 查询/下载：这些媒体的字节真的能取回来。 */
  readonly download: DownloadCapabilities;
  /**
   * 兼容位：两条方向都支持才算 true。新代码请直接用 send / recv，
   * 这里只是为了不破坏既有调用点与控制台旧字段。
   */
  readonly mediaImage: boolean;
  readonly mediaRecord: boolean;
  readonly mediaVideo: boolean;
  readonly mediaFile: boolean;
  readonly mediaForward: boolean;
  readonly reply: boolean;
  readonly at: boolean;
  readonly face: boolean;
  readonly forward: boolean;
  readonly json: boolean;
  readonly markdown: boolean;
  readonly recall: boolean;
  readonly friendList: boolean;
  readonly groupList: boolean;
  readonly groupInfo: boolean;
  readonly strangerInfo: boolean;
  readonly groupMemberInfo: boolean;
  readonly groupMemberList: boolean;
  /** Whether recent messages can be queried through the framework store. */
  readonly messageQuery: boolean;
  /** Whether friend/group join requests can be approved or rejected. */
  readonly requestHandle: boolean;
  /** Whether media can be downloaded to a local path. */
  readonly mediaDownload: boolean;
  readonly processControl: boolean;
  readonly qrLogin: boolean;
  readonly quickLogin: boolean;
  readonly passwordLogin: boolean;
  readonly logout: boolean;
}

export type CapabilityKey = keyof Capabilities;

const NO_SEGMENTS: SegmentCapabilities = {
  text: false,
  image: false,
  record: false,
  file: false,
  video: false,
  forward: false,
  at: false,
  reply: false,
  face: false,
  json: false,
  markdown: false,
};

const NO_DOWNLOADS: DownloadCapabilities = {
  image: false,
  record: false,
  file: false,
  video: false,
  forward: false,
};

/** 用一串段类型构造方向能力表。 */
export function segmentCapabilities(kinds: readonly SegmentKind[] = []): SegmentCapabilities {
  const base: Record<SegmentKind, boolean> = { ...NO_SEGMENTS };
  for (const kind of kinds) base[kind] = true;
  return base;
}

export function downloadCapabilities(kinds: readonly (keyof DownloadCapabilities)[] = []): DownloadCapabilities {
  const base: Record<keyof DownloadCapabilities, boolean> = { ...NO_DOWNLOADS };
  for (const kind of kinds) base[kind] = true;
  return base;
}

/**
 * 兼容位由三个方向派生，避免出现"能收就算能发"的旧语义。
 * 任何修改 send/recv 之后都必须调用它。
 */
export function deriveLegacyCapabilities(caps: Capabilities): void {
  const target = caps as unknown as Record<string, unknown>;
  target.mediaImage = caps.send.image && caps.recv.image;
  target.mediaRecord = caps.send.record && caps.recv.record;
  target.mediaVideo = caps.send.video && caps.recv.video;
  target.mediaFile = caps.send.file && caps.recv.file;
  target.reply = caps.send.reply;
  target.at = caps.send.at && caps.recv.at;
  target.face = caps.send.face && caps.recv.face;
  target.forward = caps.send.forward && caps.recv.forward;
  target.json = caps.send.json && caps.recv.json;
  target.markdown = caps.send.markdown && caps.recv.markdown;
  // 下载方向没有兼容位，聚合出一个"至少能下载一种媒体"的粗粒度开关，
  // 供 requires: ['mediaDownload'] 这类旧动作做第一道门禁。
  target.mediaDownload =
    caps.download.image || caps.download.record || caps.download.file || caps.download.video || caps.download.forward;
}

export function capabilityMap(values: Partial<Capabilities>): Capabilities {
  const base: Capabilities = {
    privateMessage: false,
    groupMessage: false,
    send: { ...NO_SEGMENTS },
    recv: { ...NO_SEGMENTS },
    download: { ...NO_DOWNLOADS },
    mediaImage: false,
    mediaRecord: false,
    mediaVideo: false,
    mediaFile: false,
    mediaForward: false,
    reply: false,
    at: false,
    face: false,
    forward: false,
    json: false,
    markdown: false,
    recall: false,
    friendList: false,
    groupList: false,
    groupInfo: false,
    strangerInfo: false,
    groupMemberInfo: false,
    groupMemberList: false,
    messageQuery: true,
    requestHandle: false,
    mediaDownload: false,
    processControl: false,
    qrLogin: false,
    quickLogin: false,
    passwordLogin: false,
    logout: false,
  };
  const merged = { ...base, ...values };
  deriveLegacyCapabilities(merged);
  return merged;
}

export interface DriverContext {
  readonly logger: Logger;
  readonly paths: RuntimePaths;
  /** Push an event towards OneBot and the console. */
  readonly emit: (event: DriverEvent) => void;
  /** Current OneBot options (report self messages, debug payloads, ...). */
  readonly onebot: () => OnebotConfig;
}

export interface SendResult {
  readonly messageId: string;
}

/** Raw media bytes handed to OneBot `get_record`. */
export interface MediaPayload {
  readonly base64: string;
  readonly name: string;
  readonly size: number;
}

/** Contract every account backend implements. */
export interface AccountDriver {
  readonly id: string;
  readonly name: string;
  /** One sentence shown in the console. */
  readonly description: string;
  readonly capabilities: Capabilities;

  /** Wire up timers and event polling; must not throw when the backend is absent. */
  start(): Promise<void>;
  /** Release every resource; must be safe to call twice. */
  stop(): Promise<void>;

  status(): Promise<AccountStatus>;
  events(): readonly InboundMessage[];
  login(request: LoginRequest): Promise<void>;
  /** Local saved accounts for quick login (optional). */
  quickList?(): Promise<Array<{ uin: string; nickname: string; avatar?: string }>>;
  logout(): Promise<void>;
  qrCode(): Promise<QrPayload>;
  refreshQr(force?: boolean): Promise<QrPayload>;

  sendMessage(message: OutboundMessage): Promise<SendResult>;
  /** Look a message up by its native id (used by `get_msg` when the window missed it). */
  fetchMessage?(nativeId: string): Promise<InboundMessage | null>;
  /**
   * Download the media attached to a message as base64 (used by `get_record`).
   * Returns null when the runtime has no bytes for that message.
   */
  fetchMedia?(nativeId: string, kind: 'image' | 'record' | 'file' | 'video'): Promise<MediaPayload | null>;
  /** Expand a merged-forward message by its native id (OneBot get_forward_msg). */
  fetchForward?(nativeId: string): Promise<unknown[] | null>;
  recall(messageId: string): Promise<void>;
  friendList(): Promise<Friend[]>;
  groupList(): Promise<Group[]>;
  strangerInfo(userId: string): Promise<StrangerInfo>;
  groupMemberInfo(groupId: string, userId: string): Promise<GroupMember>;
  groupMemberList?(groupId: string): Promise<GroupMember[]>;
  /** Approve or reject a friend/group request identified by `flag`. */
  handleRequest?(input: {
    readonly flag: string;
    readonly approve: boolean;
    readonly type: 'friend' | 'group';
    readonly subType?: string;
  }): Promise<void>;
  // Optional diagnostics.
  /** How login codes are obtained, for honest capability reporting. */
  qrInfo?(): { readonly refreshable: boolean; readonly loginMode: 'active' | 'passive' | 'unknown' };
  processInfo?(): Promise<ProcessInfo>;
  controlProcess?(action: 'start' | 'restart' | 'stop'): Promise<void>;
  // Optional notices/requests feed used by tests and advanced drivers.
  emitNotice?(notice: AccountNotice): void;
  emitRequest?(request: AccountRequest): void;
}

export interface DriverDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly create: (context: DriverContext, options: DriverOptions) => AccountDriver;
}

export interface DriverOptions {
  /** Base URL of an external account runtime, when the driver needs one. */
  readonly endpoint?: string;
  /** Bearer token for the external runtime. */
  readonly token?: string;
  /** Enable synthetic traffic (mock driver only). */
  readonly simulate?: boolean;
  /** Sign in automatically after start (mock driver only). */
  readonly autoLogin?: boolean;
}
