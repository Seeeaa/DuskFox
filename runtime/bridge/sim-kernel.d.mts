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
  getMessage(msgId: string): Promise<unknown>;
}

export function createSimKernelFromEnv(): SimKernel;
export const TINY_PNG: Buffer;
/** 语音的模拟音频字节（AMR 头 + 静音），供 get_record 的离线闭环使用。 */
export const TINY_AMR: Buffer;
export function pngDataUrl(): string;
