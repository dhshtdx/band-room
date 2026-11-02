# Android 主机端设计

## 目标

为 Band Room 增加可安装的 Android 主机端。Android 手机本机启动完整 Band Room 服务，显示 `/host` 控制台，同一局域网中的其他设备继续通过浏览器扫码加入。主机切到后台或锁屏后，房间、曲谱同步和视频流仍继续运行。

## 范围

- APK 内嵌现有 Node.js 服务端、网页、AlphaTab 资源和纯 JavaScript 依赖。
- Android 前台服务运行在独立 `:host` 进程中并持有 Node.js Mobile 运行时，使用常驻通知明确显示主机正在运行，并提供停止入口。
- Android WebView 只加载本机 `http://127.0.0.1:4173/host`，允许本机 HTTP 与 WebSocket；不授予任意 `file://` 访问。
- 服务监听 `0.0.0.0`，局域网客户端沿用现有二维码、HTTP、WebSocket、曲谱和视频流协议。
- 曲谱和视频作为房间临时媒体写入应用私有数据目录；升级 APK 不直接覆盖该目录，但停止主机时仍沿用现有语义清理当前房间媒体。
- 首版最低支持 Android 8.0（API 26），发布 `arm64-v8a` APK；开发构建可同时保留 `x86_64` 以支持模拟器。

## 非目标

- 不把 Android 客户端协议重写成 Kotlin。
- 不增加公网穿透、云服务器、视频抓取或在线播放网址。
- 不自动开机启动主机，也不绕过 Android 对后台服务和电量管理的限制。
- 不在首版提供 Play 商店签名与上架自动化；先交付可侧载的 APK。

## 技术方案

### 采用：原生 Android 外壳 + Node.js Mobile

Android 原生层用 Kotlin/Java 管理 Activity、WebView、前台服务、通知与资源解包；Node.js Mobile 在专用线程中运行现有 `server/index.js`。每次应用版本变化时更新只读服务程序副本，持久数据始终放在单独的应用数据目录。该方案最大程度复用已经通过测试的同步协议和文件流逻辑。

### 未采用：Kotlin 重写服务端

它能减少内嵌运行时体积，但需要重写 Express 路由、WebSocket 房间状态、AlphaTab 曲谱解析、上传冲突控制和 Range 视频流，协议回归风险过高。

### 未采用：普通 Capacitor/Cordova WebView

普通 WebView 不能运行 Node 服务端，只能成为客户端，无法满足“安卓服务端”。Cordova 的 Node 插件也仍依赖同一 Node.js Mobile 内核，原生外壳更便于可靠实现前台服务。

## 生命周期与交互

1. 打开应用后启动独立 `:host` 进程中的前台服务；服务必须先显示“Band Room 主机正在启动”通知，再进行任何解包或 Node 初始化，以满足 Android 8.0 的前台服务时限。
2. 前台服务把随 APK 提供的 Node 工程复制到应用私有的版本化运行目录，设置 `PORT=4173`、`BAND_ROOM_DATA_DIR` 和随机停机令牌后启动 Node。持久数据目录与可替换的运行目录分离。
3. Activity 轮询本机健康检查；服务就绪后加载 `/host`。
4. Activity 退出、切后台或锁屏不停止主机；从通知点“停止主机”时，原生层向仅接受回环地址且验证随机令牌的内部端点请求优雅关服，等待 Node 线程退出后结束 `:host` 进程。下一次启动因此使用全新的 Node 运行时。
5. 服务启动失败时，Activity 显示可重试的中文错误，不显示永久白屏。
6. 启动时清理超过当前运行实例且不再引用的 `.upload` 和孤儿临时文件；不承诺房间状态或媒体跨主机停止、进程回收或 APK 升级恢复。

## 权限与安全

- 固定 `compileSdk=35`、`targetSdk=35`、`minSdk=26`。前台服务使用 `specialUse` 类型并声明 `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_SPECIAL_USE`，Manifest 的 subtype 说明为 `local_network_rehearsal_host`；它不受 `dataSync` 类型的六小时限制。未来上架商店前单独复核此类型的审核要求。
- 仅为本机及局域网 HTTP 明确启用明文流量；WebView 禁止文件访问、内容访问和任意外部导航。
- Android 17 / API 37 及更高目标版本启用本地网络权限流程；首版 `targetSdk=35`，仅需 `INTERNET` 即可隐式访问本地网络。
- 通知停止动作必须显式指向应用内广播/服务，不能暴露可注入参数。

## 构建与验证

- `pnpm run dist:android` 准备 Node 资源并调用 Gradle 生成使用 Android 调试证书签名、可直接侧载的测试 APK。正式公开发布必须通过外部密钥配置重新签名，私钥不进入仓库。
- Node.js Mobile 二进制固定版本并校验 SHA-256，避免构建时静默漂移。
- JVM 单元测试覆盖资源版本判断、服务状态转换、重复启动抑制和仅允许本机 WebView 导航的规则；Node 测试覆盖回环地址与随机令牌停机保护。
- Node 测试继续覆盖完整服务端协议；构建后检查 APK 中存在 Node 引擎、服务端资源和所需 ABI。
- 最终在真机上验证：创建房间、扫码加入、WebView 文件选择上传谱和视频、Range 播放、后台/锁屏保持连接、通知停止后再次启动，以及 `adb install -r` 升级边界。

