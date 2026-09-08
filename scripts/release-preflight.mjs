import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

// 打包前检查：只验证"这个包能不能安全地给别人"，
// 不涉及代码签名、公证或发行主体。
const root = resolve(import.meta.dirname, '..');
const errors = [];
const warnings = [];

function requireFiles(paths) {
  for (const path of paths) if (!existsSync(join(root, path))) errors.push(`缺少文件：${path}`);
}

function containsScore(directory) {
  if (!existsSync(directory)) return false;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory() && containsScore(fullPath)) return true;
    if (entry.isFile() && ['.gp', '.gp3', '.gp4', '.gp5', '.gpx'].includes(extname(entry.name).toLowerCase())) return true;
  }
  return false;
}

// 1) 许可证与法律文件必须随安装包分发
requireFiles([
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'PRIVACY.md',
  'TERMS.md',
  'TRADEMARKS.md',
  'public/legal.html',
  'public/release-info.json'
]);

// 2) 安装包绝不能捆绑曲谱（用户的 GP 文件属于用户，不得随包分发）
for (const directory of ['public', 'build']) {
  if (containsScore(join(root, directory))) {
    errors.push(`${directory}/ 中包含曲谱文件；安装包不得捆绑任何 GP 文件。`);
  }
}

// 3) 版本号必须在 package.json 与 CHANGELOG 顶部一致
const packageMetadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## ${packageMetadata.version} `)) {
  errors.push(`CHANGELOG.md 中没有 ${packageMetadata.version} 的条目；发版前请先写变更记录。`);
}

// 4) 应用内"获取对应源代码"链接必须有可用地址（AGPL 分发义务）
const releaseInfo = JSON.parse(readFileSync(join(root, 'public', 'release-info.json'), 'utf8'));
if (!releaseInfo.sourceUrl || /EXAMPLE|OWNER|REPOSITORY|待填写/i.test(releaseInfo.sourceUrl)) {
  errors.push('public/release-info.json 的 sourceUrl 尚未填写为真实仓库地址（AGPL 要求向接收者提供对应源代码）。');
}
if (!releaseInfo.supportUrl || /EXAMPLE|待填写/i.test(releaseInfo.supportUrl)) {
  warnings.push('public/release-info.json 的 supportUrl 仍是占位值；建议填写真实反馈渠道。');
}

// 5) 提醒：未签名构建在别人机器上需要手动放行
warnings.push('当前构建未做代码签名与公证；请保留 README 中"首次打开需手动放行"的说明。');

if (errors.length) {
  console.error(`打包前检查未通过：\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
for (const warning of warnings) console.warn(`提醒：${warning}`);
console.log(`打包前检查通过（Band Room ${packageMetadata.version}）。`);
