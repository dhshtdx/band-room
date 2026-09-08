# 依赖安全状态

最后复核：2026-09-08。

## 可分发运行时

- Mac/Windows 主程序：`pnpm audit --prod` 为 0 个已知漏洞。
- Android 内嵌服务器：`npm audit --omit=dev` 为 0 个已知漏洞。
- 已将 Express 间接依赖 `qs` 固定到修复版本 `6.16.0`。

## Android 构建工具链

Android 外壳仍基于 React Native 0.73 和 `nodejs-mobile-react-native`。`npm audit --omit=dev`
报告 15 项间接问题（6 high、9 moderate、0 critical），来源是 Metro、React Native CLI、
`image-size`、`fast-xml-parser`、`uuid` 与 `xcode` 等构建或开发链依赖。

这些模块不由 Band Room 的局域网服务器加载，也不用于解析用户上传的 Guitar Pro 文件；
Android 成品运行时的服务器依赖位于 `android-host/nodejs-assets/nodejs-project`，已单独审计通过。
不过，构建工具漏洞仍应严肃处理：只允许受控 CI/本机环境构建，不向 Metro 或 CLI 提供不可信输入。

`npm audit` 当前给出的自动修复是把 React Native 升到 0.87.1，这是跨多个主版本的升级，
可能破坏 Node.js Mobile 原生桥接，因此本次未使用 `npm audit fix --force`。正式长期维护计划应当是：

1. 在独立分支迁移 React Native，并验证 Node.js Mobile 的 Android ABI、Gradle 与 Hermes 兼容性。
2. 完整回归房间创建、GP 上传、播放、暂停、速度变化、手机加入与后台恢复。
3. 只有在审计归零或风险重新评估后，合并到正式发行分支。

依赖安全问题请按根目录 `SECURITY.md` 的渠道私下报告。
