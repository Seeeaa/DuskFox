'use strict';
const { shortOf } = require('./shared.cjs');
let lastMediaPruneAt = 0;

function mediaTmpDir() {
  const os = require('node:os');
  const path = require('node:path');
  return path.join(os.tmpdir(), 'duskfox-media');
}

function guessExt(buffer) {
  if (buffer.length > 8 && buffer.readUInt32BE(0) === 0x89504e47) return '.png';
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg';
  if (buffer.length > 6 && buffer.toString('latin1', 0, 4) === 'GIF8') return '.gif';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  if (buffer.length > 12 && buffer.toString('latin1', 0, 4) === 'RIFF' && buffer.toString('latin1', 8, 12) === 'WAVE') return '.wav';
  if (buffer.length > 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return '.bmp';
  // 语音：QQ 侧常见 amr（#!AMR）、silk（#!SILK_V3）与 mp3。
  if (buffer.length > 6 && buffer.toString('latin1', 0, 6) === '#!AMR\n') return '.amr';
  if (buffer.length > 9 && buffer.toString('latin1', 0, 9) === '#!SILK_V3') return '.silk';
  if (buffer.length > 10 && buffer.toString('latin1', 1, 10) === '#!SILK_V3') return '.silk';
  if (buffer.length > 12 && buffer.toString('latin1', 4, 8) === 'ftyp') return '.mp4';
  if (buffer.length > 3 && buffer.toString('latin1', 0, 3) === 'ID3') return '.mp3';
  if (buffer.length > 2 && buffer[0] === 0xff && (buffer[1] === 0xfb || buffer[1] === 0xf3 || buffer[1] === 0xf2)) return '.mp3';
  if (buffer.length > 4 && buffer.toString('latin1', 0, 4) === 'OggS') return '.ogg';
  return '.bin';
}

/** 临时图片目录按 md5 命名（同一张图只存一份），并按小时清理，避免长期堆积。 */
function pruneMediaDir(dir) {
  const now = Date.now();
  if (now - lastMediaPruneAt < 10 * 60_000) return;
  lastMediaPruneAt = now;
  const fs = require('node:fs');
  const path = require('node:path');
  try {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        if (now - fs.statSync(full).mtimeMs > 2 * 3600_000) fs.rmSync(full, { force: true });
      } catch (error) { /* 单文件失败忽略 */ }
    }
  } catch (error) { /* 目录不可读时忽略 */ }
}

/**
 * OneBot v11 的图片 file 有三种常见形态：本地路径、file:// URL、base64:// 负载。
 * AstrBot 默认把图片编码成 base64://，这里解码落地成临时文件，走后面的 RichMedia 流程。
 */
async function materializeImage(raw) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const value = String(raw ?? '').trim();
  if (!value) return '';

  // http(s) 链接：AstrBot 的图片插件（pixiv 等）给的就是外链，必须自己下载。
  if (/^https?:\/\//i.test(value)) {
    return saveMediaBuffer(await downloadMedia(value, 'image'));
  }
  if (value.startsWith('file://')) {
    return decodeURIComponent(value.slice('file://'.length));
  }
  if (!value.startsWith('base64://') && !(value.startsWith('data:') && value.includes(';base64,'))) {
    return value;
  }

  let payload = '';
  if (value.startsWith('base64://')) {
    payload = value.slice('base64://'.length);
  } else {
    payload = value.slice(value.indexOf(';base64,') + ';base64,'.length);
  }
  const cleaned = payload.replace(/\s+/g, '');
  if (!cleaned) throw new Error('图片 base64 数据为空');
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) throw new Error('图片 base64 解码失败：' + shortOf(cleaned));
  return saveMediaBuffer(buffer);
}

/**
 * 文件/视频素材落地：本地路径、file://、base64://、data: 四种形态。
 * http(s) 暂不支持——发文件要先有本地字节，避免把远端内容当可信输入。
 */
async function materializeMediaFile(raw, fallbackExt = '.bin') {
  const fs = require('node:fs');
  const path = require('node:path');
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) {
    throw new Error('暂不支持从 URL 直接发送文件/视频，请给本地路径或 base64:// 载荷');
  }
  if (value.startsWith('file://')) return decodeURIComponent(value.slice('file://'.length));
  if (!value.startsWith('base64://') && !(value.startsWith('data:') && value.includes(';base64,'))) return value;
  const payload = value.startsWith('base64://')
    ? value.slice('base64://'.length)
    : value.slice(value.indexOf(';base64,') + ';base64,'.length);
  const cleaned = payload.replace(/\s+/g, '');
  if (!cleaned) throw new Error('文件 base64 数据为空');
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) throw new Error('文件 base64 解码失败：' + shortOf(cleaned));
  const dir = mediaTmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'media-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + fallbackExt);
  fs.writeFileSync(target, buffer);
  return target;
}

/**
 * QQ 语音只接受 silk（ntsilk_s16le，24kHz 单声道）。已经是 silk 就直接用，
 * 否则调 ffmpeg 转一次；面板/机器人常给 mp3、wav、amr，都必须转。
 * ffmpeg 需要在 PATH 里，或用 QQ_BRIDGE_FFMPEG 指定可执行文件。
 * 【待实机验证】转码参数与 QQ 客户端的接受度。
 */
