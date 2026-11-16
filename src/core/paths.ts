import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Absolute locations of every directory an instance writes to. */
export interface RuntimePaths {
  /** Instance work directory (everything below belongs to this instance). */
  readonly root: string;
  /** JSON configuration files. */
  readonly config: string;
  /** Rolling text logs. */
  readonly logs: string;
  /** QR codes, avatars and other disposable artifacts. */
  readonly cache: string;
  /** Driver-owned persistent data (sessions, databases). */
  readonly data: string;
  /** Drop-in plugin modules. */
  readonly plugins: string;
  /** Built-in console assets. */
  readonly webui: string;
}

const SUBDIRS = ['config', 'logs', 'cache', 'data', 'plugins'] as const;

/**
 * Resolve the instance work directory.
 *
 * Order: explicit argument -> DUSKFOX_WORKDIR -> ~/.duskfox.
 * Keeping a single, platform independent root makes Linux and Windows behave
 * identically and lets several instances coexist by pointing at different dirs.
 */
export function resolveRoot(explicit?: string): string {
  const candidate = explicit?.trim() || process.env.DUSKFOX_WORKDIR?.trim();
  if (candidate) return path.resolve(candidate);
  return path.join(os.homedir(), '.duskfox');
}

export function resolvePaths(explicitRoot?: string, webuiDir?: string): RuntimePaths {
  const root = resolveRoot(explicitRoot);
  const paths: RuntimePaths = {
    root,
    config: path.join(root, 'config'),
    logs: path.join(root, 'logs'),
    cache: path.join(root, 'cache'),
    data: path.join(root, 'data'),
    plugins: path.join(root, 'plugins'),
    webui: webuiDir ?? path.resolve(import.meta.dirname, '../../webui'),
  };
  return paths;
}

/** Create every directory the instance needs. Safe to call repeatedly. */
export function ensureDirectories(paths: RuntimePaths): void {
  fs.mkdirSync(paths.root, { recursive: true });
  for (const name of SUBDIRS) fs.mkdirSync(path.join(paths.root, name), { recursive: true });
}

/** True when `child` is `root` or lives below it (after normalisation). */
export function isWithin(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve a client supplied path inside `root` and refuse traversal.
 * Returns the absolute path or null when the request escapes the sandbox.
 */
export function resolveWithin(root: string, requested: string): string | null {
  if (requested.includes('\u0000')) return null;
  const normalised = requested.replace(/\\/g, '/').replace(/^\/+/, '');
  const absolute = path.resolve(root, normalised);
  return isWithin(root, absolute) ? absolute : null;
}

/** Human readable size used by the console. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
