---
name: band-room-android-release
description: 为 Band Room 打 Android 主机 APK（原生 Java 外壳 + Node.js Mobile）。当用户要求"打安卓包""出 APK""编译 android 版本""dist:android"或升级版本后需要重新产出 Android 安装包时使用。涵盖 Android SDK/JDK 环境搭建、Node.js Mobile 固定版本下载校验、Unicode 正则兼容补丁、Gradle 打包、APK 结构校验与模拟器实测。
---

# Band Room · Android 打包

## 何时用这个 skill

- 用户说"打安卓包"、"出 APK"、"编译 Android 版本"
- 版本号改了要重新出 APK
- APK 装上后白屏、闪退、服务起不来

## 架构（先理解再动手）

```
MainActivity (主进程)  ──►  WebView → http://127.0.0.1:4173/host
       │
       └─ startForegroundService
                │
BandRoomService (:host 进程)  ──►  解包 assets → JNI → node::Start()
                                        │
                                   server/index.js（与桌面同一份代码）
```

**不重写服务端**。Express 5 路由、WebSocket 房间状态、AlphaTab 曲谱解析、
上传冲突控制、Range 视频流全部原样复用，桌面端的测试保障直接继承。

## 0. 环境搭建（一次装好，长期复用）

### JDK 21（不能用系统 JDK）

系统里的 JDK 27 太新，AGP 8.13 不认。装 Temurin 21 到用户目录：

```bash
mkdir -p ~/.local/jdk && cd ~/.local/jdk
curl -L -o jdk21.tar.gz "https://api.adoptium.net/v3/binary/latest/21/ga/mac/aarch64/jdk/hotspot/normal/eclipse"
tar xzf jdk21.tar.gz
export JAVA_HOME="$HOME/.local/jdk/jdk-21.0.13+9/Contents/Home"
$JAVA_HOME/bin/java -version    # openjdk 21.0.x
```

`scripts/build-android.mjs` 会自动探测这个路径，无需每次手动 export。

### Android SDK 组件

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0" \
           "ndk;27.0.12077973" "cmake;3.22.1"
```

⚠️ `sdkmanager` 会输出 `line 173: test: : integer expression expected`，
**这是它自身脚本的无害告警**，装完照样可用，不用管。

`android/local.properties` 写 `sdk.dir=<绝对路径>`，或靠 `ANDROID_SDK_ROOT`。

### Gradle wrapper

工程里已锁定 `gradle-8.14.6-bin.zip`，首次运行自动下载。
**不要**换成 9.x——AGP 8.13 还没适配。

## 1. 构建

```bash
npm run dist:android
```

等价于三步串行：

```bash
node scripts/prepare-android-node.mjs   # 打包服务端资源 + 兼容补丁
node scripts/fetch-nodejs-mobile.mjs    # 下载 libnode.so，SHA-256 校验
node scripts/build-android.mjs          # Gradle 打包 + APK 结构校验
```

成功输出：

```
BUILD SUCCESSFUL in ~20s
APK 结构校验通过：41.2 MB，ABI arm64-v8a, x86_64
SHA-256 <hex>
```

产物：

```
android/app/build/outputs/apk/release/app-release.apk
```

## 2. 三个必须知道的兼容性坑

### 坑 1：Node.js Mobile 的 V8 不支持 Unicode 属性转义

**症状**：APK 装好后主机服务秒退，logcat 里：

```
SyntaxError: Invalid regular expression: /^[$_\p{ID_Start}]$/: Invalid property name in character class
    at node_modules/path-to-regexp/dist/index.js:11
