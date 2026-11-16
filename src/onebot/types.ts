/** OneBot v11 wire types. Kept structural so unknown fields round-trip. */

export interface Ob11Segment {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export type Ob11Message = string | Ob11Segment[];

export interface Ob11Response<T = unknown> {
  status: 'ok' | 'failed';
  retcode: number;
  data: T;
  message: string;
  wording: string;
  echo?: unknown;
}

export type TransportName = 'http' | 'websocket' | 'sse';

/** Post types defined by OneBot v11. */
export type Ob11PostType = 'message' | 'message_sent' | 'notice' | 'request' | 'meta_event';

export interface Ob11EventBase {
  readonly time: number;
  readonly self_id: number;
  readonly post_type: Ob11PostType;
  readonly [key: string]: unknown;
}

export interface Ob11Status {
  readonly online: boolean;
  readonly good: boolean;
}

/** Numeric return codes used by the action layer. */
export const RETCODE = {
  ok: 0,
  async: 1,
  badParam: 1400,
  unsupported: 1200,
  forbidden: 1403,
  notFound: 1404,
  server: 1500,
  timeout: 100,
} as const;

export type Retcode = (typeof RETCODE)[keyof typeof RETCODE];

export class ActionError extends Error {
  readonly retcode: number;

  constructor(message: string, retcode: number = RETCODE.server) {
    super(message);
    this.name = 'ActionError';
    this.retcode = retcode;
  }
}

export function okResponse<T>(data: T, echo?: unknown): Ob11Response<T> {
  const response: Ob11Response<T> = { status: 'ok', retcode: RETCODE.ok, data, message: '', wording: '', echo };
  return response;
}

export function failedResponse(error: unknown, echo?: unknown): Ob11Response<null> {
  const retcode = error instanceof ActionError ? error.retcode : RETCODE.server;
  const message = error instanceof Error ? error.message : String(error);
  return { status: 'failed', retcode, data: null, message, wording: message, echo };
}
