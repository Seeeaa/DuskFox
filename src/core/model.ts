/** Shared message segments use the bridge/OneBot wire shape end to end. */
export type Scene = 'private' | 'group';

/** Unknown segment kinds and extension fields pass through unchanged. */
export interface Segment {
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly [key: string]: unknown;
}

export interface ForwardNode {
  readonly userId: string;
  readonly nickname?: string;
  readonly time: number;
  readonly segments: readonly Segment[];
}

export interface Peer {
  readonly id: string;
  readonly name?: string;
}

export interface Sender {
  readonly id: string;
  /**
   * Native uid when `id` could not be resolved to a QQ number (QQ gives
   * alphanumeric uids for people who are not friends/members yet). Purely
   * informational: OneBot actions still need a numeric id.
   */
  readonly uid?: string;
  readonly name?: string;
  readonly role?: 'owner' | 'admin' | 'member';
  readonly card?: string;
}

/** A message received from (or echoed for) the account. */
export interface InboundMessage {
  readonly scene: Scene;
  /** Driver native id, stable enough to recall within the driver's window. */
  readonly messageId: string;
  /** Native message sequence number when the driver reports one (NapCat real_seq). */
  readonly seq?: string;
  /** Epoch seconds. */
  readonly time: number;
  /** True when this account is the sender. */
  readonly self: boolean;
  readonly peer: Peer;
  readonly sender: Sender;
  readonly segments: readonly Segment[];
  /** Driver specific payload, only attached when OneBot debug is enabled. */
  readonly raw?: unknown;
}

export interface OutboundMessage {
  readonly scene: Scene;
  readonly peerId: string;
  readonly segments: readonly Segment[];
  /** Optional reply target, drivers that support quoting use it. */
  readonly replyTo?: string;
}

export interface AccountNotice {
  readonly kind:
    | 'friend_add'
    | 'friend_recall'
    | 'group_increase'
    | 'group_decrease'
    | 'group_admin'
    | 'group_recall'
    | 'group_upload'
    | 'group_ban'
    | 'offline'
    | 'online'
    | 'other';
  readonly time: number;
  readonly scene: Scene;
  readonly peer: Peer;
  readonly user: Sender;
  /** Driver specific payload, forwarded verbatim in debug mode. */
  readonly detail?: Record<string, unknown>;
}

export interface AccountRequest {
  readonly kind: 'friend' | 'group';
  readonly time: number;
  readonly scene: Scene;
  readonly peer: Peer;
  readonly user: Sender;
  readonly comment: string;
  /** Opaque flag used to approve or reject the request. */
  readonly flag: string;
  /** Driver specific payload (for example `sub_type`), forwarded when present. */
  readonly detail?: Record<string, unknown>;
}

export interface Friend {
  readonly id: string;
  readonly name: string;
  readonly remark?: string;
}

export interface Group {
  readonly id: string;
  readonly name: string;
  readonly memberCount?: number;
  readonly maxMemberCount?: number;
}

export interface StrangerInfo {
  readonly id: string;
  readonly name: string;
  readonly sex?: 'male' | 'female' | 'unknown';
  readonly age?: number;
}

export interface GroupMember {
  readonly groupId: string;
  readonly userId: string;
  readonly name: string;
  readonly card?: string;
  readonly role: 'owner' | 'admin' | 'member';
}

export type AccountState = 'starting' | 'qr' | 'logging' | 'online' | 'offline' | 'error';
export type AccountSessionState = 'authorized' | 'signed_out' | 'unknown';

export interface AccountStatus {
  readonly uin: string;
  readonly nick: string;
  readonly avatar: string;
  readonly state: AccountState;
  readonly online: boolean;
  readonly sessionState?: AccountSessionState;
  readonly bridgeReachable?: boolean;
  readonly messageReady?: boolean;
  readonly loginType: 'none' | 'qr' | 'quick' | 'password' | 'session';
  readonly detail?: string;
  /** Epoch ms when this account went online (survives console reloads and driver restarts). */
  readonly onlineSince?: number;
}

export interface ProcessInfo {
  readonly running: boolean;
  readonly pid?: number;
  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly version?: string;
  readonly args?: string;
}

export type QrState = 'none' | 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'unavailable';

export interface QrPayload {
  /** `none` while the account is online or no login is pending. */
  readonly state: QrState;
  /** PNG data URL ready to drop into an <img>. */
  readonly image?: string;
  readonly expiresAt?: number;
  /** Bumped every time a new code is issued so the console can poll cheaply. */
  readonly seq: number;
  /** False when the runtime cannot issue a new code on demand (passive mode). */
  readonly refreshable?: boolean;
  /** How the runtime obtains login codes, for operator hints. */
  readonly loginMode?: 'active' | 'passive' | 'unknown';
  /** Why no scannable code is available, shown verbatim by the console. */
  readonly hint?: string;
  /** True when the code came from a simulated kernel and is not scannable. */
  readonly mock?: boolean;
}

/** Everything a driver may do. Optional methods map 1:1 to OneBot actions. */
export interface LoginRequest {
  readonly method: 'qr' | 'quick' | 'password';
  readonly uin?: string;
  readonly password?: string;
}

export type DriverEvent =
  | { readonly type: 'state'; readonly status: AccountStatus }
  | { readonly type: 'message'; readonly message: InboundMessage }
  | { readonly type: 'notice'; readonly notice: AccountNotice }
  | { readonly type: 'request'; readonly request: AccountRequest }
  | { readonly type: 'qr'; readonly qr: QrPayload }
  | { readonly type: 'error'; readonly message: string };

export const EMPTY_STATUS: AccountStatus = {
  uin: '',
  nick: '',
  avatar: '',
  state: 'offline',
  online: false,
  loginType: 'none',
};
