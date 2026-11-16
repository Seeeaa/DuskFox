import { createToken, tokenEquals } from '../core/tokens.ts';
import { HttpError } from './http.ts';

interface Session {
  readonly id: string;
  readonly createdAt: number;
  lastSeen: number;
}

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;

/**
 * Opaque console sessions.
 *
 * The admin token is only ever presented to `POST /api/auth/login`; browsers get
 * a random session id that expires after `sessionMinutes` of inactivity. Nothing
 * is signed or stored client side beyond that id, which keeps the console free
 * of JWT dependencies while still supporting idle expiry.
 */
export class Sessions {
  readonly #sessions = new Map<string, Session>();
  readonly #minutes: () => number;

  constructor(minutes: () => number) {
    this.#minutes = minutes;
  }

  get size(): number {
    return this.#sessions.size;
  }

  create(): { token: string; expiresAt: number } {
    const token = createToken(24);
    const now = Date.now();
    this.#sessions.set(token, { id: token, createdAt: now, lastSeen: now });
    return { token, expiresAt: this.#expiryOf(now) };
  }

  /** Validate and refresh a session; expired ids are dropped. */
  touch(token: string): boolean {
    const session = this.#sessions.get(token);
    if (!session) return false;
    const now = Date.now();
    if (this.#isExpired(session, now)) {
      this.#sessions.delete(token);
      return false;
    }
    session.lastSeen = now;
    return true;
  }

  destroy(token: string): void {
    this.#sessions.delete(token);
  }

  /** Drop sessions that idled past the configured window. */
  purge(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (this.#isExpired(session, now)) this.#sessions.delete(id);
    }
  }

  #isExpired(session: Session, now: number): boolean {
    const minutes = this.#minutes();
    if (minutes <= 0) return false;
    return now - session.lastSeen > minutes * 60_000;
  }

  #expiryOf(now: number): number {
    const minutes = this.#minutes();
    return minutes <= 0 ? 0 : now + minutes * 60_000;
  }
}

/** Per address login throttle, keeps brute force cheap to repel. */
export class LoginGuard {
  readonly #failures = new Map<string, { count: number; resetAt: number }>();

  check(address: string): void {
    const entry = this.#failures.get(address);
    if (!entry) return;
    if (Date.now() > entry.resetAt) {
      this.#failures.delete(address);
      return;
    }
    if (entry.count >= MAX_FAILURES) {
      throw new HttpError(429, '尝试次数过多，请稍后再试');
    }
  }

  fail(address: string): void {
    const now = Date.now();
    const entry = this.#failures.get(address);
    if (!entry || now > entry.resetAt) {
      this.#failures.set(address, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  success(address: string): void {
    this.#failures.delete(address);
  }
}

/** True when `supplied` is the configured admin token. */
export function isAdminToken(supplied: string, admin: string): boolean {
  if (!supplied) return false;
  return tokenEquals(supplied, admin);
}

/** Pull a bearer token from headers or the `token` query parameter. */
export function extractToken(headers: Record<string, string | string[] | undefined>, url: URL): string {
  const header = headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const bearer = value?.replace(/^Bearer\s+/i, '').trim() ?? '';
  if (bearer) return bearer;
  return (url.searchParams.get('token') ?? url.searchParams.get('access_token') ?? '').trim();
}
