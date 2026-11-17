import type { Logger } from '../core/logger.ts';
import type { ConfigStore } from '../core/config.ts';
import type { Stats } from '../core/stats.ts';
import type { AccountDriver } from '../driver/types.ts';
import type { InboundMessage } from '../core/model.ts';
import { MessageIdRegistry } from '../core/message-id.ts';
import { MessageStore } from '../core/message-store.ts';
import { createActionRegistry } from './actions/index.ts';
import type { ActionRegistry } from './actions/registry.ts';
import { buildHeartbeatEvent, buildLifecycleEvent, buildMessageEvent, buildNoticeEvent, buildRequestEvent } from './events.ts';
import { NetworkManager } from './network/manager.ts';
import type { ConnectionInfo, NetworkHost } from './network/base.ts';
import { failedResponse, okResponse, type Ob11EventBase, type Ob11Response, type TransportName } from './types.ts';

/** One line in the console event stream. */
export interface ConsoleEvent {
  readonly seq: number;
  readonly time: string;
  readonly ts: number;
  readonly type: string;
  readonly summary: string;
}

const EVENT_RING = 300;

export interface OneBotServiceOptions {
  readonly logger: Logger;
  readonly config: ConfigStore;
  readonly driver: AccountDriver;
  readonly stats: Stats;
  readonly version: string;
}

/**
 * Bridges the account driver to OneBot v11.
 *
 * Direction 1: driver events are converted once, fanned out to every transport
 * and mirrored into the console's event ring.
 * Direction 2: bot action calls are validated and dispatched to the driver.
 */
export class OneBotService {
  readonly registry: ActionRegistry;
  readonly messageIds: MessageIdRegistry;
  /** Recent messages, backing `get_msg`. */
  readonly messages = new MessageStore();
  readonly #logger: Logger;
  readonly #config: ConfigStore;
  readonly #driver: AccountDriver;
  readonly #stats: Stats;
  readonly #version: string;
  readonly #startedAt = Date.now();
  readonly #events: ConsoleEvent[] = [];
  readonly #listeners = new Set<(event: ConsoleEvent) => void>();
  #eventSeq = 0;
  #manager!: NetworkManager;
  #heartbeat: NodeJS.Timeout | null = null;
  #online = false;
  #selfId = 0;
  #running = false;

  constructor(options: OneBotServiceOptions) {
    this.#logger = options.logger;
    this.#config = options.config;
    this.#driver = options.driver;
    this.#stats = options.stats;
    this.#version = options.version;
    this.registry = createActionRegistry(options.logger);
    this.messageIds = new MessageIdRegistry(options.config.onebot.messageIdMode);
    this.#manager = this.#createManager();
  }

  get startedAt(): number {
    return this.#startedAt;
  }

  get selfId(): number {
    return this.#selfId;
  }

  get online(): boolean {
    return this.#online;
  }

  get driver(): AccountDriver {
    return this.#driver;
  }

  connections(): ConnectionInfo[] {
    return this.#manager?.connections() ?? [];
  }

  clientCount(): number {
    return this.#manager?.clientCount() ?? 0;
  }

  recentEvents(limit = 100): ConsoleEvent[] {
    const count = Math.max(1, Math.min(limit, EVENT_RING));
    return this.#events.slice(-count).reverse();
  }

