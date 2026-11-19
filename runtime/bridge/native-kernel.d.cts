/**
 * 测试用声明：runtime/bridge/native-kernel.cjs 在 QQ 进程内运行，
 * 这里只暴露测试实际用到的表面（请求事件映射与 uid→uin 解析）。
 */
export declare class NativeKernel {
  constructor(options?: { wrapperObserved?: () => boolean; sessionProvider?: () => unknown });
  mode: string;
  uin: string;
  nick: string;
  session: any;
  probe: Record<string, any>;
  emit(event: unknown): void;
  handleBuddyRequests(data: unknown): Promise<void>;
  handleGroupNotifies(notifications: unknown[]): Promise<void>;
  resolveUin(uid: string): Promise<string>;
  uinOfUid(uid: string): string;
  msgService: any;
  lastMsgAt: number;
  loginSucceeded: boolean;
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
  getMessage(msgId: string): Promise<any>;
  /** 文件/视频出站：RichMedia 复制 + 元素构造。 */
  buildFileElement(rawFile: string, rawName?: string): Promise<any>;
  buildVideoElement(rawFile: string, rawName?: string, duration?: number): Promise<any>;
  /** 合并转发展开：getMultiMsg(parentPeer, 最外层id, msgId)。 */
  getForward(msgId: string): Promise<any[] | null>;
}

export declare const ELEMENT_TEXT: number;
export declare const ELEMENT_PIC: number;
