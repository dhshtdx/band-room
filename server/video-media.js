import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

export class VideoMediaError extends Error {
  constructor(message = '视频文件信息无效') {
    super(message);
    this.name = 'VideoMediaError';
  }
}

export class RangeNotSatisfiableError extends Error {
  constructor() {
    super('请求的视频范围无效');
    this.name = 'RangeNotSatisfiableError';
  }
}

const MEDIA_TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.webm', 'video/webm'],
]);

export function validateVideoDescriptor({ fileName, mimeType, contentLength } = {}) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw new VideoMediaError('视频文件名无效');
  }
  const normalizedName = path.basename(fileName);
  const extension = path.extname(normalizedName).toLowerCase();
  const expectedMimeType = MEDIA_TYPES.get(extension);
  if (!expectedMimeType) throw new VideoMediaError('不支持的视频格式');
  if (mimeType !== expectedMimeType) {
    throw new VideoMediaError('视频格式与文件类型不匹配');
  }
  if (contentLength !== undefined && (!Number.isSafeInteger(contentLength) || contentLength <= 0 || contentLength > MAX_VIDEO_BYTES)) {
    throw new VideoMediaError('视频文件大小无效');
  }
  return {
    fileName: normalizedName,
    extension,
    mimeType: expectedMimeType,
    ...(contentLength === undefined ? {} : { contentLength }),
  };
}

export function hasValidVideoSignature(mimeType, headerBytes) {
  if (!(Buffer.isBuffer(headerBytes) || headerBytes instanceof Uint8Array)) return false;
  if (mimeType === 'video/mp4') {
    return headerBytes.length >= 8 && headerBytes[4] === 0x66 && headerBytes[5] === 0x74 && headerBytes[6] === 0x79 && headerBytes[7] === 0x70;
  }
  if (mimeType === 'video/webm') return headerBytes.length >= 4 && headerBytes[0] === 0x1a && headerBytes[1] === 0x45 && headerBytes[2] === 0xdf && headerBytes[3] === 0xa3;
  return false;
}

export function parseSingleRange(rangeHeader, size) {
  if (rangeHeader === undefined || rangeHeader === null) return null;
  if (!Number.isSafeInteger(size) || size <= 0 || typeof rangeHeader !== 'string') {
    throw new RangeNotSatisfiableError();
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match || (!match[1] && !match[2])) throw new RangeNotSatisfiableError();

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) throw new RangeNotSatisfiableError();
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) {
      throw new RangeNotSatisfiableError();
    }
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

export async function streamVideoUpload({ request, temporaryPath, maxBytes = MAX_VIDEO_BYTES }) {
  let size = 0;
  let headerBytes = Buffer.alloc(0);
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) {
        callback(Object.assign(new VideoMediaError('视频文件不能超过 2 GiB。'), { statusCode: 413 }));
        return;
      }
      if (headerBytes.length < 8) headerBytes = Buffer.concat([headerBytes, chunk.subarray(0, 8 - headerBytes.length)]);
      callback(null, chunk);
    },
    flush(callback) {
      callback(size ? null : Object.assign(new VideoMediaError('视频文件不能为空。'), { statusCode: 400 }));
    },
  });
  const abort = (error) => counter.destroy(error instanceof Error ? error : new VideoMediaError('视频上传已中断。'));
  request.on('aborted', abort);
  request.on('error', abort);
  try {
    const completed = pipeline(counter, createWriteStream(temporaryPath, { flags: 'wx' }));
    request.pipe(counter);
    if (request.aborted || request.destroyed) abort();
    await completed;
    return { size, headerBytes };
  } catch (error) {
    request.unpipe(counter);
    request.resume();
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    request.off('aborted', abort);
    request.off('error', abort);
  }
}
