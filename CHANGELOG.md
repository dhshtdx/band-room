# 更新记录

## 1.0.5 - 2026-11-03

### 共同功能

- 新增本地视频上传与同步播放，主机控制播放、暂停和跳转，成员端静音跟随。
- 曲谱使用原生游标并改进各设备播放时的谱面跟随与移动端横屏滚动。

### Android 主机端

- 修复文件选择器把扩展名作为 MIME 类型过滤，导致 `.gp5` 等曲谱置灰无法选择；选择后仍由服务端校验文件格式与内容。

### 1.0.4 以来的其他变更

- 新增可侧载的 Android 主机 APK：手机本机运行完整 Band Room 服务端，其他设备照旧用浏览器扫码加入。
- 采用原生 Java 外壳 + Node.js Mobile 18.20.4，而非重写服务端：沿用同一份服务端代码，
  Express 5 路由、WebSocket 房间状态、AlphaTab 曲谱解析、上传冲突控制与 Range 视频流全部原样复用。
  1.0.4 曾以 React Native 方案实现又移除，这次换成不引入 JavaScript 桥的轻量实现。
- 前台服务跑在独立的 host 子进程，specialUse 类型、subtype 为 local_network_rehearsal_host；
  通知先于资产解包显示，满足 Android 8 的 startForeground 时限。切后台与锁屏后房间继续运行。
- WebView 只加载本机 127.0.0.1:4173，禁用 file 与 content 协议，任意外部导航交给系统浏览器。
- 运行目录按「版本号-versionCode」分版本，并用 APK 的 lastUpdateTime 作为资源指纹，
  避免同一版本重新打包后复用过期资源；用户媒体放在独立目录，升级不触碰。
- 通知「停止主机」打内部令牌端点优雅关服，令牌随机且只接受回环地址；服务 exported=false，外部无法直接调起。
- 构建链：pnpm run dist:android 依次准备 Node 资源、校验并下载 Node.js Mobile（固定 SHA-256）、
  Gradle 打包、APK 结构校验。首版最低 Android 8.0（API 26），同时打入 arm64-v8a 与 x86_64。
- 兼容性修复：Node.js Mobile 的 V8 未启用 Unicode 属性转义，Express 5 依赖的 path-to-regexp 第八版
  用 Unicode 属性校验参数名会抛 SyntaxError。打包脚本按需把这三条正则替换为等价的常用 Unicode 区段版本，
  仅作用于 Android 资源副本，桌面端源码不变。
- 调试期修复：Application.onCreate 在主机子进程里也会执行，触碰 WebView 会触发数据目录锁冲突并让服务崩溃，
  现按进程名跳过；Activity 健康检查改到后台线程，避免 NetworkOnMainThreadException 导致永远停在「启动中」。

## 1.0.4 - 2026-10-07

### 范围收敛：只做桌面端

- **移除 Android 主机外壳**（React Native + Node.js Mobile + Gradle 工程），项目专注 macOS 与 Windows 桌面端。
  这一决定同时删掉了维护成本最高的一条构建链，以及它带来的 15 项间接依赖告警。
- macOS 改为产出**一份 Universal DMG**（同时包含 arm64 与 x64），下载时不再需要区分芯片型号。
- 移除 `COMMERCIAL.md`、`docs/PRICING_AND_DELIVERY.md`、`docs/STORE_LISTING.md`，使用条款不再涉及销售与付费。

### 发布流程简化

- `scripts/release-preflight.mjs` 不再校验签名证书与发行主体，改为打包真正需要的检查：
  法律文件齐全、安装包内不含任何 GP 文件、版本号与 CHANGELOG 一致、应用内源码地址可用。
- 构建命令合并为 `pnpm dist:mac`、`pnpm dist:win`、`pnpm dist:checksums`。
- `generate-checksums.mjs` 只统计 `release/` 顶层的交付产物，不再把 `mac-arm64/`、`win-unpacked/` 等中间目录重复计入。
- 移除 `hardenedRuntime` 与公证相关配置：当前不做代码签名，README 与安装说明写明了首次打开需手动放行。

### 安全

- 将 Express 间接依赖 `proxy-addr` 从 2.0.7 固定到 2.0.8，修复 GHSA-jqcg-44mw-7w3h（IP 伪造，critical）。
  `pnpm audit --prod` 恢复为 0 个已知漏洞。

### 桌面端与文档

- macOS 应用包补充 `NSLocalNetworkUsageDescription`，局域网权限提示不再依赖 Electron 默认文案。
- 重写 README 与安装使用说明：面向桌面端，补充未签名应用的放行步骤与 `xattr` 兜底命令。
- 重写发版流程、测试矩阵与 GitHub 发布清单，移除签名、公证、收费相关内容。
- 扩充服务端集成测试，覆盖曲谱校验、主机凭证、房间上限与变速时间线换算。

## 1.0.3 - 2026-09-08

### 功能与稳定性

- 完成局域网房间、WebSocket 主时钟、GP 解析、TAB 渲染、伴奏、同步游标、自动滚动、变速与反复时间线。
- 完成主机令牌校验、断线恢复、心跳与房间延迟清理。
- 增加运行错误面板与移动端同步诊断。

### 开源准备

- 原创源代码采用 AGPL-3.0-only。
- 增加第三方许可证、隐私说明、发行条款、商标政策和应用内法律页面。
- 增加仓库忽略规则，隔离曲谱、构建产物、SDK 路径及签名密钥。
- Android release 不再允许使用 debug.keystore，缺少正式密钥时明确中止。
- 增加安装包 SHA-256/发布清单生成器、GitHub CI、Dependabot 与服务器集成测试。
- 增加 HTTP 安全响应头、WebSocket 消息上限、32 台设备房间上限和退出时曲谱清理。

## 1.0.0 – 1.0.2 - 2026-08-17

早期桌面版本，当天连续迭代三次，产出 macOS（ARM / Intel）与 Windows 安装包。
当时未保留逐版变更记录，只有构建产物留存。
