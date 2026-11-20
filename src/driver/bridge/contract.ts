import type { AccountSessionState } from '../../core/model.ts';
import type { Capabilities } from '../types.ts';

export interface BridgeStatusPayload {
  /** Complete authoritative report in contract v3. */
  readonly capabilities?: Capabilities;
  readonly message_ready?: boolean;
  /** Login/authorisation finished; the message network may still be down. */
  readonly authorized?: boolean;
  readonly account_state?: AccountSessionState;
  /** 消息服务原始就绪位；缺省时回退 message_ready。 */
  readonly message_service_ready?: boolean;
  /** getMsfStatus(): 1=disconnected, 2=connected. */
  readonly msf_status?: number;
  readonly qr_ready?: boolean;
  readonly phase?: string;
  readonly login_mode?: 'active' | 'passive';
  /** Contract version of the runtime (1 = legacy send-private only). */
  readonly contract?: number;
  /** "sim" for the simulated kernel; absent for a real runtime. */
  readonly mode?: string;
  /** Identity of the runtime process instance; changes across restarts. */
  readonly instance?: string;
  /** Which OneBot segments the runtime can actually send / receive. */
  readonly send_segments?: string[];
  readonly recv_segments?: string[];
  /** 哪些媒体能按消息 id 取回字节（get_record / get_file …）。 */
  readonly download_segments?: string[];
  /** Native calls the runtime author has not verified against a real client. */
  readonly pending_native?: string[];
  /**
   * Optional capability report. Runtimes that implement contract v2 send it;
   * older ones omit it and keep the conservative v1 capability set.
   */
  readonly features?: Record<string, unknown>;
  readonly self_id?: number | string;
  /** Epoch ms when the runtime's account session started (survives runtime restarts). */
  readonly login_at?: number;
  readonly nickname?: string;
  readonly avatar?: string;
  readonly version?: string;
  readonly pid?: number;
  readonly cpu?: number;
  readonly memory_mb?: number;
  readonly native_probe?: Record<string, unknown>;
}

export interface BridgeEventEnvelope {
  readonly cursor?: number;
  readonly instance?: string;
  /** How many events were dropped by the runtime ring since `after`. */
  readonly lost?: number;
  readonly events?: Array<{ readonly cursor?: number; readonly data?: Record<string, unknown> }>;
}
