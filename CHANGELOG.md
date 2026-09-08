# 更新记录

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
