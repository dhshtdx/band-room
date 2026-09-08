import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const releaseDir = join(root, 'release');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const releaseExtensions = new Set(['.dmg', '.exe', '.msi', '.zip']);

// 只统计 release/ 顶层的交付产物，不递归进 unpacked/、mac-arm64/ 等中间目录，
// 避免把同一个应用的多份中间二进制重复计入校验清单。
const entries = await readdir(releaseDir, { withFileTypes: true });
const files = entries
  .filter((entry) => entry.isFile() && releaseExtensions.has(extname(entry.name).toLowerCase()))
  .map((entry) => join(releaseDir, entry.name))
  .sort();

const artifacts = [];
for (const file of files) {
  const bytes = await readFile(file);
  artifacts.push({
    file: basename(file),
    size: (await stat(file)).size,
    sha256: createHash('sha256').update(bytes).digest('hex')
  });
}
if (!artifacts.length) throw new Error('release/ 顶层没有可生成校验值的安装包；请先运行 pnpm dist:mac 或 pnpm dist:win。');

await writeFile(join(releaseDir, 'SHA256SUMS.txt'), `${artifacts.map((item) => `${item.sha256}  ${item.file}`).join('\n')}\n`);
await writeFile(join(releaseDir, 'release-manifest.json'), `${JSON.stringify({ product: packageJson.productName, version: packageJson.version, generatedAt: new Date().toISOString(), artifacts }, null, 2)}\n`);
console.log(`已为 ${artifacts.length} 个安装包生成 SHA-256 校验值与发布清单。`);
