import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Node.js Mobile 18.20.4 的 V8 未启用 Unicode 属性转义所需的 ICU 数据，
 * 而 Express 5 的依赖 path-to-regexp 8 用 \p{ID_Start} / \p{ID_Continue}
 * 校验参数名，加载时会直接抛 SyntaxError，主机服务无法启动。
 *
 * 这里把三条正则替换成等价的 ASCII + 常用 Unicode 范围版本。
 * 只影响 Android 资源包里的副本，桌面端与源码不变。
 */

export const PATCHED_FILES = ['node_modules/path-to-regexp/dist/index.js'];

const ORIGINALS = [
  'const ID_START = /^[$_\\p{ID_Start}]$/u;',
  'const ID_CONTINUE = /^[$\\u200c\\u200d\\p{ID_Continue}]$/u;',
  'const ID = /^[$_\\p{ID_Start}][$\\u200c\\u200d\\p{ID_Continue}]*$/u;'
];

const REPLACEMENTS = [
  // 字母开头：ASCII 字母 + 拉丁扩展、希腊、西里尔、中日韩、全角等常用区段。
  'const ID_START = /^[$_A-Za-z\\u00AA\\u00B5\\u00BA\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u03FF\\u0400-\\u04FF\\u0590-\\u05FF\\u0600-\\u06FF\\u0900-\\u097F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF21-\\uFF3A\\uFF41-\\uFF5A]$/;',
  'const ID_CONTINUE = /^[$_A-Za-z0-9\\u00AA\\u00B5\\u00BA\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0300-\\u036F\\u0370-\\u03FF\\u0400-\\u04FF\\u0590-\\u05FF\\u0600-\\u06FF\\u0900-\\u097F\\u200C\\u200D\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF10-\\uFF19\\uFF21-\\uFF3A\\uFF41-\\uFF5A]$/;',
  'const ID = /^[$_A-Za-z\\u00AA\\u00B5\\u00BA\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u03FF\\u0400-\\u04FF\\u0590-\\u05FF\\u0600-\\u06FF\\u0900-\\u097F\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF21-\\uFF3A\\uFF41-\\uFF5A][$_A-Za-z0-9\\u00AA\\u00B5\\u00BA\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0300-\\u036F\\u0370-\\u03FF\\u0400-\\u04FF\\u0590-\\u05FF\\u0600-\\u06FF\\u0900-\\u097F\\u200C\\u200D\\u3040-\\u30FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uAC00-\\uD7AF\\uF900-\\uFAFF\\uFF10-\\uFF19\\uFF21-\\uFF3A\\uFF41-\\uFF5A]*$/;'
];

/** 返回替换了 \p{...} 属性的源码；已经是补丁版本时原样返回。 */
export function patchPathToRegexp(source) {
  let output = source;
  for (let index = 0; index < ORIGINALS.length; index++) {
    output = output.replace(ORIGINALS[index], REPLACEMENTS[index]);
  }
  return output;
}

/** 该文件是否仍含 Node.js Mobile 不支持的 Unicode 属性转义。 */
export function hasUnicodePropertyEscape(source) {
  return /\\p\{(?:ID_Start|ID_Continue)\}/.test(source);
}

export async function applyPatches(projectDir) {
  const applied = [];
  for (const relative of PATCHED_FILES) {
    const target = join(projectDir, relative);
    const exists = await stat(target).then(() => true).catch(() => false);
    if (!exists) continue;
    const source = await readFile(target, 'utf8');
    if (!hasUnicodePropertyEscape(source)) continue;
    await writeFile(target, patchPathToRegexp(source), 'utf8');
    applied.push(relative);
  }
  return applied;
}
