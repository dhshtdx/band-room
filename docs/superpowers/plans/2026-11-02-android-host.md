# Android 主机端实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成能够在 Android 手机上运行完整 Band Room 服务端并在后台保持房间的可侧载 APK。

**Architecture:** 原生 Android Activity/WebView 承载主机控制台，前台 Service 在独立线程中启动 Node.js Mobile，APK assets 内携带现有 Node 服务工程。构建脚本从当前仓库生成移动端 Node 资源，并由 Gradle 打包固定版本的 Node 引擎。

**Tech Stack:** Kotlin/Java、Android Gradle Plugin、CMake/JNI、Node.js Mobile 18.20.4、现有 Express/WebSocket/AlphaTab 服务端

**Spec:** `docs/superpowers/specs/2026-11-02-android-host-design.md`

## Global Constraints

- Android 主机必须提供与桌面主机相同的 HTTP、WebSocket、曲谱解析和视频 Range 流功能。
- Activity 退到后台或手机锁屏后，前台服务必须继续维持主机，且显示可停止的常驻通知。
- 首版最低 Android 8.0（API 26）；发布 APK 至少包含 `arm64-v8a`。
- 房间临时媒体写入独立的应用私有数据目录；APK 升级不得直接覆盖该目录，但停止主机仍按现有语义清理当前媒体。
- WebView 只允许加载本机 Band Room 地址，禁止 `file://` 和任意外部页面在应用内导航。
- Node.js Mobile 和构建工具版本必须固定；下载的二进制必须校验 SHA-256。
- 不改变桌面端 Node.js 20+ 的构建与运行要求。
- 固定 `minSdk=26`、`compileSdk=35`、`targetSdk=35`，前台服务类型为 `specialUse`，subtype 为 `local_network_rehearsal_host`。
- Node 服务运行在独立 `:host` 进程；通知必须先于解包和 Node 初始化显示，停止后结束该进程以保证可重新启动。

## Review Focus

- Node 服务启动慢或失败时，界面必须显示中文重试状态而不是白屏。
- Activity 重建、旋转或重复打开时，不能启动第二个 Node 实例或占用第二个端口。
- APK 升级时更新服务程序，但不能删除用户曲谱和视频目录。
- 无 Wi-Fi、IP 变化或权限拒绝时，本机控制台仍可打开并给出可理解的局域网状态。
- 停止通知动作、Activity 退出和系统回收的组合不能留下错误的“正在运行”状态，且停止后必须可以重新启动。

---

### Task 1: 移动端 Node 资源包与兼容入口

**Files:**
- Create: `android-node/main.mjs`
- Create: `scripts/prepare-android-node.mjs`
- Create: `test/android-package.test.js`
- Modify: `server/index.js`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `pnpm run prepare:android-node`，生成 `android/app/src/main/assets/nodejs-project/`，入口接受 `BAND_ROOM_DATA_DIR` 和 `PORT`。

- [ ] **Step 1: 写失败测试**：断言资源清单只包含运行期文件、独立 Android `package.json` 保留 `type=module`、pnpm 依赖被物化、AlphaTab dist 完整、Android 入口设置固定环境参数、生成结果不包含测试/用户媒体/桌面壳；断言内部停机端点仅接受回环地址和正确随机令牌。
- [ ] **Step 2: 运行测试确认因脚本和入口缺失而失败**：`node --test test/android-package.test.js`。
- [ ] **Step 3: 实现资源准备脚本和移动入口**：复制服务端、网页、法律文件及物化后的生产依赖到 assets 暂存目录，保留 Node 18 可运行语法；加入只在 Android 环境启用的内部优雅停机入口，并清理崩溃遗留临时上传。
- [ ] **Step 4: 运行定向测试和完整 `pnpm check`**，确认桌面行为未回归。
- [ ] **Step 5: 提交**：`feat: prepare embedded node server for android`。

### Task 2: Android 原生工程与前台服务

