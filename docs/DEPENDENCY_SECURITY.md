# 依赖安全状态

最后复核：2026-10-07（Band Room 1.0.4）。

## 可分发运行时

主程序（Electron 桌面端 + 局域网服务器）只有四个生产依赖：

| 依赖 | 版本 | 用途 |
|---|---|---|
| `@coderline/alphatab` | 1.8.4 | GP 解析、谱面渲染、播放时间线、主机合成器 |
| `express` | 5.2.1 | 静态资源与少量 JSON 接口 |
| `ws` | 8.21.3 | 房间与播放状态的 WebSocket 通道 |
| `qrcode` | 1.5.4 | 主机页面的加入二维码 |

`pnpm audit --prod` 结果：**0 个已知漏洞**。

## 已固定到修复版本的间接依赖

| 包 | 原版本 | 固定为 | 原因 |
|---|---|---|---|
| `qs` | — | `6.16.0` | Express 间接依赖，修复版本 |
| `proxy-addr` | 2.0.7 | `2.0.8` | GHSA-jqcg-44mw-7w3h：IPv4-mapped IPv6 信任子网导致 IP 伪造（critical） |

两者都通过 `pnpm-workspace.yaml` 的 `overrides` 固定，改动后需执行 `pnpm install --no-frozen-lockfile`
更新锁文件，并用 `pnpm audit --prod` 复核。

> 关于 `proxy-addr`：Band Room 未启用 Express 的 `trust proxy`，也不读取 `request.ip`，
> 因此该问题在本项目中原本不可达；仍升级是为了避免将来引入反向代理时踩坑，并让审计保持归零。

## 开发依赖

`electron`、`electron-builder` 及其传递依赖只在本地/CI 构建时使用，不进入运行时。
打包产物中不会包含它们（Electron 安装包只附带被生产依赖引用的模块）。

## 报告方式

依赖安全问题请按根目录 `SECURITY.md` 的渠道私下报告。

## 变更记录

- 2026-10-07：移除 Android 主机外壳（含 React Native / Node.js Mobile 构建链）。
  此前记录的 15 项间接告警（6 high、9 moderate、0 critical）全部来自该构建链，现已随代码一同删除。
- 2026-10-07：新增 `proxy-addr` 固定，生产依赖审计归零。
