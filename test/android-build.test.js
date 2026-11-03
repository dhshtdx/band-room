import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  NODEJS_MOBILE_SHA256,
  NODEJS_MOBILE_URL,
  NODEJS_MOBILE_VERSION,
  REQUIRED_ABIS,
} from '../scripts/fetch-nodejs-mobile.mjs';
import {
  APK_RELATIVE,
  REQUIRED_ENTRIES,
  abisIn,
  listEntries,
  missingEntries,
} from '../scripts/verify-android-apk.mjs';

const root = resolve(import.meta.dirname, '..');

test('Node.js Mobile 版本与校验值固定，不得静默漂移', () => {
  assert.equal(NODEJS_MOBILE_VERSION, '18.20.4');
  assert.match(NODEJS_MOBILE_SHA256, /^[0-9a-f]{64}$/);
  assert.match(NODEJS_MOBILE_URL, /^https:\/\/github\.com\/nodejs-mobile\/nodejs-mobile\/releases\/download\/v18\.20\.4\//);
  assert.deepEqual(REQUIRED_ABIS, ['arm64-v8a', 'x86_64']);
});

test('Gradle wrapper 固定版本与发行包地址', async () => {
  const properties = await readFile(join(root, 'android', 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
  assert.match(properties, /distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-8\.14\.6-bin\.zip/);
  assert.match(properties, /validateDistributionUrl=true/);
});

test('Android 工程固定 SDK 与 ABI 约束', async () => {
  const gradle = await readFile(join(root, 'android', 'app', 'build.gradle.kts'), 'utf8');
  assert.match(gradle, /compileSdk = 35/);
  assert.match(gradle, /minSdk = 26/);
  assert.match(gradle, /targetSdk = 35/);
  assert.match(gradle, /ndkVersion = "27\.0\.12077973"/);
  assert.match(gradle, /version = "3\.22\.1"/);
  assert.match(gradle, /abiFilters \+= listOf\("arm64-v8a", "x86_64"\)/);
});

test('Manifest 声明 :host 进程、specialUse 前台服务与明文局域网策略', async () => {
  const manifest = await readFile(join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
  assert.match(manifest, /android:process=":host"/);
  assert.match(manifest, /android:foregroundServiceType="specialUse"/);
  assert.match(manifest, /android\.permission\.FOREGROUND_SERVICE_SPECIAL_USE/);
  assert.match(manifest, /local_network_rehearsal_host/);
  assert.match(manifest, /android:usesCleartextTraffic="true"/);
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.match(manifest, /android:exported="false"/);
});

test('APK 校验清单覆盖 Node 引擎、JNI 桥与服务端资源', () => {
  assert(REQUIRED_ENTRIES.includes('lib/arm64-v8a/libnode.so'));
  assert(REQUIRED_ENTRIES.includes('lib/arm64-v8a/libbandroom_node.so'));
  assert(REQUIRED_ENTRIES.includes('assets/nodejs-project/main.mjs'));
  assert(REQUIRED_ENTRIES.includes('assets/nodejs-project/server/index.js'));
  assert.equal(APK_RELATIVE, join('android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'));
});

test('unzip 输出解析能取到真实条目名', () => {
  const sample = [
    'Archive:  app-release.apk',
    '  Length      Date    Time    Name',
    '---------  ---------- -----   ----',
    '    25436  01-01-1981 01:01   classes.dex',
    ' 62475584  01-01-1981 01:01   lib/arm64-v8a/libnode.so',
    '---------                     -------',
    ' 62521020                     2 files',
  ].join('\n');
  const entries = listEntries(sample);
  assert.deepEqual(entries, ['classes.dex', 'lib/arm64-v8a/libnode.so']);
  assert.deepEqual(missingEntries(entries, ['classes.dex']), []);
  assert.deepEqual(missingEntries(entries, ['lib/x86_64/libnode.so']), ['lib/x86_64/libnode.so']);
  assert.deepEqual(abisIn(entries), ['arm64-v8a']);
});
