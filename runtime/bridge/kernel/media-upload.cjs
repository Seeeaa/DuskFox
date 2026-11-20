'use strict';
/** Explicit domain instance. Shared data lives in ctx.state; cross-domain calls use ctx.kernel. */
const { ELEMENT_PIC, ELEMENT_FILE, ELEMENT_PTT, ELEMENT_VIDEO, SILK_WAVE, shortOf } = require('./shared.cjs');
const { materializeImage, materializeMediaFile, ensureSilk, materializeAudio, imageSizeOf } = require('./media-files.cjs');

class MediaUploadDomain {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /**
     * 图片发送：把文件按客户端的 RichMedia 约定复制到它要求的路径，再发 picElement。
     * 与 NapCat 的做法一致（md5 + getRichMediaFilePathForGuild + copy）。
     * 【待实机验证】字段齐全性（picWidth/picHeight/picType/picSubType）与复制目录。
     */
  async buildPicElement(rawFile) {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const file = await materializeImage(rawFile);
    if (!file || !fs.existsSync(file)) throw new Error('图片文件不存在：' + shortOf(rawFile));
    const buffer = fs.readFileSync(file);
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const fileName = path.basename(file);
    const fileSize = buffer.length;
    const extension = path.extname(fileName).toLowerCase();
    // 与 NC 一致：非 gif 一律用 NEWPIC_JPEG(1000)，不是按扩展名细分。
    const picType = extension === '.gif' ? 2000 : 1000;
    const size = imageSizeOf(buffer);
    const service = this.ctx.state.msgService || (this.ctx.state.session && this.ctx.state.session.getMsgService());
    if (!service || typeof service.getRichMediaFilePathForGuild !== 'function') {
      throw new Error('客户端未提供 RichMedia 路径接口，图片发送待实机验证');
    }
    const mediaPath = service.getRichMediaFilePathForGuild({
      md5HexStr: md5,
      fileName,
      elementType: ELEMENT_PIC,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.copyFileSync(file, mediaPath);
    return {
      elementType: ELEMENT_PIC,
      elementId: '',
      picElement: {
        md5HexStr: md5,
        fileSize: String(fileSize),
        picWidth: size.width,
        picHeight: size.height,
        fileName,
        sourcePath: mediaPath,
        original: true,
        picType,
        picSubType: 0,
        fileUuid: '',
        fileSubId: '',
        thumbFileSize: 0,
        summary: '',
      },
    };
  }

  /**
     * 语音发送：与图片同一条 RichMedia 路径（md5 + getRichMediaFilePathForGuild + 复制），
     * 元素换成 pttElement。
     * 【待实机验证】pttElement 的必需字段（duration/formatType/fileUuid）与 QQ 是否接受
     * 非 silk/amr 编码；未确认前 sendSegments 默认不含 record。
     */
  async buildPttElement(rawFile, duration = 0) {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const source = await materializeAudio(rawFile);
    if (!source || !fs.existsSync(source)) throw new Error('语音文件不存在：' + shortOf(rawFile));
    // QQ 只接受 silk 编码，非 silk 先用 ffmpeg 转（与 NapCat 的 encodeSilk 一致）。
    const silk = await ensureSilk(source);
    const buffer = fs.readFileSync(silk);
    if (!(Number(duration) > 0)) {
      let offset = buffer[0] === 2 ? 10 : 9;
      let frames = 0;
      while (offset + 2 <= buffer.length) {
        const size = buffer.readInt16LE(offset);
        offset += 2;
        if (size <= 0 || offset + size > buffer.length) break;
        offset += size;
        frames++;
      }
      duration = Math.max(1, Math.ceil(frames / 50));
    }
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const fileName = path.basename(silk);
    const service = this.ctx.state.msgService || (this.ctx.state.session && this.ctx.state.session.getMsgService());
    if (!service || typeof service.getRichMediaFilePathForGuild !== 'function') {
      throw new Error('客户端未提供 RichMedia 路径接口，语音发送待实机验证');
    }
    const mediaPath = service.getRichMediaFilePathForGuild({
      md5HexStr: md5,
      fileName,
      elementType: ELEMENT_PTT,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.copyFileSync(silk, mediaPath);
    return {
      elementType: ELEMENT_PTT,
      elementId: '',
      // 字段集合参照 NapCat createValidSendPttElement 的实机值。
      // 【待实机验证】duration/voiceType/waveAmplitudes 等是否被客户端严格校验。
      pttElement: {
        fileName,
        filePath: mediaPath,
        md5HexStr: md5,
        fileSize: String(buffer.length),
        duration: Math.ceil(Number(duration)),
        formatType: 1,
        voiceType: 1,
        voiceChangeType: 0,
        canConvert2Text: true,
        waveAmplitudes: [...SILK_WAVE],
        fileSubId: '',
        fileUuid: '',
        playState: 1,
        autoConvertText: 0,
        storeID: 0,
        otherBusinessInfo: { aiVoiceType: 0 },
      },
    };
  }

  /**
     * 文件发送：FileApi.uploadFile(path, ElementType.FILE) 的等价实现——
     * md5 + getRichMediaFilePathForGuild + copyFile，再发 fileElement。
     * 字段取自 NapCat 的 FileElement 定义（fileMd5/fileName/filePath/fileSize）。
     * 【待实机验证】私聊场景是否同样接受 ForGuild 路径。
     */
  async buildFileElement(rawFile, rawName) {
    const uploaded = await this.uploadForRichMedia(rawFile, ELEMENT_FILE, rawName, '.bin');
    return {
      elementType: ELEMENT_FILE,
      elementId: '',
      fileElement: {
        fileName: uploaded.fileName,
        filePath: uploaded.mediaPath,
        fileSize: String(uploaded.size),
        fileMd5: uploaded.md5,
      },
    };
  }

  /**
     * 视频发送：VideoApi.createValidSendVideoElement 的等价实现。
     * 字段取自 VideoElement（fileName/filePath/fileSize/videoMd5/fileTime/fileFormat）。
     * duration 用调用方给的真实值，拿不到就写 0，不编造。
     * 【待实机验证】fileFormat 是否必须为 2(mp4)、缩略图是否必需。
     */
  async buildVideoElement(rawFile, rawName, duration) {
    const uploaded = await this.uploadForRichMedia(rawFile, ELEMENT_VIDEO, rawName, '.mp4');
    return {
      elementType: ELEMENT_VIDEO,
      elementId: '',
      videoElement: {
        fileName: uploaded.fileName,
        filePath: uploaded.mediaPath,
        fileSize: String(uploaded.size),
        videoMd5: uploaded.md5,
        fileTime: Number(duration) || 0,
        fileFormat: 2,
      },
    };
  }

  /**
     * 文件/视频共用的 RichMedia 落盘：算 md5 → 问客户端要路径 → 复制过去。
     * 与图片/语音走的是同一个 getRichMediaFilePathForGuild 接口。
     */
  async uploadForRichMedia(rawFile, elementType, rawName, fallbackExt) {
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const source = await materializeMediaFile(rawFile, fallbackExt);
    if (!source || !fs.existsSync(source)) throw new Error('文件不存在：' + shortOf(rawFile));
    const buffer = fs.readFileSync(source);
    const md5 = crypto.createHash('md5').update(buffer).digest('hex');
    const fileName = rawName || path.basename(source);
    const service = this.ctx.state.msgService || (this.ctx.state.session && this.ctx.state.session.getMsgService());
    if (!service || typeof service.getRichMediaFilePathForGuild !== 'function') {
      throw new Error('客户端未提供 RichMedia 路径接口，文件/视频发送待实机验证');
    }
    const mediaPath = service.getRichMediaFilePathForGuild({
      md5HexStr: md5,
      fileName,
      elementType,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    fs.mkdirSync(path.dirname(mediaPath), { recursive: true });
    fs.copyFileSync(source, mediaPath);
    return { md5, fileName, mediaPath, size: buffer.length };
  }
}

module.exports = { MediaUploadDomain };
