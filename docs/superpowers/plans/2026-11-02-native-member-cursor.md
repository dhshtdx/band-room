# 乐手端 AlphaTab 原生游标实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 AlphaTab 外部媒体模式替换乐手端自绘蓝线，使乐手获得原生游标、音符高亮和自动滚动，同时保持绝对静音和服务端权威时钟。

**Architecture:** 新建一个浏览器无关的乐手曲谱同步适配器，负责安装无音频 external-media handler、能力检测和播放状态应用；`public/app.js` 只负责 AlphaTab 生命周期与服务端消息编排。主机合成器路径和视频适配器保持不变，旧 `boundsLookup` 蓝线及手工滚动整体删除。

**Tech Stack:** JavaScript ES modules、AlphaTab 1.8.4 `PlayerMode.EnabledExternalMedia`、WebSocket、Node.js test runner、VM 浏览器边界测试

**Spec:** `docs/superpowers/specs/2026-11-02-native-member-cursor-design.md`

## Global Constraints

- 服务端仍是唯一权威时钟；不修改 WebSocket 协议或服务端播放时间线。
- 乐手端不得加载 SoundFont、创建可发声媒体元素、请求音频权限或产生声音。
- 主机继续使用 `PlayerMode.EnabledSynthesizer`，现有伴奏、点击跳转和原生游标行为不变。
- 乐手端不能通过 AlphaTab 默认交互控制播放，`enableUserInteraction` 必须为 `false`。
- 视频来源及其主机有声、乐手静音、同步和切源行为不得回归。
- 外部媒体能力缺失时显示可诊断错误，不回退到自绘蓝线。

## Review Focus

- 服务端播放状态早于 AlphaTab `playerReady` 到达：最新状态必须在 ready 后补应用，不能丢失或重复切换。
- 连续收到相同 `isPlaying` 的 100 ms 快照：位置持续更新，但 `play()`/`pause()` 只在状态边沿调用。
- 切源、切轨或销毁后旧 player 仍触发回调：不得驱动新来源、创建残留游标或访问已销毁实例。
- 暂停跳转、重连和页面从后台恢复：原生游标必须立即落在最新权威位置。
- AlphaTab 外部媒体输出缺少 `updatePosition()` 或 player 尚未建立：必须安全等待或报告诊断，不能抛出未捕获异常。

---

### Task 1: 无音频外部媒体同步适配器

**Files:**
- Create: `public/member-score-sync.js`
- Create: `test/member-score-sync.test.js`

**Interfaces:**
- Consumes: AlphaTab API 的 `player`, `player.output.updatePosition(ms)`, `isReadyForPlayback`, `play()`, `pause()`, `masterVolume`；服务端 `{ positionMs, isPlaying }` 播放状态。
- Produces: `MemberScoreSyncError`；`attachSilentExternalMedia(api, durationMs): boolean`；`applyMemberScorePlayback(api, playback, previousPlaying): { applied: boolean, isPlaying: boolean | null }`。

- [ ] **Step 1: 写 external-media handler 的失败测试**

在 `test/member-score-sync.test.js` 增加 `安装外部媒体 handler 时始终静音且不控制真实媒体`：构造带 `player.output.updatePosition` 的真实形状 fake API，断言 `attachSilentExternalMedia(api, 12000)` 返回 `true`，`player.handler.backingTrackDuration === 12000`，读写 `masterVolume` 后仍为 `0`，`play/pause/seekTo` 不产生外部副作用，且 API/player 音量均被设为 `0`。

- [ ] **Step 2: 运行测试并确认按预期失败**

Run: `node --test test/member-score-sync.test.js`

Expected: FAIL，原因是 `public/member-score-sync.js` 或导出接口尚不存在。

- [ ] **Step 3: 最小实现 handler 安装接口**

在 `public/member-score-sync.js` 实现：

- `class MemberScoreSyncError extends Error`
- `attachSilentExternalMedia(api, durationMs): boolean`

`durationMs` 归一化为非负有限数；player 尚不存在时返回 `false`；output 存在但没有 `updatePosition()` 时抛出 `MemberScoreSyncError`；安装的 handler 只保存 `playbackRate`，音量 getter 恒为 `0`、setter 忽略，媒体控制方法为空操作。

