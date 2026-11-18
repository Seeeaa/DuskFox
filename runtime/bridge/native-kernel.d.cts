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
}

export declare const ELEMENT_TEXT: number;
export declare const ELEMENT_PIC: number;
