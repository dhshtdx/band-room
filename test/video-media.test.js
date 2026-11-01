import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_VIDEO_BYTES,
  VideoMediaError,
  RangeNotSatisfiableError,
  validateVideoDescriptor,
  hasValidVideoSignature,
  parseSingleRange,
} from '../server/video-media.js';

test('normalizes supported MP4 and WebM descriptors, including unknown length', () => {
  assert.equal(MAX_VIDEO_BYTES, 2 * 1024 * 1024 * 1024);
  assert.deepEqual(validateVideoDescriptor({ fileName: '/tmp/rehearsal.MP4', mimeType: 'video/mp4', contentLength: 12 }), {
    fileName: 'rehearsal.MP4', extension: '.mp4', mimeType: 'video/mp4', contentLength: 12,
  });
  assert.deepEqual(validateVideoDescriptor({ fileName: 'take.webm', mimeType: 'application/octet-stream' }), {
    fileName: 'take.webm', extension: '.webm', mimeType: 'video/webm',
  });
});

test('parses full, open-ended, and suffix byte ranges', () => {
  assert.deepEqual(parseSingleRange('bytes=0-3', 10), { start: 0, end: 3, length: 4 });
  assert.deepEqual(parseSingleRange('bytes=4-', 10), { start: 4, end: 9, length: 6 });
  assert.deepEqual(parseSingleRange('bytes=-4', 10), { start: 6, end: 9, length: 4 });
  assert.deepEqual(parseSingleRange('bytes=-20', 10), { start: 0, end: 9, length: 10 });
  assert.equal(parseSingleRange(undefined, 10), null);
  assert.equal(parseSingleRange(null, 10), null);
});

test('rejects malformed, multiple, out-of-bounds, and zero-size ranges', () => {
  for (const [range, size] of [
    ['bytes=0-1,3-4', 10], ['bytes=-1-4', 10], ['bytes=5-4', 10],
    ['bytes=10-', 10], ['bytes=abc-def', 10], ['bytes=0-0', 0],
  ]) {
    assert.throws(() => parseSingleRange(range, size), RangeNotSatisfiableError);
  }
});

test('rejects invalid descriptors and signatures with safe media errors', () => {
  const invalid = [
    { fileName: 'empty.mp4', mimeType: 'video/mp4', contentLength: 0 },
    { fileName: 'large.webm', mimeType: 'video/webm', contentLength: MAX_VIDEO_BYTES + 1 },
    { fileName: 'clip.mp4', mimeType: 'video/webm' },
  ];
  for (const descriptor of invalid) {
    assert.throws(() => validateVideoDescriptor(descriptor), (error) => {
      assert.ok(error instanceof VideoMediaError);
      assert.doesNotMatch(error.message, /\/tmp|Users|\\/);
      return true;
    });
  }
  assert.equal(hasValidVideoSignature('video/mp4', Buffer.from([0, 0, 0, 24, ...Buffer.from('ftyp')])), true);
  assert.equal(hasValidVideoSignature('video/mp4', Buffer.from('not mp4')), false);
  assert.equal(hasValidVideoSignature('video/webm', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), true);
  assert.equal(hasValidVideoSignature('video/webm', Buffer.from('not webm')), false);
});
