import fs from 'node:fs';
import path from 'node:path';
import type { Router } from '../http.ts';
import { HttpError, sendJson } from '../http.ts';
import type { WebuiContext } from '../context.ts';
import { resolveWithin } from '../../core/paths.ts';

const PREVIEW_LIMIT = 256 * 1024;

interface Entry {
  readonly name: string;
  readonly type: 'dir' | 'file' | 'symlink';
  readonly size: number;
  readonly mtime: number;
}

/** 存放凭据的文件：这些内容一旦在线预览就会泄露，必须始终拒绝。 */
export function isSensitive(relativePath: string): boolean {
  const value = relativePath.replace(/^\/+/, '');
  return (
    value === 'config/webui.json' ||
    // notify.json 存 SMTP 授权码，network.json 含外发端点等信息。
    value === 'config/notify.json' ||
    value === 'config/network.json' ||
    /(^|\/)admin\.token$/.test(value) ||
    /(^|\/)\.env$/.test(value) ||
    /(^|\/)onebot\.token$/.test(value)
  );
}

/** Read-only browser for the instance work directory. */
export function registerFileRoutes(router: Router, context: WebuiContext): void {
  router.get('/api/files', async ({ res, url }) => {
    const requested = url.searchParams.get('path') ?? '/';
    const absolute = resolveWithin(context.paths.root, requested);
    if (!absolute) throw new HttpError(400, '路径越界');
    if (!fs.existsSync(absolute)) throw new HttpError(404, '目录不存在');
    const stat = fs.statSync(absolute);
    if (!stat.isDirectory()) throw new HttpError(400, '不是目录');
    const entries: Entry[] = [];
    for (const dirent of fs.readdirSync(absolute, { withFileTypes: true })) {
      const full = path.join(absolute, dirent.name);
      let size = 0;
      let mtime = 0;
      let type: Entry['type'] = dirent.isDirectory() ? 'dir' : dirent.isSymbolicLink() ? 'symlink' : 'file';
      try {
        const info = fs.lstatSync(full);
        size = info.isDirectory() ? 0 : info.size;
        mtime = info.mtimeMs;
        if (info.isSymbolicLink()) type = 'symlink';
      } catch {
        continue;
      }
      entries.push({ name: dirent.name, type, size, mtime });
    }
    entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === 'dir' ? -1 : right.type === 'dir' ? 1 : 0;
      return left.name.localeCompare(right.name);
    });
    const relative = path.relative(context.paths.root, absolute).split(path.sep).join('/');
    sendJson(res, 200, {
      root: context.paths.root,
      path: relative ? `/${relative}` : '/',
      entries,
    });
  });

  router.get('/api/files/read', async ({ res, url }) => {
    const requested = url.searchParams.get('path');
    if (!requested) throw new HttpError(400, '缺少 path 参数');
    const absolute = resolveWithin(context.paths.root, requested);
    if (!absolute) throw new HttpError(400, '路径越界');
    // The console token lives in config/webui.json; previewing it would leak
    // the credential into the browser and every proxy log on the way.
    const relative = path.relative(context.paths.root, absolute).split(path.sep).join('/');
    if (isSensitive(relative)) throw new HttpError(403, '该文件包含凭据，禁止在线预览');
    if (!fs.existsSync(absolute)) throw new HttpError(404, '文件不存在');
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new HttpError(400, '不是文件');
    if (stat.size > 4 * 1024 * 1024) throw new HttpError(413, '文件过大（上限 4 MB）');
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) throw new HttpError(415, '二进制文件不支持预览');
    const text = buffer.toString('utf8');
    const truncated = text.length > PREVIEW_LIMIT;
    sendJson(res, 200, {
      path: `/${path.relative(context.paths.root, absolute).split(path.sep).join('/')}`,
      size: stat.size,
      text: truncated ? text.slice(0, PREVIEW_LIMIT) : text,
      truncated,
    });
  });
}