- [ ] **Step 4: 运行定向测试确认 handler 测试通过**

Run: `node --test --test-name-pattern='安装外部媒体 handler' test/member-score-sync.test.js`

Expected: 1 pass、0 fail。

- [ ] **Step 5: 写状态应用的失败测试**

增加以下测试：

- `player 未 ready 时保留 previousPlaying 且不更新位置`
- `首次播放更新位置并调用一次 play，重复播放快照只更新位置`
- `暂停边沿调用一次 pause，暂停跳转仍更新位置`
- `缺少 updatePosition 时抛出可诊断错误`

断言位置使用手写字面值 `4200`、`5100`、`7000`，不通过被测代码计算期望值。

- [ ] **Step 6: 运行测试并确认新用例失败**

Run: `node --test test/member-score-sync.test.js`

Expected: handler 安装用例通过；状态应用用例因 `applyMemberScorePlayback` 尚未实现而失败。

- [ ] **Step 7: 最小实现状态应用接口**

实现 `applyMemberScorePlayback(api, playback, previousPlaying)`：未 ready/player 未建立时返回 `{ applied: false, isPlaying: previousPlaying }`；能力有效时先强制静音，再调用 `output.updatePosition(positionMs)`；仅当布尔播放状态发生变化时调用 `api.play()` 或 `api.pause()`；返回已应用状态。非法位置归一化为 `0`，不自行推算服务器时间。

- [ ] **Step 8: 运行适配器测试与语法检查**

Run: `node --check public/member-score-sync.js && node --test test/member-score-sync.test.js`

Expected: 全部通过、0 fail。

- [ ] **Step 9: 提交 Task 1**

```bash
git add public/member-score-sync.js test/member-score-sync.test.js
git commit -m "feat: add silent member score sync adapter"
```

---

### Task 2: 接入 AlphaTab 原生游标并删除自绘蓝线

**Files:**
- Modify: `public/app.js:1-180, 298-344`
- Modify: `public/styles.css:10-14`
- Modify: `test/app.video.test.js:7-45, 211-236`
- Test: `test/member-score-sync.test.js`

**Interfaces:**
- Consumes: Task 1 的 `attachSilentExternalMedia(api, durationMs)` 与 `applyMemberScorePlayback(api, playback, previousPlaying)`。
- Produces: 乐手 AlphaTab 初始化配置；`initializeMemberScorePlayer(api): boolean`；`syncMemberScorePlayback(playback): void`；不再产生 `#sync-cursor` DOM 或手工 `scrollLeft`。

- [ ] **Step 1: 扩展 VM 浏览器 fake，使测试可观察 AlphaTab 原生播放器边界**

在 `test/app.video.test.js` 的 `browser()` 增加可注入的 Task 1 导出，并让 member AlphaTab fake 暴露 `player.handler`、`player.output.updatePosition`、`playerReady`、`play()`、`pause()` 和构造设置。只记录真实应用对这些边界的调用，不复制同步算法。

- [ ] **Step 2: 写乐手原生配置的失败测试**

新增 `乐手曲谱使用外部媒体原生游标且不加载音色`，加载 score 来源并断言：

- `playerMode === alphaTab.PlayerMode.EnabledExternalMedia`
- `soundFont === null`
- `enableCursor === true`
- `enableElementHighlighting === true`
- `enableAnimatedBeatCursor === true`
- `enableUserInteraction === false`
- `scrollElement === #alpha-tab` 元素
- DOM 中没有创建 `#sync-cursor`

- [ ] **Step 3: 运行配置测试并确认失败原因是现有 Disabled/自绘路径**

Run: `node --test --test-name-pattern='乐手曲谱使用外部媒体原生游标' test/app.video.test.js`

Expected: FAIL，显示乐手 `playerMode`/原生 cursor 配置不符或仍尝试建立 `#sync-cursor`。

- [ ] **Step 4: 接入角色化 AlphaTab 设置**

修改 `initializeAlphaTab()`：主机设置保持现状；乐手使用 `EnabledExternalMedia`、空 SoundFont、原生游标/高亮、关闭用户交互，滚动容器设为当前 `scoreElement`。新增 `initializeMemberScorePlayer(api)`，只对当前仍有效的 member API 调用 Task 1 安装接口，异常交给 `reportRuntimeError('MemberScoreSync', error)`。

