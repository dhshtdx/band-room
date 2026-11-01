import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const moduleUrl = new URL('../scripts/release-preflight.mjs', import.meta.url).href;

test('导入发布预检不执行检查或输出，并导出媒体检测函数', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const module = await import(${JSON.stringify(moduleUrl)}); if (typeof module.containsUserMedia !== 'function') process.exitCode = 2;`], { encoding: 'utf8' });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
});

test('发布预检递归识别 GP、MP4、WebM，忽略普通资源及缺失目录', async (t) => {
  const { containsUserMedia } = await import(moduleUrl);
  assert.equal(typeof containsUserMedia, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'band-room-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(containsUserMedia(join(directory, 'missing')), false);
  const nested = join(directory, 'nested');
  await mkdir(nested);
  await writeFile(join(nested, 'styles.css'), '');
  assert.equal(containsUserMedia(directory), false);
  for (const name of ['score.gp', 'score.gp3', 'score.gp4', 'score.gp5', 'score.gpx', 'clip.MP4', 'clip.WebM']) {
    const path = join(nested, name);
    await writeFile(path, 'user media');
    assert.equal(containsUserMedia(directory), true, name);
    await rm(path);
  }
});
