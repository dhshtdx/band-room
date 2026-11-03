# Android 主机端 · 实施记录

> 记录 Band Room Android 主机端从设计到实机验收的完整过程：决策、踩坑、修复、验证。
> 面向"下次要改这里"的人，不是安装说明。操作手册见 `.claude/skills/band-room-android-release/SKILL.md`。

- **状态**：已完成并通过 Android 15 模拟器端到端验证
- **分支**：`feature/android-host`
- **提交**：`4aa749b`（资源打包）→ `a5eeda2`（原生外壳）
- **产物**：`android/app/build/outputs/apk/release/app-release.apk`（41.2 MB）
- **代码位置**：`band-room/.worktrees/android-host/`（`feature/android-host` 分支，尚未合并到 `main`）

---

## 一、起点

### 已有材料

开始前仓库里已经有完整设计，不用重新论证：

| 文件 | 内容 |
|---|---|
| `docs/superpowers/specs/2026-11-02-android-host-design.md` | 架构决策：原生外壳 + Node.js Mobile，附未采纳方案与理由 |
| `docs/superpowers/plans/2026-11-02-android-host.md` | 4 个 Task 的分解与验收点 |
| `.superpowers/sdd/2026-11-02-android-host/progress.md` | SDD 台账，含接口一致性裁定 |

基线：提交 `e98b4b9`，`npm run check` **74/74 通过**。

### Task 1 已完成

`4aa749b` 把服务端打包成 Android 资源，产出 `android-node/main.mjs` 入口和
`scripts/prepare-android-node.mjs`，配套 3 项测试。这一步做完时验证过：
真 Node 18.20.4 能跑起 `main.mjs`，内部停机端点只认回环地址 + 随机令牌。

### 一个容易被忽略的背景

`CHANGELOG.md` 里写着 1.0.4 的一个决定：

> **移除 Android 主机外壳**（React Native + Node.js Mobile + Gradle 工程），项目专注 macOS 与 Windows 桌面端。

所以这次不是"从零加 Android"，而是**把移除的能力以另一种形态加回来**：
放弃 React Native，换成不引入 JavaScript 桥的原生 Java 外壳。
这一点必须在 CHANGELOG 里说清楚，否则后来的人会以为是反复横跳。

---

## 二、架构

```
MainActivity (主进程)  ──►  WebView → http://127.0.0.1:4173/host
       │
       └─ startForegroundService
                │
BandRoomService (:host 进程)  ──►  解包 assets → JNI → node::Start()
                                        │
                                   server/index.js（与桌面同一份代码）
```

### 为什么是这个结构

| 方案 | 结论 |
|---|---|
| 原生 Java 外壳 + Node.js Mobile | **采用**。复用整套服务端，74 项测试保障直接继承 |
| Kotlin 重写服务端 | 否决。要重写 Express 路由、WebSocket 房间状态、AlphaTab 解析、上传冲突控制、Range 视频流，协议回归风险过高 |
| Capacitor / Cordova WebView | 否决。普通 WebView 跑不了 Node，只能当客户端 |

### 为什么服务跑在独立进程

`:host` 独立进程换来三件事：

1. Android 杀主进程（用户划掉任务）时，前台服务仍在跑
2. WebView 的内存压力与 Node 堆隔离
3. 停止主机 = 结束该进程，语义干净，重启必是全新运行时

代价是 `Application.onCreate` 会在两个进程各跑一次 —— 这正是后面第一个坑的来源。

---

## 三、实施

### Task 2：原生外壳

新增 11 个 Java 类，职责切得很细，因为其中 4 个要做 JVM 单测（不依赖 Android 框架）：

| 类 | 职责 | 可单测 |
|---|---|---|
| `ServerState` | 状态机：IDLE → STARTING → RUNNING / FAILED / STOPPED | ✅ |
| `LocalNavigationPolicy` | WebView 导航白名单 | ✅ |
| `ServiceConfig` | 端口 4173、令牌生成、URL 拼装 | ✅ |
| `AssetInstaller` | 版本化目录、解包、清理 | ✅（部分） |
| `MainActivity` | WebView + 文件选择器 + 健康轮询 | — |
| `BandRoomService` | 前台服务、通知、Node 生命周期 | — |
| `NodeRunner` | JNI 声明 | — |
| `BandRoomApplication` | 进程判定的 WebView 初始化 | — |
| `native-lib.cpp` | `node::Start()` 的 pthread 包装 | — |

