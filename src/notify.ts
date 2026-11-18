import path from 'node:path';
import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { Type, type Static } from '@sinclair/typebox';
import { normalise, writeJsonAtomic } from './core/config.ts';
import type { Logger } from './core/logger.ts';

const Schema = Type.Object({
  host: Type.String({ default: '' }),
  port: Type.Integer({ default: 465, minimum: 1, maximum: 65535 }),
  secure: Type.Boolean({ default: true }),
  username: Type.String({ default: '' }),
  password: Type.String({ default: '' }),
  from: Type.String({ default: '' }),
  to: Type.String({ default: '' }),
  online: Type.Boolean({ default: false }),
  offline: Type.Boolean({ default: false }),
  error: Type.Boolean({ default: false }),
});

type Settings = Static<typeof Schema>;
const defaults = (): Settings => normalise(Schema, {});

export class SmtpNotifications {
  readonly #file: string;
  readonly #logger: Logger;
  #settings: Settings;
  #lastOnline: boolean | null = null;
  #offlineTimer: NodeJS.Timeout | null = null;
  #lastErrorAt = 0;

  constructor(configDir: string, logger: Logger) {
    this.#file = path.join(configDir, 'notify.json');
    this.#logger = logger;
    this.#settings = fs.existsSync(this.#file)
      ? normalise(Schema, JSON.parse(fs.readFileSync(this.#file, 'utf8')))
      : defaults();
    if (!fs.existsSync(this.#file)) writeJsonAtomic(this.#file, this.#settings);
  }

  publicSettings(): Omit<Settings, 'password'> & { passwordConfigured: boolean } {
    const { password, ...rest } = this.#settings;
    return { ...rest, passwordConfigured: Boolean(password) };
  }

  update(input: Record<string, unknown>): void {
    const password = input.password ? String(input.password) : this.#settings.password;
    const next = normalise(Schema, { ...this.#settings, ...input, password });
    this.#settings = next;
    writeJsonAtomic(this.#file, next);
    this.#logger.info('notify', '邮件通知配置已保存');
  }

  async test(): Promise<void> {
    await this.#send('DuskFox 测试邮件', 'SMTP 配置可用。此邮件由控制台手动发送。');
  }

  state(online: boolean): void {
    if (this.#lastOnline === null) {
      this.#lastOnline = online;
      return;
    }
    if (this.#lastOnline === online) return;
    this.#lastOnline = online;
    if (this.#offlineTimer) clearTimeout(this.#offlineTimer);
    this.#offlineTimer = null;
    if (online) {
      if (this.#settings.online) void this.#deliver('账号上线', 'QQ 消息会话已连接。');
      return;
    }
    if (this.#settings.offline) {
      this.#offlineTimer = setTimeout(() => {
        if (!this.#lastOnline) void this.#deliver('账号掉线', 'QQ 消息会话已断开超过 30 秒。');
      }, 30_000);
      this.#offlineTimer.unref?.();
    }
  }

  runtimeError(message: string): void {
    if (!this.#settings.error || Date.now() - this.#lastErrorAt < 600_000) return;
    this.#lastErrorAt = Date.now();
    void this.#deliver('运行错误', message.slice(0, 500));
  }

  stop(): void {
    if (this.#offlineTimer) clearTimeout(this.#offlineTimer);
    this.#offlineTimer = null;
  }

  async #deliver(subject: string, content: string): Promise<void> {
    try {
      await this.#send(`DuskFox · ${subject}`, content);
      this.#logger.info('notify', `${subject}邮件已发送`);
    } catch (error) {
      this.#logger.warn('notify', `${subject}邮件发送失败：${mailErrorCode(error)}`);
    }
  }

  async #send(subject: string, content: string): Promise<void> {
    const s = this.#settings;
    if (!s.host || !s.to || !s.from || !s.username || !s.password) {
      throw new Error('请填写 SMTP 主机、发件人、收件人、账号和授权码');
    }
    const transport = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      requireTLS: !s.secure,
      auth: { user: s.username, pass: s.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    });
    await transport.sendMail({ from: s.from, to: s.to, subject, text: `${content}\n\n时间：${new Date().toISOString()}` });
  }
}

export function mailErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return 'SMTP_ERROR';
}
