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
}

export function createSimKernelFromEnv(): SimKernel;
export const TINY_PNG: Buffer;
export function pngDataUrl(): string;
