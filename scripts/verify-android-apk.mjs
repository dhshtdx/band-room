import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

export const APK_RELATIVE = join('android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');

// APK 必须包含的结构条目：Node 引擎、JNI 桥、服务端资源、Manifest。
export const REQUIRED_ENTRIES = [
  'lib/arm64-v8a/libnode.so',
  'lib/arm64-v8a/libbandroom_node.so',
  'lib/arm64-v8a/libc++_shared.so',
  'assets/nodejs-project/main.mjs',
  'assets/nodejs-project/package.json',
  'assets/nodejs-project/server/index.js',
  'assets/nodejs-project/public/app.js',
  'assets/nodejs-project/node_modules/express/package.json',
  'assets/nodejs-project/node_modules/ws/package.json',
  'assets/nodejs-project/node_modules/@coderline/alphatab/package.json',
  'AndroidManifest.xml',
  'classes.dex'
];

export const REQUIRED_ABIS = ['arm64-v8a'];

export function listEntries(zipOutput) {
  // unzip -l 每行形如：   Length      Date    Time    Name
  // 用「分隔线之后、按三个以上空格切分出的最后一列」取真实条目名。
  const lines = zipOutput.split('\n');
  const start = lines.findIndex((line) => line.trim().startsWith('---------'));
  const body = start === -1 ? lines : lines.slice(start + 1);
  return body
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('---------'))
    .map((line) => line.split(/\s{3,}/).pop())
    .filter((name) => name && name !== 'Name' && !/^\d+ files?$/.test(name));
}

export function missingEntries(entries, required = REQUIRED_ENTRIES) {
  const present = new Set(entries);
  return required.filter((entry) => !present.has(entry));
}

export function abisIn(entries) {
  const found = new Set();
  for (const entry of entries) {
    const match = /^lib\/([^/]+)\//.exec(entry);
    if (match) found.add(match[1]);
  }
  return [...found].sort();
}

async function main() {
  const apk = join(root, APK_RELATIVE);
  const info = await stat(apk).catch(() => null);
  if (!info) throw new Error(`找不到 APK：${apk}；请先运行 pnpm run dist:android`);

  const { stdout } = await run('unzip', ['-l', apk], { maxBuffer: 32 * 1024 * 1024 });
  const entries = listEntries(stdout);
  const missing = missingEntries(entries);
  if (missing.length) throw new Error(`APK 缺少必需条目：\n- ${missing.join('\n- ')}`);

  const abis = abisIn(entries);
  for (const abi of REQUIRED_ABIS) {
    if (!abis.includes(abi)) throw new Error(`APK 缺少 ABI：${abi}（实际：${abis.join(', ') || '无'}）`);
  }

  const digest = createHash('sha256').update(await readFile(apk)).digest('hex');
  console.log(`APK 结构校验通过：${(info.size / 1024 / 1024).toFixed(1)} MB，ABI ${abis.join(', ')}`);
  console.log(`SHA-256 ${digest}`);
  return { apk, size: info.size, abis, sha256: digest };
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
