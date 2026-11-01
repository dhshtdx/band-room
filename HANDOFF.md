# HANDOFF.md

Portable continuation snapshot for Agent Continuity.
Git and the repository remain the sources of truth.
AUTO sections are machine-refreshed; SEMANTIC sections are preserved unless you edit them.

<!-- AGENT-CONTINUITY:AUTO:BEGIN -->
## Workspace Checkpoint (AUTO)

- Updated: 2026-11-01T18:04:28.531Z
- Branch: main _(confidence: confirmed)_
- Commit: 6538b1dec44f _(confidence: confirmed)_
- Last commit subject: fix: route root to host console
- Workspace: clean
- Modified files:
  - (none)
- Untracked files:
  - (none)
<!-- AGENT-CONTINUITY:AUTO:END -->

<!-- AGENT-CONTINUITY:SEMANTIC:BEGIN -->
## Overview

Band Room 是局域网乐队排练工具：主机创建房间并独占播放控制，乐手通过手机或平板加入，同步查看 Guitar Pro 谱面或本地视频。当前工作在 `main`，尚未推送远端。

## Current Task

把乐手端 Guitar Pro 谱面的自绘蓝色同步线替换为 AlphaTab 原生游标、音符高亮和原生自动滚动。用户已选择 AlphaTab `PlayerMode.EnabledExternalMedia` 方案：服务端时钟驱动游标，乐手端不加载音色且绝对静音。尚未编写本次改动的设计文档或产品代码。

## Completed

- 本地视频功能已合并到 `main`：MP4/WebM 流式上传、Range 播放、服务端时间同步、主机有声、乐手强制静音、清理与发布预检。
- 修复根地址入口：`/` 自动跳转 `/host`，提交为 `6538b1d`。
- 临时功能分支与 worktree 已删除；主分支工作区在生成本交接前干净。
- 2026-11-02 完整执行 `npm run check`，55 项测试全部通过。
- 当前本地服务通过 `npm start` 运行在 `http://localhost:4173`，进程会话结束后需重新启动。

## Pending

- 写短设计文档并让用户批准。
- 为外部媒体模式写实现计划和回归测试。
- 删除乐手端 `#sync-cursor`、拍点坐标映射和手工 `scrollLeft` 跟随逻辑。
- 乐手端启用 AlphaTab 外部媒体播放器，由服务器播放状态驱动 `play/pause/updatePosition`，保持无音频输出。
- 验证定速、变速、反复、跳房子、切轨、重连、暂停和跳转场景。
- 在真实手机浏览器检查原生滚动、性能与绝对静音。

## Modified Files

本交接操作新增 `HANDOFF.md`；`.agent-continuity/` 是本地生成的检查点目录，不应提交。

## Architecture

- `server/index.js`：Express、WebSocket、房间唯一播放时钟、曲谱/视频来源生命周期。
- `public/app.js`：主机/乐手共用前端、AlphaTab 与视频适配逻辑。
- `public/styles.css`：AlphaTab 原生游标样式及现有自绘 `#sync-cursor` 样式。
- `test/server.integration.test.js`：服务端与真实 HTTP/WebSocket 集成测试。
- `test/app.video.test.js`：VM 驱动的真实前端行为测试，目前主要覆盖视频与切源。
- AlphaTab 版本为 `1.8.4`，本地类型定义确认支持 `PlayerMode.EnabledExternalMedia` 和 `IExternalMediaSynthOutput.updatePosition()`。

## Decisions

- 不再美化或修补自绘蓝线，因为其坐标映射在缩放、重排和反复段下容易错位。
- 采用 AlphaTab `EnabledExternalMedia`，而不是静音合成器：保留原生游标/高亮/滚动，同时避免每台手机加载 SoundFont、运行 WebAudio或请求音频权限。
- 服务端仍是唯一权威时钟；乐手端不能控制播放，也不能发声。
- 当前稳定点用 Git 备份分支 `backup/pre-native-client-cursor-20261102` 保存。

## Issues

- 需要确认 AlphaTab 外部媒体输出在 10Hz 服务端状态更新下的游标动画是否足够平滑。
- 外部媒体 API 的 `output.updatePosition()` 需要运行时类型收窄或安全能力检测。
- 原生滚动容器必须指向 `#alpha-tab`，不能继续使用当前 `document.documentElement`，否则移动端全屏和卡片布局可能滚错容器。
- 真实手机的后台恢复、页面可见性和性能仍需人工验证。

## Failed Attempts

- 不要继续通过 `boundsLookup` 自行绘制整高蓝线；该方案正是本次要替换的根因。
- 在受限执行环境直接跑集成测试会出现 `listen EPERM: operation not permitted 0.0.0.0`；需要允许测试创建临时本地监听端口。

## Tests

- 最近完整命令：`npm run check`
- 最近结果：55 tests、55 pass、0 fail。
- 入口修复线上检查：`/` 返回 `302 Location: /host`，`/host` 包含主机页面。

## Environment

- 仓库：`/Users/ming/Desktop/Band-Room/band-room`
- Node.js 24.19.0；包管理器使用 pnpm 锁文件，但项目脚本通过 npm 调用。
- 当前分支：`main`，在生成本交接时比 `origin/main` 领先 18 个提交。
- 启动：`npm start`；主机入口 `http://localhost:4173/host`；乐手入口 `/join?room=...`。

## Next Steps

1. 基于已选方案编写 `docs/superpowers/specs/2026-11-02-native-member-cursor-design.md`，发给用户确认。
2. 设计批准后读取并使用 `superpowers:writing-plans`，形成测试驱动实施计划。
3. 按子代理驱动方式实现和复核（用户此前明确要求“子代理驱动”）。
4. 完整执行 `npm run check`，重启本地 `4173` 服务，再由用户用真实客户端验收。

## Recovery

先阅读本文件，然后运行 `git status --short --branch` 和 `git log -3 --oneline`。稳定基线可从 `backup/pre-native-client-cursor-20261102` 恢复或对比。不要推送远端，除非用户明确要求。
<!-- AGENT-CONTINUITY:SEMANTIC:END -->
