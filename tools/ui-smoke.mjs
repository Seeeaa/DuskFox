import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const file = path.resolve(import.meta.dirname, '../webui/index.html');
const html = fs.readFileSync(file, 'utf8');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
assert.ok(scripts.length > 0, 'WebUI has no scripts');
for (const [index, script] of scripts.entries()) {
  new vm.Script(script[1], { filename: `webui/inline-${index + 1}.js` });
}
const pages = ['overview', 'account', 'network', 'onebot', 'debug', 'logs', 'files', 'settings', 'about'];
for (const page of pages) {
  assert.match(html, new RegExp(`P\\.${page}\\s*=`), `missing ${page} page`);
}
assert.match(html, /\/api\/auth\/login/, 'missing login endpoint');
assert.match(html, /\/api\/qr/, 'missing QR endpoint');
process.stdout.write(`WebUI static check passed: ${scripts.length} scripts, ${pages.length} pages\n`);
