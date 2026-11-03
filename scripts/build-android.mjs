import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const androidDir = join(root, 'android');

function androidSdkRoot() {
  return process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME
    || join(process.env.HOME ?? '', 'Library', 'Android', 'sdk');
}

function javaHome() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  // Android Gradle Plugin 8.13 需要 JDK 17+，但 JDK 27 尚未被完全支持；
  // 优先使用本地 21，其次回落到系统。
  const local = join(process.env.HOME ?? '', '.local', 'jdk');
  if (existsSync(local)) {
    for (const name of ['jdk-21.0.13+9', 'jdk-21']) {
      const candidate = join(local, name, 'Contents', 'Home');
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function main() {
  const sdk = androidSdkRoot();
  if (!existsSync(sdk)) throw new Error(`找不到 Android SDK：${sdk}；请设置 ANDROID_SDK_ROOT。`);

  const wrapper = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(wrapper)) throw new Error(`缺少 Gradle wrapper：${wrapper}`);

  const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
  const home = javaHome();
  if (home) env.JAVA_HOME = home;

  console.log('开始构建 Android APK…');
  const { stdout } = await run(wrapper, ['--no-daemon', ':app:assembleRelease'], {
    cwd: androidDir,
    env,
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of stdout.split('\n')) {
    if (/BUILD|error|Error|warning:/.test(line)) console.log(line);
  }

  const { stdout: verifyOut } = await run(process.execPath, [join(root, 'scripts', 'verify-android-apk.mjs')], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(verifyOut);
}

main().catch((error) => {
  console.error(`Android 构建失败：${error.message}`);
  if (error.stdout) console.error(error.stdout.split('\n').slice(-40).join('\n'));
  process.exit(1);
});