服务生命周期顺序不能变：

1. `onStartCommand` 立刻 `startForeground` —— Android 8 有 5 秒时限
2. 后台线程解包 assets 到版本化目录
3. JNI 拉起 Node 线程
4. Activity 轮询 `/api/health` 判断就绪
5. 通知「停止主机」→ 打内部令牌端点 → `System.exit(0)`

### Task 3：可复现构建

四个脚本串成 `npm run dist:android`：

```
prepare-android-node.mjs   → 打包服务端资源 + 兼容补丁
fetch-nodejs-mobile.mjs    → 下载 libnode.so，SHA-256 校验
build-android.mjs          → Gradle wrapper 打包
verify-android-apk.mjs     → APK 结构校验
```

固定版本，禁止漂移：

| 组件 | 版本 |
|---|---|
| Node.js Mobile | 18.20.4（SHA-256 `bd7321ea...`） |
| AGP | 8.13.2 |
| Gradle | 8.14.6 |
| NDK | 27.0.12077973 |
| CMake | 3.22.1 |
| compileSdk / minSdk / targetSdk | 35 / 26 / 35 |

---

## 四、实机踩坑（核心）

三个坑都是**装到模拟器上跑起来才暴露**的。桌面构建全绿，不代表能跑。

### 坑 1：Application.onCreate 在 `:host` 进程碰 WebView

**首次安装启动，服务进程直接崩：**

```
FATAL EXCEPTION: main
Process: com.bandroom.rehearsal:host, PID: 4053
java.lang.RuntimeException: Unable to create application com.bandroom.rehearsal.BandRoomApplication:
java.lang.RuntimeException: Using WebView from more than one process at once with the same
data directory is not supported. https://crbug.com/558377
  Current process com.bandroom.rehearsal:host (pid 4053), lock owner com.bandroom.rehearsal (pid 3927)
    at android.webkit.WebView.setWebContentsDebuggingEnabled(WebView.java:2021)
    at com.bandroom.rehearsal.BandRoomApplication.onCreate(BandRoomApplication.java:15)
```

**根因**：`Application.onCreate` 每个进程各执行一次。`WebView.setWebContentsDebuggingEnabled()`
会去抢 WebView 数据目录锁，而主进程已经持有。

**修复**：按进程名跳过，`:host` 里完全不碰 WebView。

```java
private boolean isHostProcess() {
    String processName = currentProcessName();
    return processName != null && processName.endsWith(":host");
}
```

API 28+ 用 `getProcessName()`，低版本回落读 `/proc/self/cmdline`。

### 坑 2：Node.js Mobile 的 V8 不支持 Unicode 属性转义

修完坑 1，服务进程活下来了，但 Node 一加载 Express 就退出：

```
/data/data/com.bandroom.rehearsal/files/runtime/run-1.0.4-10004/node_modules/path-to-regexp/dist/index.js:11
const ID_START = /^[$_\p{ID_Start}]$/u;
                 ^^^^^^^^^^^^^^^^^^^^^
SyntaxError: Invalid regular expression: /^[$_\p{ID_Start}]$/: Invalid property name in character class
    at Object.<anonymous> (.../node_modules/router/lib/layer.js:16:20)
Node.js v18.20.4
```

**根因**：Express 5 依赖 `path-to-regexp@8`，用 `\p{ID_Start}` 校验参数名。
Node.js Mobile 的 V8 **编译时未启用 Unicode 属性表**，`\p{...}` 直接报
`Invalid property name`。

**这个坑最阴险的地方**：本机同版本 Node 18.20.4 完全正常。

```bash
/tmp/node18/bin/node -e 'new RegExp("^[\\p{ID_Start}]$","u")'   # OK
# 同一个正则，Android 上的 Node.js Mobile → SyntaxError
```