- [ ] **Step 5: 写播放状态生命周期的失败测试**

新增：

- `乐手在 playerReady 后补应用先到达的播放状态`
- `连续播放快照只切换一次状态并持续更新原生位置`
- `暂停跳转、重连与页面恢复应用最新权威位置`
- `切轨或切源后的旧 playerReady 不驱动新来源`
- `外部媒体能力缺失显示运行错误且不创建蓝线`

测试明确断言 `updatePosition()` 收到服务端字面位置，且 host fake 仍为 `EnabledSynthesizer`、视频来源不调用 member score adapter。

- [ ] **Step 6: 运行生命周期测试并确认失败**

Run: `node --test --test-name-pattern='乐手在 playerReady|连续播放快照|暂停跳转|旧 playerReady|外部媒体能力缺失' test/app.video.test.js`

Expected: 新增用例失败，已有视频用例继续通过。

- [ ] **Step 7: 实现 member 状态编排**

在 `public/app.js`：

- 导入 Task 1 接口，增加 `memberScorePlaying` 状态。
- `playerReady` 时验证 `alphaTabApi === api` 且当前仍为 score/member，再安装 handler 并补应用 `latestPlayback`。
- `renderPlayback()` 的 score/member 分支调用 `syncMemberScorePlayback(playback)`；host 分支保持现有合成器逻辑。
- 页面恢复可见时，在请求权威状态前安全重应用缓存状态；随后由服务器响应校准。
- 切源、切轨和房间失效时复位 member 状态，旧回调必须通过 API/来源身份检查退出。

- [ ] **Step 8: 删除旧蓝线、手工滚动和相关清理**

从 `public/app.js` 删除 `followerCursor`、`followerBuildTimer`、`scheduleFollowerBuild()`、`buildFollower()`、`followFollowerCursor()`、`updateFollower()`、所有 `#sync-cursor` 创建/删除和自绘坐标调试字段；从 `public/styles.css` 删除 `#sync-cursor` 规则。保留 WebSocket、server tick、小节/拍点、AlphaTab 状态和最后消息时间诊断。

- [ ] **Step 9: 运行前端定向测试**

Run: `node --check public/app.js && node --test test/member-score-sync.test.js test/app.video.test.js`

Expected: 全部通过、0 fail；主机视频和曲谱切换既有用例仍通过。

- [ ] **Step 10: 运行静态残留检查**

Run: `rg -n 'sync-cursor|followerCursor|followerBuildTimer|buildFollower|updateFollower|followFollowerCursor' public test`

Expected: 无匹配，命令退出码为 1。

- [ ] **Step 11: 运行完整验证**

Run: `npm run check`

Expected: 所有语法、单元与集成测试通过，0 fail。

- [ ] **Step 12: 提交 Task 2**

```bash
git add public/app.js public/styles.css test/app.video.test.js
git commit -m "feat: use native member score cursor"
```

- [ ] **Step 13: 重启本地服务并人工验收**

停止旧 `npm start`，重新启动 `npm start`。主机创建房间并加载包含定速、变速、反复/跳房子的 Guitar Pro 文件；真实手机切轨、暂停、跳转、横竖屏、全屏、切后台再恢复。验收：乐手端只有 AlphaTab 原生游标/高亮/滚动，无蓝线、无声音、无音频权限提示，位置与主机一致。

---

## 自检结果

- 规格覆盖：原生游标、高亮、滚动、绝对静音、服务端权威、主机/视频不回归、能力错误、回退点均有对应任务或验收步骤。
- 步骤粒度：每一步只包含测试、失败验证、单一实现、验证或提交中的一种动作；旧实现删除集中在单独步骤。
- 接口一致：Task 2 只消费 Task 1 明确定义的两个函数和错误类型。
- 高风险输入：ready 时序、重复快照、陈旧回调、恢复/跳转和缺失能力均在 Task 2 测试中固定。
- 比例：计划聚焦两个职责边界，没有改动服务端协议或扩展为无关重构。
