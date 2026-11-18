export interface SimKernelOptions {
  autoLogin?: boolean;
  qrTtlMs?: number;
}

export class SimKernel {
  constructor(options?: SimKernelOptions);
  readonly mode: string;
  readonly uin: string;
  qrSeq: number;
  qrState: string;
  sent: Array<{ scene: string; peerId: string; msgId: string; segments: unknown[]; recalled?: boolean }>;
  requests: Array<{ flag: string; approve: boolean; type: string; subType?: string }>;
  start(emit: (event: unknown) => void): Promise<void>;
  stop(): Promise<void>;
  status(): { uin: string; nick: string; avatar: string; online: boolean };
  incoming(input: Record<string, unknown>): void;
  /** Push a friend/group request the way the native kernel does; returns its flag. */
  request(input?: {
    kind?: 'friend' | 'group';
    userId?: string;
    /** Native uid carried next to the QQ number (alphanumeric for strangers). */
    uid?: string;
    groupId?: string;
    comment?: string;
    subType?: 'add' | 'invite';
    flag?: string;
    time?: number;
  }): string;
  /** Register a uid -> QQ number mapping (simulates the native friend/member cache). */
  mapUid(uid: string, uin: string): void;
  /** Resolve a uid to a QQ number, '' when unknown. */
  uinOfUid(uid: string): string;
  issueQr(ttlMs?: number): boolean;
  currentQr(): { picture: string | null; seq: number; expiresAt: number; expired: boolean } | null;
  requestQr(): Promise<boolean>;
  scanQr(): void;
  confirmQr(): void;
  setOnline(next: boolean): void;
  send(input: { scene: string; peerId: string; segments: unknown[] }): Promise<{ messageId: string }>;
  recall(msgId: string): Promise<boolean>;
  friends(): Promise<unknown[]>;
  groups(): Promise<unknown[]>;
  groupMember(groupId: string, userId: string): Promise<unknown>;
  groupMembers(groupId: string): Promise<unknown[]>;
  handleRequest(input: { flag: string; approve: boolean; type: string; subType?: string }): Promise<boolean>;
  media(msgId: string, kind?: string): Promise<{ base64: string; name: string; size: number }>;
  getForward(msgId: string): Promise<unknown[] | null>;
  /** 能按消息 id 取回字节的媒体类型（/api/media 的后端）。 */
  downloadSegments: string[];
  getMessage(msgId: string): Promise<unknown>;
}

export function createSimKernelFromEnv(): SimKernel;
export const TINY_PNG: Buffer;
/** 语音的模拟音频字节（AMR 头 + 静音），供 get_record 的离线闭环使用。 */
export const TINY_AMR: Buffer;
/** 文件/视频的模拟字节，供 get_file / get_video 的离线闭环校验。 */
export const TINY_FILE: Buffer;
export const TINY_VIDEO: Buffer;
export function pngDataUrl(): string;