async function ensureSilk(source) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const execute = promisify(execFile);
  const buffer = fs.readFileSync(source);
  if (buffer.toString('latin1', 0, 9) === '#!SILK_V3' || buffer.toString('latin1', 1, 10) === '#!SILK_V3') return source;
  const dir = mediaTmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'ptt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.silk');
  const ffmpeg = process.env.QQ_BRIDGE_FFMPEG || 'ffmpeg';
  const options = { timeout: 30000, windowsHide: true };
  try {
    await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
      '-ac', '1', '-ar', '24000', '-c:a', 'ntsilk_s16le', '-f', 'ntsilk_s16le', target], options);
  } catch (nativeError) {
    // Debian ffmpeg lacks Tencent's encoder; reuse pysilk after producing 24k s16le PCM.
    const pcm = target + '.pcm';
    try {
      await execute(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source,
        '-ac', '1', '-ar', '24000', '-acodec', 'pcm_s16le', '-f', 's16le', pcm], options);
      const python = process.env.QQ_BRIDGE_SILK_PYTHON || 'python3';
      const script = [
        'import io,sys,pysilk',
        'raw=open(sys.argv[1],"rb").read()',
        'out=io.BytesIO()',
        'pysilk.encode(io.BytesIO(raw),out,24000,24000,tencent=True)',
        'open(sys.argv[2],"wb").write(out.getvalue())',
      ].join('\n');
      await execute(python, ['-c', script, pcm, target], options);
    } catch (error) {
      throw new Error('语音编码失败：ntsilk_s16le=' + String(nativeError.stderr || nativeError.message) +
        '；pysilk=' + String(error.stderr || error.message));
    } finally {
      fs.rmSync(pcm, { force: true });
    }
  }
  if (!fs.existsSync(target) || !fs.statSync(target).size) throw new Error('语音转 silk 后为空：' + shortOf(source));
  return target;
}

/**
 * 外链媒体下载：15 秒超时、12MB 上限。
 * 图片与语音共用这一条路径，`kind` 只决定提示文案和允许的内容类型。
 */
async function downloadMedia(url, kind, timeoutMs = 60_000) {
  const audio = kind === 'record';
  const label = ({ record: '语音', image: '图片', video: '视频', file: '文件' })[kind] || '媒体';
  const accept = kind === 'file' ? '*/*' : (audio ? 'audio/*,*/*;q=0.8' : kind + '/*,*/*;q=0.8');
  const MAX_BYTES = Number(process.env.QQ_BRIDGE_MEDIA_MAX_BYTES) || 256 * 1024 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(timeoutMs, 60_000)));
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (duskfox)', accept },
    });
    if (!response.ok) throw new Error('下载' + label + '失败：HTTP ' + response.status);
    const type = String(response.headers.get('content-type') || '').toLowerCase();
    const ok = kind === 'file' || type.startsWith((audio ? 'audio' : kind) + '/');
    if (type && !ok && !type.includes('octet-stream')) {
      throw new Error('链接不是' + label + '：' + type);
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error(label + '过大：' + declared + ' 字节');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error(label + '过大：超过 ' + MAX_BYTES + ' 字节');
      chunks.push(Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks, size);
    if (buffer.length === 0) throw new Error('下载到的' + label + '为空');
    if (buffer.length > MAX_BYTES) throw new Error(label + '过大：' + buffer.length + ' 字节');
    return buffer;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('下载' + label + '超时：' + shortOf(url));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 语音文件落地：与图片共用「本地路径 / file:// / base64:// / data:」四种形态，
 * 外链改走音频类型校验，落盘扩展名由音频魔数决定（amr/silk/mp3/wav/ogg）。
 */
async function materializeAudio(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return saveMediaBuffer(await downloadMedia(value, 'record'));
  if (value.startsWith('file://')) return decodeURIComponent(value.slice('file://'.length));
  if (!value.startsWith('base64://') && !(value.startsWith('data:') && value.includes(';base64,'))) return value;
  const payload = value.startsWith('base64://')
    ? value.slice('base64://'.length)
    : value.slice(value.indexOf(';base64,') + ';base64,'.length);
  const cleaned = payload.replace(/\s+/g, '');
  if (!cleaned) throw new Error('语音 base64 数据为空');
  const buffer = Buffer.from(cleaned, 'base64');
  if (buffer.length === 0) throw new Error('语音 base64 解码失败：' + shortOf(cleaned));
  return saveMediaBuffer(buffer);
}

/** 图片落盘：按内容 md5 命名，供 RichMedia 复制使用。 */
function saveMediaBuffer(buffer) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const dir = mediaTmpDir();
  fs.mkdirSync(dir, { recursive: true });
  pruneMediaDir(dir);
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  const target = path.join(dir, md5 + guessExt(buffer));
  if (!fs.existsSync(target)) fs.writeFileSync(target, buffer);
  return target;
}

/** Minimal PNG/JPEG/GIF dimension reader; returns 0x0 for unknown formats. */
function imageSizeOf(buffer) {
  if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length > 10 && buffer.toString('latin1', 0, 4) === 'GIF8') {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length - 9) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return { width: 0, height: 0 };
}

module.exports = { mediaTmpDir, guessExt, pruneMediaDir, materializeImage, materializeMediaFile, ensureSilk, downloadMedia, materializeAudio, saveMediaBuffer, imageSizeOf };
