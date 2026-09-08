import {readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const androidRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(
  androidRoot,
  'nodejs-assets/nodejs-project/node_modules/path-to-regexp/dist/index.js',
);

const unicodeLines = [
  'const ID_START = /^[$_\\p{ID_Start}]$/u;',
  'const ID_CONTINUE = /^[$\\u200c\\u200d\\p{ID_Continue}]$/u;',
  'const ID = /^[$_\\p{ID_Start}][$\\u200c\\u200d\\p{ID_Continue}]*$/u;',
];
const mobileLines = [
  'const ID_START = /^[$_A-Za-z]$/;',
  'const ID_CONTINUE = /^[$_0-9A-Za-z]$/;',
  'const ID = /^[$_A-Za-z][$_0-9A-Za-z]*$/;',
];

let source = await readFile(target, 'utf8');
for (let index = 0; index < unicodeLines.length; index += 1) {
  if (source.includes(unicodeLines[index])) {
    source = source.replace(unicodeLines[index], mobileLines[index]);
  } else if (!source.includes(mobileLines[index])) {
    throw new Error(
      `path-to-regexp 源码与兼容补丁不匹配：${unicodeLines[index]}`,
    );
  }
}

await writeFile(target, source);
console.log('已应用 Node Mobile 路由正则兼容补丁。');
