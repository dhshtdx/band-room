import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { extname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const platform = process.argv[2];
const errors = [];

function requireFiles(paths) {
  for (const path of paths) if (!existsSync(join(root, path))) errors.push(`缺少发布文件：${path}`);
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

requireFiles(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'TERMS.md', 'public/legal.html', 'public/release-info.json']);
const releaseInfoPath = join(root, 'public', 'release-info.json');
if (existsSync(releaseInfoPath)) {
  const releaseInfo = JSON.parse(readFileSync(releaseInfoPath, 'utf8'));
  for (const field of ['publisher', 'sourceUrl', 'supportUrl', 'purchaseUrl']) {
    if (!releaseInfo[field] || /OWNER|REPOSITORY|EXAMPLE|待填写/i.test(releaseInfo[field])) errors.push(`public/release-info.json 尚未填写 ${field}。`);
  }
}
if (containsScore(join(root, 'public')) || containsScore(join(root, 'build'))) {
  errors.push('public/ 或 build/ 中包含曲谱文件；正式安装包不得捆绑测试或用户曲谱。');
}

if (platform === 'mac') {
  for (const name of ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
    if (!process.env[name]) errors.push(`Mac 公证缺少环境变量：${name}`);
  }
  const keychainIdentity = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (!process.env.CSC_LINK && !/Developer ID Application/.test(keychainIdentity.stdout || '')) {
    errors.push('未找到 Developer ID Application 证书；请导入钥匙串或设置 CSC_LINK。');
  }
} else if (platform === 'win') {
  if (!process.env.CSC_LINK) errors.push('Windows 正式签名缺少 CSC_LINK（RSA 代码签名证书）。');
  if (!process.env.CSC_KEY_PASSWORD) errors.push('Windows 正式签名缺少 CSC_KEY_PASSWORD。');
} else if (platform === 'android') {
  const propertyFile = join(root, 'android-host', 'android', 'keystore.properties');
  const environmentReady = ['BAND_ROOM_ANDROID_KEYSTORE', 'BAND_ROOM_ANDROID_STORE_PASSWORD', 'BAND_ROOM_ANDROID_KEY_ALIAS', 'BAND_ROOM_ANDROID_KEY_PASSWORD'].every((name) => process.env[name]);
  if (!environmentReady && !existsSync(propertyFile)) {
    errors.push('Android 正式签名未配置；请复制 keystore.properties.example 并填写，或设置 BAND_ROOM_ANDROID_* 环境变量。');
  }
  if (existsSync(propertyFile) && /CHANGE_ME/.test(readFileSync(propertyFile, 'utf8'))) {
    errors.push('android-host/android/keystore.properties 仍包含 CHANGE_ME。');
  }
} else {
  errors.push('用法：node scripts/release-preflight.mjs <mac|win|android>');
}

if (errors.length) {
  console.error(`正式发布检查未通过：\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`${platform} 正式发布检查通过。`);
