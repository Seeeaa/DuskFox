export interface BridgeServerOptions {
  kernel: unknown;
  logger?: { log?: (message: string) => void; error?: (message: string) => void };
  token?: string;
  qrPump?: boolean;
  qrCooldownMs?: number;
}

export interface BridgeServerHandle {
  server: unknown;
  kernel: unknown;
  features: Record<string, boolean>;
  ingest(event: unknown): void;
  readonly phase: string;
  setPump(enabled: boolean): void;
  listen(port: number, host?: string): Promise<{ port: number } | null>;
  close(): Promise<void>;
}

export function createBridgeServer(options: BridgeServerOptions): BridgeServerHandle;
export function attachKernelEvents(bridge: BridgeServerHandle, kernel: unknown): Promise<void>;
export function toOb11Segments(native: Record<string, unknown>): Array<{ type: string; data: Record<string, unknown> }>;