所以"本地能跑"根本不是证据。

**修复**：`scripts/patch-android-node-deps.mjs` 在打包时替换三条正则，
改成等价的常用 Unicode 区段枚举（拉丁扩展、希腊、西里尔、中日韩、全角等）。
**只改 Android 资源副本，桌面端源码一行不动。**

验证方式很直接：补丁后的文件里 `grep -c "ID_Start"` 应为 0，
且 Node 加载 `path-to-regexp` 不再抛异常。

### 坑 3：主线程发 HTTP

服务起来了，日志有 `主机已就绪`，但 UI 永远停在"正在启动 Band Room 主机…"。

**根因**：`probeHealth()` 在主线程用 `HttpURLConnection`，
抛 `NetworkOnMainThreadException`，被 `catch (Exception ignored)` 吞掉，
于是永远返回 `false`，永远进不到 `showConsole()`。

**修复**：健康检查丢到后台线程，回主线程只做 UI 更新。

```java
new Thread(() -> {
    boolean ready = probeHealth();
    handler.post(() -> { if (ready) showConsole(); else handler.postDelayed(this::pollNext, 500); });
}, "band-room-health").start();
```

注意 `BandRoomService.waitForHealth()` 跑在 `bootstrapThread` 上，**没有**这个问题。
改的时候容易一起改错。

### 附带修掉的坑 4：同版本复用过期资源

`AssetInstaller.isInstalled()` 原本只判断文件是否存在。结果：
改了资源、`versionCode` 没变、重新打包安装后，日志说「复用已有 Node 资源」，
**跑的还是旧代码**，补丁看起来"没生效"。

**修复**：用 APK 的 `lastUpdateTime` 作资源指纹写进 `.asset-stamp`，
不匹配就重新解包。

```java
long expected = assetStamp();   // packageManager.getPackageInfo(...).lastUpdateTime
return new File(runtimeDir, STAMP_FILE).isFile() && readStamp(runtimeDir) == expected;
```

---

## 五、验证

### 测试规模

| 套件 | 数量 | 结果 |
|---|---|---|
| Node（基线 74 + 新增 9） | 83 | 全过 |
| Gradle JVM 单测 | 17 | 全过 |
| APK 结构校验 | — | 通过 |

JVM 单测分布：

| 测试类 | 用例数 | 覆盖 |
|---|---|---|
| `ServerStateTest` | 6 | 状态转换、重复启动抑制、停止后重启 |
| `LocalNavigationPolicyTest` | 6 | 白名单、端口、外部主机、file/content 拒绝 |
| `AssetInstallerTest` | 3 | 目录版本化、名称净化、跨版本隔离 |
| `ServiceConfigTest` | 2 | 端口固定、令牌随机且 URL 安全 |

### 模拟器端到端

环境：Android 15（API 35），arm64-v8a，Pixel 6 配置。

| 项目 | 结果 | 观察点 |
|---|---|---|
| APK 安装 | ✅ | `Success` |
| 服务启动 | ✅ | 解包 → Node → `主机已就绪`，约 1.5 秒 |
| 健康检查 | ✅ | `{"ok":true,"version":"1.0.4","rooms":0}` |
| 建房 + 加入 | ✅ | 房间 `6410360`，2 名成员 |
| 播放广播 | ✅ | `playback:state` 全员同步 |
| 伪造 hostToken | ✅ | `HOST_AUTH_INVALID` |
| 上传 `.gp5` | ✅ | Canon Rock，226 小节 + tempoMap |
| 切后台（Home） | ✅ | 主机存活，健康检查仍 200 |
| 锁屏 | ✅ | 主机存活 |
| 停止后重启 | ✅ | 不占第二个端口 |
| 外部调起服务 | ✅ | 被 `exported=false` 拦截（安全设计生效） |
| WebView 渲染 | ✅ | 非白屏，点击有响应 |

### 验证过程中的两个方法论教训

**1. "命令失败"不等于"功能坏了"**

`adb shell am startservice -a ...ACTION_STOP` 报：

```
Error: Requires permission not exported from uid 10208
```