```

**原因**：Express 5 依赖 `path-to-regexp@8`，用 `\p{ID_Start}` 校验参数名。
Node.js Mobile 18.20.4 的 V8 编译时未启用 Unicode 属性表，
**本机同版本 Node 能跑，Android 上就崩**——这是最容易误判的一个坑。

**解法**：`scripts/patch-android-node-deps.mjs` 在打包时把这三条正则替换成
等价的常用 Unicode 区段版本（拉丁扩展、希腊、西里尔、中日韩、全角等）。
只改 Android 资源副本，桌面端源码不动。

新增依赖时若又出现同类报错，按同样思路加进 `PATCHED_FILES`。

### 坑 2：Application.onCreate 在 :host 进程也执行

**症状**：服务进程直接崩，logcat 里：

```
Using WebView from more than one process at once with the same data directory is not supported
```

**原因**：`WebView.setWebContentsDebuggingEnabled()` 会在 `:host` 进程里
抢 WebView 数据目录锁，而主进程已经持有。

**解法**：`BandRoomApplication` 按进程名跳过，只让主进程碰 WebView。

### 坑 3：主线程发 HTTP

**症状**：UI 永远停在"正在启动 Band Room 主机…"，但服务其实已经起来了。

**原因**：`probeHealth()` 在主线程 `HttpURLConnection` → `NetworkOnMainThreadException`
被 catch 吞掉 → 永远返回 false。

**解法**：健康检查丢到后台线程，回主线程只做 UI 更新。

⚠️ `BandRoomService` 里的 `waitForHealth()` 跑在 `bootstrapThread` 上，
**没有**这个问题，别改错地方。

## 3. 资源版本化

运行目录 = `files/runtime/run-<versionName>-<versionCode>`。
升级 APK 换新目录、旧目录整体删除，不会出现半新半旧。

但**同一个 versionCode 重新打包**（开发期反复构建）会复用旧目录，
导致修好的资源没生效。所以 `AssetInstaller` 额外用 APK 的 `lastUpdateTime`
作为指纹写进 `.asset-stamp`，不匹配就重解包。

看到日志说「复用已有 Node 资源」而行为不对时，检查这个指纹。

## 4. 验证

### 结构校验

```bash
npm run verify:android-apk
```

检查 `libnode.so`、JNI 桥、`assets/nodejs-project/*`、ABI 是否齐全。

### 手工核对

```bash
APK=android/app/build/outputs/apk/release/app-release.apk
~/Library/Android/sdk/build-tools/35.0.0/aapt2 dump badging $APK | head -12
# package: name='com.bandroom.rehearsal' versionCode='10004' versionName='1.0.4'
# minSdkVersion:'26'  targetSdkVersion:'35'
# native-code: 'arm64-v8a' 'x86_64'

~/Library/Android/sdk/build-tools/35.0.0/apksigner verify --print-certs $APK
# Signer #1 certificate DN: C=US, O=Android, CN=Android Debug
```

JNI 符号核对：

```bash
NM=~/Library/Android/sdk/ndk/27.0.12077973/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-nm
$NM -D --defined-only /tmp/apkx/lib/arm64-v8a/libbandroom_node.so | grep Java_
# T Java_com_bandroom_rehearsal_NodeRunner_startNode
```

### 模拟器实测（必做）

```bash
# 镜像（1.78 GB，直接下比 sdkmanager 稳）
curl -L -o sysimg35.zip \
  "https://dl.google.com/android/repository/sys-img/google_apis/arm64-v8a-35_r09.zip"
unzip -q sysimg35.zip -d /tmp/sysimgx
DEST=~/Library/Android/sdk/system-images/android-35/google_apis/arm64-v8a
mkdir -p "$DEST" && cp -R /tmp/sysimgx/arm64-v8a/* "$DEST"/

echo "no" | avdmanager create avd -n bandroom-test \
  -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_6 --force

~/Library/Android/sdk/emulator/emulator -avd bandroom-test \
  -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot &

adb wait-for-device
adb install -r $APK
adb logcat -c
adb shell am start -n com.bandroom.rehearsal/.MainActivity
sleep 40
adb logcat -d -s BandRoomService:* BandRoomNode:* nodejs:* | tail -20
```

**成功标志**：

```
I BandRoomService: 已解包 Node 资源到 /data/user/0/.../run-1.0.4-10004
I BandRoomNode: 启动 Node.js：.../main.mjs
I BandRoomService: 主机已就绪：http://127.0.0.1:4173/host
```

### 端到端协议验证

```bash
adb forward tcp:14173 tcp:4173
curl -s http://127.0.0.1:14173/api/health
# {"ok":true,"service":"Band Room","version":"1.0.4","rooms":0,...}
```

再用 WebSocket 客户端跑建房 / 加入 / 播放广播 / 伪造令牌：

```bash
node /tmp/smoke.mjs http://127.0.0.1:14173
# room: <7位数>  hostToken len 32
# member joined: ... members 2
# playback broadcast: {"type":"playback:state",...}
# fake hostToken -> HOST_AUTH_INVALID
```

### 后台保活验证

```bash
adb shell input keyevent KEYCODE_HOME      # 切后台
sleep 8; curl -s http://127.0.0.1:14173/api/health   # 仍应 200

adb shell input keyevent KEYCODE_POWER     # 锁屏
sleep 8; curl -s http://127.0.0.1:14173/api/health   # 仍应 200
```

### 停止与重启

服务是 `exported="false"`，**外部 am startservice 会被拒**：

```
Error: Requires permission not exported from uid ...   ← 这是安全设计生效，不是 bug
```

正确做法是用通知栏的「停止主机」，或：

```bash
adb shell am force-stop com.bandroom.rehearsal
adb shell am start -n com.bandroom.rehearsal/.MainActivity   # 应能正常再起
```

## 5. 版本升级清单

| 文件 | 字段 | 说明 |
|---|---|---|
| `package.json` | `version` | 单一真源 |
| `CHANGELOG.md` | 顶部条目 | preflight 校验 |
| `android/app/build.gradle.kts` | `versionName` | 与 package.json 一致 |
| `android/app/build.gradle.kts` | `versionCode` | 必须递增，否则装不上 |

`versionCode = 主*10000 + 次*100 + 修`，`1.0.4` → `10004`。

⚠️ `android/app/src/main/assets/nodejs-project/` 是**生成目录**（已 gitignore），
版本号由 `prepare-android-node.mjs` 从 `package.json` 自动写入，不要手改。

## 6. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `CMake Error at CMakeLists.txt` | `NODEJS_MOBILE_DIR` 路径层级错 | `android/app` 下应为 `../nodejs-mobile` |
| `Type ... is defined multiple times` | 构建缓存里有 `* 2.class` 副本 | `rm -rf android/app/build android/app/.cxx android/.gradle` |
| `libnode.so` 缺失 | 没跑 `fetch:nodejs-mobile` | `npm run fetch:nodejs-mobile` |
| SHA-256 校验失败 | 下载不完整 | 删 `.cache/nodejs-mobile/` 重下 |
| 服务秒退 + `\p{ID_Start}` | Unicode 正则坑 | 确认 `prepare` 打了补丁 |
| 服务秒退 + WebView 锁冲突 | `Application.onCreate` 坑 | 按进程名跳过 |
| UI 永远「启动中」 | 主线程 HTTP | 健康检查移到后台线程 |
| 改了资源但行为没变 | 复用了旧解包目录 | 改 versionCode，或清应用数据 |
| `unzip: filename not matched: include/node` | 目录条目要写 `include/node/**` | 已修 |
| 模拟器无响应 | 镜像没装好 | 直接 curl 下 zip 手工铺（见上） |

## 7. 已知限制

1. **16 KB 页对齐**：Node.js Mobile 18.20.4 是 2024-10 构建，早于 Android 15
   的 16 KB page 要求。模拟器（4 KB）正常，新机型上 `libnode.so` 可能加载失败。
   彻底解决需自编译 Node.js Mobile 或等上游。
2. **APK 体积 41 MB**：主要是 `libnode.so`（arm64 62 MB，压缩后仍占大头）。
   要更小需拆 ABI 分包，首版按计划双 ABI 同包。
3. **调试证书签名**：可侧载自用，对外分发须换正式密钥。
4. **未在真机验证**：WebView 文件选择器上传、视频 Range 播放、接近 2 GiB 的
   拒绝路径。协议层已用 WebSocket 客户端覆盖，UI 路径待实体手机确认。

## 8. 本项目已知基线

- Node.js Mobile `18.20.4`，SHA-256 `bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af`
- AGP `8.13.2`，Gradle `8.14.6`，NDK `27.0.12077973`，CMake `3.22.1`
- `compileSdk 35` / `minSdk 26` / `targetSdk 35`
- 前台服务：`specialUse`，subtype `local_network_rehearsal_host`，进程 `:host`
- APK 约 **41.2 MB**，app 解包后运行时目录约 **23 MB**
- 单测：Gradle JVM **17 项**，Node 侧 Android 相关 **9 项**
