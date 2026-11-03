import { cp, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPatches } from './patch-android-node-deps.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const destination = join(root, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project');
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const excludedDirectories = new Set(['test', 'tests', '__tests__', 'docs', 'examples', 'coverage', '.github', '.pnpm']);
const installed = new Map();

async function copyRuntime(source, target) {
  await cp(source, target, {
    recursive: true,
    filter: async (path) => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return false;
      return !info.isDirectory() || path === source || !excludedDirectories.has(path.split('/').at(-1));
    },
  });
}

async function packageSource(parentSource, name) {
  const path = join(dirname(parentSource), name);
  try { return await realpath(path); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error(`缺少生产依赖 ${name}，请先安装锁定依赖`);
    throw error;
  }
}

async function installPackage(source, target, outputRoot) {
  if (installed.get(target) === source) return;
  installed.set(target, source);
  await copyRuntime(source, target);
  const packageJson = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const dependencies = { ...packageJson.dependencies, ...packageJson.optionalDependencies };
  for (const name of Object.keys(dependencies)) {
    let dependencySource;
    try { dependencySource = await packageSource(source, name); }
    catch (error) {
      if (name in (packageJson.optionalDependencies ?? {})) continue;
      throw error;
    }
    const rootTarget = join(outputRoot, 'node_modules', name);
    if (!installed.has(rootTarget)) await installPackage(dependencySource, rootTarget, outputRoot);
    else if (installed.get(rootTarget) !== dependencySource) {
      await installPackage(dependencySource, join(target, 'node_modules', name), outputRoot);
    }
  }
}

const parent = dirname(destination);
await mkdir(parent, { recursive: true });
const stage = await mkdtemp(join(parent, '.nodejs-project-'));
try {
  for (const name of ['server', 'public', 'legal']) await copyRuntime(join(root, name), join(stage, name));
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'TERMS.md', 'TRADEMARKS.md', 'CHANGELOG.md']) {
    await cp(join(root, name), join(stage, name));
  }
  await cp(join(root, 'android-node', 'main.mjs'), join(stage, 'main.mjs'));
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, private: true, type: 'module', dependencies: metadata.dependencies, engines: { node: '>=18' } }, null, 2) + '\n');
  for (const name of Object.keys(metadata.dependencies)) {
    const source = await realpath(join(root, 'node_modules', name));
    await installPackage(source, join(stage, 'node_modules', name), stage);
  }
  // Node.js Mobile 的 V8 缺少 Unicode 属性转义支持，按需给打包副本打补丁。
  const patched = await applyPatches(stage);
  if (patched.length) console.log(`已为 Node.js Mobile 兼容性打补丁：${patched.join(', ')}`);

  await rm(destination, { recursive: true, force: true });
  await rename(stage, destination);
  console.log(`Android Node 资源已准备：${destination}`);
} catch (error) {
  await rm(stage, { recursive: true, force: true });
  throw error;
}
