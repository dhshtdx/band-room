import path from 'node:path';

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
  if (mimeType !== expectedMimeType && mimeType !== 'application/octet-stream') {
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
  if (!Buffer.isBuffer(headerBytes)) return false;
  if (mimeType === 'video/mp4') return headerBytes.length >= 8 && headerBytes.toString('ascii', 4, 8) === 'ftyp';
  if (mimeType === 'video/webm') return headerBytes.length >= 4 && headerBytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
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
