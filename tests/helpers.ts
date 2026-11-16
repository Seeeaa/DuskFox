import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/app.ts';
import type { DriverOptions } from '../src/driver/types.ts';

export const TEST_TOKEN = 'test-token-0123456789';

export interface InstanceOptions {
  readonly driver?: string;
  readonly driverOptions?: DriverOptions;
  readonly plugins?: Record<string, string>;
  readonly onebot?: Record<string, unknown>;
}

export interface ApiResult<T = any> {
  readonly status: number;
  readonly json: T;
}

export interface Instance {
  readonly app: Application;
  readonly base: string;
  readonly root: string;
  readonly session: string;
  /** Console API call, authenticated with the session token by default. */
  call<T = any>(method: string, pathname: string, body?: unknown, authenticated?: boolean): Promise<ApiResult<T>>;
  /** Absolute base URL for the first connection of a kind, once it listens. */
  connectionUrl(kind: string): string;
  stop(): Promise<void>;
}

const EMPTY_NETWORK = { 'http-server': [], 'http-client': [], sse: [], 'ws-server': [], 'ws-client': [] };

/**
 * Boot a full instance in a throwaway work directory.
 *
 * The network section starts empty so parallel test files never fight over the
 * default port; a test that needs a listener adds it and uses port 0.
 */
export async function startInstance(options: InstanceOptions = {}): Promise<Instance> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duskfox-test-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'webui.json'),
    JSON.stringify({ host: '127.0.0.1', port: 0, token: TEST_TOKEN, sessionMinutes: 120, allowlist: [] }),
  );
  fs.writeFileSync(path.join(configDir, 'network.json'), JSON.stringify(EMPTY_NETWORK));
  if (options.onebot) fs.writeFileSync(path.join(configDir, 'onebot.json'), JSON.stringify(options.onebot));
  for (const [name, content] of Object.entries(options.plugins ?? {})) {
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(root, 'plugins', name), content);
  }

  const app = new Application({
    root,
    driver: options.driver ?? 'mock',
    driverOptions: options.driverOptions ?? { autoLogin: false, simulate: false },
    logLevel: 'error',
  });
  await app.start();
  const base = `http://127.0.0.1:${app.address.port}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TEST_TOKEN }),
  });
  const loginJson = (await login.json()) as { token?: string };
  if (!loginJson.token) throw new Error('测试登录失败');

  const instance: Instance = {
    app,
    base,
    root,
    session: loginJson.token,
    async call<T = any>(method: string, pathname: string, body?: unknown, authenticated = true) {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (authenticated) headers.authorization = `Bearer ${instance.session}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${base}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: response.status, json: json as T };
    },
    connectionUrl(kind: string) {
      const info = instance.app.service.connections().find((connection) => connection.kind === kind);
      if (!info?.address) throw new Error(`${kind} 尚未监听`);
      return info.address;
    },
    async stop() {
      await app.stop();
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // Windows may keep a log handle briefly; the temp dir is disposable.
      }
    },
  };
  return instance;
}

/** Wait until `predicate` is true or the timeout elapses. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('等待条件超时');
}

export function rawCall(base: string, method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
