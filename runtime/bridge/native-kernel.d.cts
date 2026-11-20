/**
 * 测试用声明：runtime/bridge/native-kernel.cjs 在 QQ 进程内运行，
 * 这里只暴露测试实际用到的表面（请求事件映射与 uid→uin 解析）。
 */
export declare class NativeKernel {
  constructor(options?: {
    wrapperObserved?: () => boolean;
    sessionProvider?: () => unknown;
    sessionAccount?: (session: unknown) => { uin: string } | undefined;
  });
  mode: string;
  readonly state: Record<string, any>;
  uin: string;
  nick: string;
  handleBuddyRequests(data: unknown): Promise<void>;
  handleGroupNotifies(notifications: unknown[]): Promise<void>;
  resolveUin(uid: string): Promise<string>;
  uinOfUid(uid: string): string;
  status(): {
    online: boolean;
    messageReady: boolean;
    authorized: boolean;
    accountState: 'authorized' | 'signed_out' | 'unknown';
    msf: number;
    idleMs: number;
    lastMsgAt: number;
    uin: string;
    nick: string;
    avatar: string;
    loginAt: number;
  };
  onNativeMessage(message: unknown): void;
  attachMessages(): void;
  start(emit: (event: unknown) => void): Promise<void>;
  stop(): Promise<void>;
  bindingValid(): boolean;
  invalidateBinding(): void;
  invalidateSession(): void;
  getMessage(msgId: string, peer?: { chatType: number; peerUid: string; guildId: string }): Promise<any>;
  cacheMessage(message: any): any;
  configureOutbound(config: Record<string, unknown>): Record<string, unknown>;
  outboundStatus(): Record<string, unknown>;
  /** 文件/视频出站：RichMedia 复制 + 元素构造。 */
  buildFileElement(rawFile: string, rawName?: string): Promise<any>;
  buildVideoElement(rawFile: string, rawName?: string, duration?: number): Promise<any>;
  /** 合并转发展开：getMultiMsg(parentPeer, 最外层id, msgId)。 */
  getForward(msgId: string): Promise<any[] | null>;
}

export declare const ELEMENT_TEXT: number;
export declare const ELEMENT_PIC: number;
