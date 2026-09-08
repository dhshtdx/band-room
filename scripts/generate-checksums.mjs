import { createHash } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const releaseDir = join(root, 'release');
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const releaseExtensions = new Set(['.dmg', '.exe', '.msi', '.apk', '.aab', '.zip']);
const files = [];

async function collect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) await collect(fullPath);
    else if (releaseExtensions.has(extname(entry.name).toLowerCase())) files.push(fullPath);
  }
}

await collect(releaseDir);
const artifacts = [];
for (const file of files.sort()) {
  const bytes = await readFile(file);
  artifacts.push({
    file: basename(file),
    size: (await stat(file)).size,
    sha256: createHash('sha256').update(bytes).digest('hex')
  });
}
if (!artifacts.length) throw new Error('release/ 中没有可生成校验值的安装包。');

await writeFile(join(releaseDir, 'SHA256SUMS.txt'), `${artifacts.map((item) => `${item.sha256}  ${item.file}`).join('\n')}\n`);
await writeFile(join(releaseDir, 'release-manifest.json'), `${JSON.stringify({ product: packageJson.productName, version: packageJson.version, generatedAt: new Date().toISOString(), artifacts }, null, 2)}\n`);
console.log(`已为 ${artifacts.length} 个安装包生成 SHA-256 校验值与发布清单。`);