  /** Subscribe to freshly published events (console live stream). */
  onEvent(listener: (event: ConsoleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.messageIds.mode = this.#config.onebot.messageIdMode;
    this.#logger.info('onebot', `动作表已注册 ${this.registry.size} 个 API`);
    await this.#manager.start();
    try {
      await this.#driver.start();
    } catch (error) {
      this.#logger.failure('onebot', '驱动启动失败', error);
    }
    this.publish(buildLifecycleEvent('enable', this.#eventContext(), { online: this.#online, good: this.#online }));
    this.#scheduleHeartbeat();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.publish(buildLifecycleEvent('disable', this.#eventContext(), { online: this.#online, good: this.#online }));
    await this.#manager.stop();
    try {
      await this.#driver.stop();
    } catch (error) {
      this.#logger.failure('onebot', '驱动停止失败', error);
    }
  }

  /** Soft restart: transports and driver are rebuilt without exiting the process. */
  async restart(): Promise<void> {
    this.#logger.warn('onebot', '正在重启 OneBot 服务');
    await this.stop();
    this.#manager = this.#createManager();
    await this.start();
  }

  /** Apply a config change (network hot reload, message id mode, heartbeat). */
  async applyConfig(change: { section: string; changedConnections: string[]; fullReload: boolean }): Promise<void> {
    if (change.section === 'network') {
      await this.#manager.apply(change as never);
      return;
    }
    if (change.section === 'onebot') {
      this.messageIds.mode = this.#config.onebot.messageIdMode;
      this.#scheduleHeartbeat();
    }
  }

  /** Convert and fan out one driver message. */
  handleMessage(message: InboundMessage): void {
    const config = this.#config.onebot;
    if (message.self && !config.reportSelfMessage) return;
    if (message.scene === 'private' && !config.events.privateMessage) return;
    if (message.scene === 'group' && !config.events.groupMessage) return;
    if (!message.self) this.#stats.incMessagesIn();
    const event = buildMessageEvent(message, this.#eventContext());
    this.messages.save({
      nativeId: message.messageId,
      ob11Id: Number(event.message_id) || 0,
      scene: message.scene,
      peerId: message.peer.id,
      ...(message.peer.name ? { peerName: message.peer.name } : {}),
      senderId: message.sender.id,
      ...(message.sender.name ? { senderName: message.sender.name } : {}),
      time: message.time,
      self: message.self,
      segments: message.segments,
    });
    this.publish(event);
  }

  /** Called by drivers when they publish a notice/request. */
  handleNotice(notice: Parameters<typeof buildNoticeEvent>[0]): void {
    if (!this.#config.onebot.events.notice) return;
    const event = buildNoticeEvent(notice, this.#eventContext());
    if (event) this.publish(event);
  }

  handleRequest(request: Parameters<typeof buildRequestEvent>[0]): void {
    if (!this.#config.onebot.events.request) return;
    this.publish(buildRequestEvent(request, this.#eventContext()));
  }

  /** Publish a prepared event to every transport and the console ring. */
  publish(event: Ob11EventBase): void {
    this.#stats.incEvent();
    try {
      this.#manager.publish(event);
    } catch (error) {
      this.#logger.failure('onebot', '事件分发失败', error);
    }
    this.#remember(event);
  }

  /** Entry point used by every transport. */
  async dispatch(
    action: string,
    params: Record<string, unknown>,
    echo: unknown,
    transport: TransportName,
  ): Promise<Ob11Response> {
    try {
      this.#stats.incApiCall();
      const data = await this.registry.invoke(action, params, this.#actionContext());
      return okResponse(data, echo);
    } catch (error) {
      this.#stats.incApiCall(true);
      const message = error instanceof Error ? error.message : String(error);
      this.#logger.warn('onebot', `[${transport}] ${action} 失败：${message}`);
      return failedResponse(error, echo);
    }
  }

  /** Update cached account state after the driver reports it. */
  updateAccount(status: { online: boolean; uin: string }): void {
    const nextOnline = status.online;
    const nextId = Number(status.uin) || 0;
    const changed = nextOnline !== this.#online;
    this.#online = nextOnline;
    this.#selfId = nextId;
    if (changed) {
      this.#logger.info('onebot', nextOnline ? `账号 ${status.uin} 上线` : '账号离线');
      if (this.#running && this.#config.onebot.events.metaEvent) {
        this.publish(buildLifecycleEvent(nextOnline ? 'enable' : 'disable', this.#eventContext(), {
          online: nextOnline,
          good: nextOnline,
        }));
      }
    }
  }

  #createManager(): NetworkManager {
    const host: NetworkHost = {
      logger: this.#logger,
      config: () => this.#config.onebot,
      selfId: () => this.#selfId,
      online: () => this.#online,
      dispatch: (action, params, echo, transport) => this.dispatch(action, params, echo, transport),
      lifecycle: (subtype) =>
        buildLifecycleEvent(subtype, this.#eventContext(), { online: this.#online, good: this.#online }),
    };
    return new NetworkManager(host, this.#logger, () => this.#config.network);
  }

  #scheduleHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    const interval = this.#config.onebot.heartbeatIntervalMs;
    this.#heartbeat = setInterval(() => {
      if (!this.#config.onebot.events.metaEvent) return;
      this.publish(buildHeartbeatEvent(this.#eventContext(), { online: this.#online, good: this.#online }, interval));
    }, interval);
    this.#heartbeat.unref?.();
  }

  #eventContext() {
    return {
      selfId: () => this.#selfId,
      config: () => this.#config.onebot,
      messageIds: this.messageIds,
    };
  }

  #actionContext() {
    return {
      driver: this.#driver,
      config: this.#config.onebot,
      logger: this.#logger,
      messageIds: this.messageIds,
      messages: this.messages,
      stats: this.#stats,
      selfId: () => this.#selfId,
      online: () => this.#online,
      status: () => this.#driver.status(),
      startedAt: this.#startedAt,
      version: this.#version,
      call: async (name: string, params: Record<string, unknown>) =>
        this.registry.invoke(name, params, this.#actionContext()),
    };
  }

  #remember(event: Ob11EventBase): void {
    this.#eventSeq += 1;
    const { type, summary } = summarise(event);
    const now = new Date();
    const pad = (value: number): string => String(value).padStart(2, '0');
    const record: ConsoleEvent = {
      seq: this.#eventSeq,
      time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      ts: now.getTime(),
      type,
      summary,
    };
    this.#events.push(record);
    if (this.#events.length > EVENT_RING) this.#events.splice(0, this.#events.length - EVENT_RING);
    for (const listener of this.#listeners) {
      try {
        listener(record);
      } catch {
        // A console stream must never break event delivery.
      }
    }
  }
}

/** Short, credential-free description of an event for the console list. */
export function summarise(event: Ob11EventBase): { type: string; summary: string } {
  const post = String(event.post_type);
  if (post === 'message' || post === 'message_sent') {
    const messageType = String(event.message_type ?? 'private');
    const id = messageType === 'group' ? event.group_id : event.user_id;
    const sender = (event.sender ?? {}) as { nickname?: string; user_id?: number };
    const text = previewText(event.message);
    return {
      type: post === 'message_sent' ? `message_sent.${messageType}` : `message.${messageType}`,
      summary: `${sender.nickname || id} → ${text}`,
    };
  }
  if (post === 'meta_event') {
    const kind = String(event.meta_event_type);
    if (kind === 'heartbeat') {
      const status = (event.status ?? {}) as { online?: boolean };
      return { type: 'meta_event.heartbeat', summary: `interval=${event.interval} online=${status.online}` };
    }
    return { type: `meta_event.${kind}`, summary: `sub_type=${event.sub_type}` };
  }
  if (post === 'notice') {
    return {
      type: `notice.${event.notice_type}`,
      summary: [event.group_id, event.user_id, event.operator_id].filter((value) => value !== undefined).join(' · '),
    };
  }
  if (post === 'request') {
    return { type: `request.${event.request_type}`, summary: String(event.comment ?? '') || `flag=${event.flag}` };
  }
  return { type: post, summary: '' };
}

function previewText(message: unknown): string {
  const flatten = (value: unknown): string => {
    if (typeof value === 'string') return value.replace(/\[CQ:[^\]]+\]/g, '');
    if (!Array.isArray(value)) return '';
    return value
      .map((segment) => {
        if (!segment || typeof segment !== 'object') return '';
        const item = segment as { type?: string; data?: { text?: unknown } };
        if (item.type === 'text') return String(item.data?.text ?? '');
        if (item.type === 'face') return '[表情]';
        if (item.type === 'image') return '[图片]';
        if (item.type === 'at') return '@';
        if (item.type === 'record') return '[语音]';
        return `[${item.type ?? '?'}]`;
      })
      .join('');
  };
  const text = flatten(message).replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text || '(空消息)';
}
