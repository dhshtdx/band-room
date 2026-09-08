import {cp, rm} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const androidRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = resolve(androidRoot, '..');
const embeddedRoot = resolve(androidRoot, 'nodejs-assets', 'nodejs-project');

for (const directory of ['server', 'public', 'legal']) {
  const target = resolve(embeddedRoot, directory);
  await rm(target, {recursive: true, force: true});
  await cp(resolve(projectRoot, directory), target, {recursive: true});
}

for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'TERMS.md', 'TRADEMARKS.md', 'COMMERCIAL.md', 'CHANGELOG.md']) {
  await cp(resolve(projectRoot, file), resolve(embeddedRoot, file));
}

console.log('已同步 server/、public/ 与法律文件到安卓主机工程。');
