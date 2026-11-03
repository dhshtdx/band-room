import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

// 固定版本与校验值：构建不得静默漂移。
export const NODEJS_MOBILE_VERSION = '18.20.4';
export const NODEJS_MOBILE_SHA256 = 'bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af';
export const NODEJS_MOBILE_URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${NODEJS_MOBILE_VERSION}/nodejs-mobile-v${NODEJS_MOBILE_VERSION}-android.zip`;

// 首版发布 arm64-v8a；x86_64 只为模拟器与开发构建保留。
export const REQUIRED_ABIS = ['arm64-v8a', 'x86_64'];

const destination = join(root, 'android', 'nodejs-mobile');
const cacheDir = join(root, '.cache', 'nodejs-mobile');

export function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`下载 Node.js Mobile 失败：HTTP ${response.status}`);
  await mkdir(join(target, '..'), { recursive: true });
  const temp = `${target}.part`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
  return temp;
}

async function main() {
  const marker = join(destination, '.installed.json');
  try {
    const installed = JSON.parse(await readFile(marker, 'utf8'));
    if (installed.version === NODEJS_MOBILE_VERSION && installed.sha256 === NODEJS_MOBILE_SHA256) {
      for (const abi of REQUIRED_ABIS) {
        await stat(join(destination, 'libs', abi, 'libnode.so'));
      }
      await stat(join(destination, 'include', 'node', 'node.h'));
      console.log(`Node.js Mobile ${NODEJS_MOBILE_VERSION} 已就绪，跳过下载。`);
      return;
    }
  } catch {
    // 未安装或不完整，继续走下载流程。
  }

  const archive = join(cacheDir, `nodejs-mobile-v${NODEJS_MOBILE_VERSION}-android.zip`);
  let needDownload = true;
  try {
    const existing = await readFile(archive);
    if (sha256Of(existing) === NODEJS_MOBILE_SHA256) needDownload = false;
  } catch {
    // 缓存不存在。
  }

  if (needDownload) {
    console.log(`下载 Node.js Mobile ${NODEJS_MOBILE_VERSION}…`);
    const temp = await download(NODEJS_MOBILE_URL, archive);
    const downloaded = await readFile(temp);
    const actual = sha256Of(downloaded);
    if (actual !== NODEJS_MOBILE_SHA256) {
      await rm(temp, { force: true });
      throw new Error(`SHA-256 校验失败：期望 ${NODEJS_MOBILE_SHA256}，实际 ${actual}`);
    }
    await rename(temp, archive);
    console.log('SHA-256 校验通过。');
  } else {
    console.log('使用已缓存的 Node.js Mobile 压缩包。');
  }

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const entries = [];
  for (const abi of REQUIRED_ABIS) entries.push(`bin/${abi}/libnode.so`);
  entries.push('include/node/**');
  await run('unzip', ['-q', '-o', archive, ...entries, '-d', destination]);

  await mkdir(join(destination, 'libs'), { recursive: true });
  for (const abi of REQUIRED_ABIS) {
    await mkdir(join(destination, 'libs', abi), { recursive: true });
    await rename(join(destination, 'bin', abi, 'libnode.so'), join(destination, 'libs', abi, 'libnode.so'));
  }
  await rm(join(destination, 'bin'), { recursive: true, force: true });

  await writeFile(marker, `${JSON.stringify({
    version: NODEJS_MOBILE_VERSION,
    sha256: NODEJS_MOBILE_SHA256,
    abis: REQUIRED_ABIS,
    fetchedAt: new Date().toISOString()
  }, null, 2)}\n`);

  console.log(`Node.js Mobile ${NODEJS_MOBILE_VERSION} 已就位：${destination}`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main().catch((error) => {
  console.error(`准备 Node.js Mobile 失败：${error.message}`);
  process.exit(1);
});