**Files:**
- Create: `android/settings.gradle.kts`
- Create: `android/build.gradle.kts`
- Create: `android/gradle.properties`
- Create: `android/app/build.gradle.kts`
- Create: `android/app/src/main/AndroidManifest.xml`
- Create: `android/app/src/main/java/com/bandroom/rehearsal/MainActivity.kt`
- Create: `android/app/src/main/java/com/bandroom/rehearsal/BandRoomService.kt`
- Create: `android/app/src/main/java/com/bandroom/rehearsal/ServerState.kt`
- Create: `android/app/src/main/java/com/bandroom/rehearsal/AssetInstaller.kt`
- Create: `android/app/src/main/java/com/bandroom/rehearsal/LocalNavigationPolicy.kt`
- Create: `android/app/src/main/cpp/native-lib.cpp`
- Create: `android/app/CMakeLists.txt`
- Create: `android/app/src/main/res/**`
- Create: `android/app/src/test/java/com/bandroom/rehearsal/*Test.kt`

**Interfaces:**
- Consumes: Task 1 的 `assets/nodejs-project/`。
- Produces: 独立 `:host` 进程中的单实例前台服务、Node JNI 启动器、只加载本机 `/host` 的 WebView Activity、文件选择器、带超时兜底的优雅停止动作。

- [ ] **Step 1: 写失败的 JVM 测试**：覆盖本机导航白名单、资源版本更新判断、启动/运行/失败/停止状态转换、重复启动抑制和停止后重启。
- [ ] **Step 2: 运行 Gradle 单元测试确认目标类缺失**。
- [ ] **Step 3: 实现最小原生外壳与前台服务**：在 `onStartCommand` 首先进入前台，再异步执行资源复制和 JNI Node 线程；实现健康检查、WebView 安全配置、文件选择器、中文错误/重试页，以及内部令牌优雅关服后结束 `:host` 进程。
- [ ] **Step 4: 运行 JVM 测试并静态检查 Manifest**：确认 `minSdk=26`、`compileSdk=35`、`targetSdk=35`、`:host` 进程、`specialUse` 权限/subtype、明文网络配置与 ABI。
- [ ] **Step 5: 提交**：`feat: add android foreground host shell`。

### Task 3: 可复现 Android 构建与 APK 校验

**Files:**
- Create: `scripts/fetch-nodejs-mobile.mjs`
- Create: `scripts/verify-android-apk.mjs`
- Create: `test/android-build.test.js`
- Create: `android/gradlew`
- Create: `android/gradlew.bat`
- Create: `android/gradle/wrapper/gradle-wrapper.properties`
- Create: `android/gradle/wrapper/gradle-wrapper.jar`（由固定 Gradle 版本生成）
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/RELEASE.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1 的资源准备命令和 Task 2 的 Android 工程。
- Produces: `pnpm run dist:android` 与经结构校验的 `android/app/build/outputs/apk/release/*.apk`。

- [ ] **Step 1: 写失败测试**：断言 Node.js Mobile 18.20.4、AGP、Gradle、NDK、CMake、compile/target SDK、下载地址、SHA-256、Gradle wrapper 和 APK 必备条目校验规则均固定。
- [ ] **Step 2: 运行测试确认构建脚本缺失而失败**。
- [ ] **Step 3: 实现固定版本下载、校验、Gradle wrapper、APK 校验和文档**。
- [ ] **Step 4: 安装缺少的 Android SDK 组件并运行 `pnpm run dist:android`**；使用 Android 调试证书签名生成可安装测试 APK，并明确标注不得作为公开发布签名。
- [ ] **Step 5: 对 APK 运行结构校验、完整 `pnpm check`，记录产物 SHA-256**。
- [ ] **Step 6: 提交**：`build: produce reproducible android host apk`。

### Task 4: 真机可安装性与回归验收

**Files:**
- Modify: `docs/TEST_MATRIX.md`
- Modify: `安装使用说明.md`

**Interfaces:**
- Consumes: Task 3 生成的 APK。
- Produces: 安装、局域网加入、后台保活、曲谱和视频流的验收记录。

- [ ] **Step 1: 用 `adb install -r` 安装到可用 Android 真机或模拟器并启动**。
- [ ] **Step 2: 验证本机 `/api/health`、创建房间和另一浏览器加入**。
- [ ] **Step 3: 验证 WebView 文件选择器上传曲谱与接近 2 GiB 上限前的拒绝路径、视频上传/Range 请求、切后台和锁屏后连接继续**。
- [ ] **Step 4: 验证通知停止后端口关闭并能再次启动；覆盖旋转/重复打开、无 Wi-Fi/IP 变化、进程回收与 `adb install -r`，记录无法自动化的设备限制**。
- [ ] **Step 5: 更新测试矩阵和安装说明，运行最终完整检查**。
- [ ] **Step 6: 提交**：`docs: add android host validation guide`。
