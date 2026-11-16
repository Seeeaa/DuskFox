import type { AccountDriver, DriverContext, DriverDescriptor, DriverOptions } from './types.ts';
import { MockDriver } from './mock.ts';
import { BridgeDriver } from './bridge.ts';

const DESCRIPTORS: readonly DriverDescriptor[] = [
  {
    id: 'mock',
    name: '模拟账号',
    description: '本地模拟的 QQ 会话：用于在没有真实客户端时联调 OneBot 与控制台。',
    create: (context, options) => new MockDriver(context, options),
  },
  {
    id: 'bridge',
    name: 'QQ 原生桥接',
    description: '连接一个独立的 QQ 原生运行时（HTTP 契约），当前仅支持私聊文本。',
    create: (context, options) => new BridgeDriver(context, options),
  },
];

export function listDrivers(): readonly DriverDescriptor[] {
  return DESCRIPTORS;
}

export function findDriver(id: string): DriverDescriptor | undefined {
  return DESCRIPTORS.find((descriptor) => descriptor.id === id);
}

/** Create a driver by id; falls back to the mock driver for unknown ids. */
export function createDriver(id: string, context: DriverContext, options: DriverOptions = {}): AccountDriver {
  const descriptor = findDriver(id) ?? DESCRIPTORS[0];
  if (!descriptor) throw new Error('没有可用的驱动');
  return descriptor.create(context, options);
}