第一反应是"停止功能坏了"。实际是 `exported="false"` **正确拦截了外部调用** ——
这正是安全设计要的效果。停止功能只能从应用内部（通知按钮）触发。

**2. 部分成功要如实标注**

以下项目**没有**在真机上验证，因为手上只有模拟器：

- WebView 文件选择器上传曲谱与视频
- 视频 Range 播放
- 接近 2 GiB 上限的拒绝路径
- 16 KB 页对齐设备上的 `libnode.so` 加载

协议层已用 WebSocket 客户端覆盖（建房、加入、广播、鉴权、上传），
但 UI 路径（文件选择器）依赖真实点击，模拟器里没走通。这一条必须写进文档，
不能因为"大部分验过了"就当成全部通过。

---

## 六、遗留问题

### 1. 16 KB 页对齐（待解决）

Node.js Mobile 18.20.4 是 2024-10 的构建，早于 Android 15 的 16 KB page 要求。

- 模拟器（4 KB page）：正常
- 16 KB page 新机型：`libnode.so` 可能加载失败

**解决路径**：自编译 Node.js Mobile 开 16 KB 对齐，或等上游发布新版本。
目前没有验证过 16 KB 设备，属于**未知风险**而非确认问题。

### 2. APK 体积 41.2 MB

主要是 `libnode.so`：arm64-v8a 单文件 62 MB，压缩后仍占大头。
当前双 ABI 同包（arm64-v8a + x86_64），生产分发可以考虑拆包。

### 3. 调试签名

使用 Android 调试证书，可侧载自用。
对外分发必须换正式密钥，私钥不进仓库。

### 4. 真机 UI 路径未验证

见上一节。需要一台实体 Android 手机补验。

---

## 七、文件清单

### 新增（`a5eeda2`）

```
android/
├── settings.gradle.kts / build.gradle.kts / gradle.properties
├── gradlew / gradlew.bat / gradle/wrapper/
├── app/
│   ├── build.gradle.kts
│   ├── CMakeLists.txt
│   └── src/
│       ├── main/
│       │   ├── AndroidManifest.xml
│       │   ├── java/com/bandroom/rehearsal/   （8 个 Java 类）
│       │   ├── cpp/native-lib.cpp
│       │   └── res/                          （图标、样式、网络配置）
│       └── test/java/com/bandroom/rehearsal/  （4 个测试类）
scripts/
├── build-android.mjs
├── fetch-nodejs-mobile.mjs
├── patch-android-node-deps.mjs
└── verify-android-apk.mjs
test/android-build.test.js
```

### 修改

| 文件 | 改动 |
|---|---|
| `package.json` | 新增 `fetch:nodejs-mobile`、`verify:android-apk`、`dist:android` |
| `.gitignore` | 忽略 `android/nodejs-mobile/`、构建产物、`.cache/` |
| `README.md` | 新增「Android 主机端」构建章节 |
| `CHANGELOG.md` | 新增「Android 主机端」条目 |
| `安装使用说明.md` | 新增「Android 安装（主机端）」 |
| `scripts/prepare-android-node.mjs` | 接入兼容补丁 |

生成但**不入库**的目录：

```
android/app/src/main/assets/nodejs-project/   ← 由 prepare 脚本生成
android/nodejs-mobile/                        ← 由 fetch 脚本下载
android/app/build/  android/.gradle/  android/.cxx/
```

---

## 八、下次要改这里

- **操作步骤** → `.claude/skills/band-room-android-release/SKILL.md`
- **架构决策与未采纳方案** → `docs/superpowers/specs/2026-11-02-android-host-design.md`
- **任务分解** → `docs/superpowers/plans/2026-11-02-android-host.md`

升级版本时三处版本号必须同步：

| 文件 | 字段 |
|---|---|
| `package.json` | `version` |
| `CHANGELOG.md` | 顶部条目 |
| `android/app/build.gradle.kts` | `versionName` + `versionCode` |

`versionCode` 必须递增，否则新包装不上旧包。规则：`主*10000 + 次*100 + 修`，
`1.0.4` → `10004`。
