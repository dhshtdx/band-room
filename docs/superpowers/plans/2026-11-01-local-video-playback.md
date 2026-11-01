# 本地视频同步播放 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主机导入本地 MP4/WebM，服务端以 HTTP Range 流式提供给房间设备，并由现有服务端时钟同步播放、暂停和跳转；声音只在主机输出。

**Architecture:** 房间内容统一为互斥的 `source`（`score` 或 `video`），播放时钟只依赖来源的可选时长。视频通过受主机令牌保护的原始 HTTP 请求上传，以唯一来源 ID 的 Range 端点读取；前端用 AlphaTab 与 HTMLVideoElement 两个适配器消费同一播放状态。浏览器无关的 Range、格式和漂移决策拆到纯函数模块，服务端生命周期与 UI 行为由集成测试和人工验收覆盖。

**Tech Stack:** Node.js 20+、Express 5、WebSocket (`ws`)、HTMLVideoElement、AlphaTab、Node test runner

**Spec:** `docs/superpowers/specs/2026-11-01-local-video-playback-design.md`

## Global Constraints

- 只接收 `.mp4`（`video/mp4`）和 `.webm`（`video/webm`），同时校验扩展名、MIME 和有限文件签名。
- 单个视频上限固定为 `2 * 1024 * 1024 * 1024` 字节；上传流不得整体进入内存，也不得走 WebSocket/Base64。
- 不新增 ffmpeg、转码器或第三方视频抓取能力。
- Guitar Pro 与本地视频是互斥来源；新来源完全成功前保留旧来源。
- 主机令牌保护上传、时长登记和播放控制；成员读取当前房间视频但永久静音。
- 成员漂移阈值集中为常量：`PAUSED_SEEK_MS = 150`、`RATE_ADJUST_MS = 250`、`HARD_SEEK_MS = 1000`、播放速率范围 `0.97–1.03`。
- 临时视频仅保存在 `BAND_ROOM_DATA_DIR` 下；切换来源、房间过期和服务退出时清理。
- 不降低现有曲谱同步、32 台设备上限、安全响应头与离线运行能力。

## Review Focus

- 上传声明为合法 MIME 但签名错误或请求中途断开时：删除 `.upload`，保留旧来源；Task 3 集成测试覆盖。
- 两次上传并发且旧请求后完成时：仅最后开始的上传可成为来源，旧请求返回 `409` 并删除临时文件；Task 3 集成测试覆盖。
- Range 包含后缀范围、多范围、越界或无效数字时：合法单范围返回准确 `206`，其余返回 `416`；Task 1 单测与 Task 3 集成测试覆盖。
- 成员页面自动播放受限、视频缓冲、切后台或重连时：始终保持静音，并在可播放/恢复可见后按最新状态硬校正；Task 4 单测与 Task 5 静态/人工验收覆盖。
- 切换来源时仍有旧视频读取连接或 Windows 暂时锁定文件：旧 URL 立即失效，删除采用有限重试且不阻塞新来源；Task 2 单测与 Task 3 集成测试覆盖。

---

### Task 1: 媒体格式与 Range 协议纯函数

**Files:**
- Create: `server/video-media.js`
- Create: `test/video-media.test.js`

**Interfaces:**
- Produces: `MAX_VIDEO_BYTES`，值为 `2 * 1024 * 1024 * 1024`。
- Produces: `validateVideoDescriptor({ fileName, mimeType, contentLength? }) -> { fileName, extension, mimeType, contentLength? }`；已知长度必须合法，分块请求允许长度未知并由流式计数做最终限制；无效输入抛出带安全中文消息的 `VideoMediaError`。
- Produces: `hasValidVideoSignature(mimeType, headerBytes) -> boolean`；MP4 检查偏移 4 的 `ftyp`，WebM 检查开头 EBML `1a45dfa3`。
- Produces: `parseSingleRange(rangeHeader, size) -> null | { start, end, length }`；无 Range 返回 `null`，无效/多范围抛出 `RangeNotSatisfiableError`。

- [ ] **Step 1: 写格式描述与签名失败测试**

在 `test/video-media.test.js` 断言：合法 MP4/WebM 和未知请求长度被规范化；已知空文件、超过 2 GiB、扩展名/MIME 不匹配、MP4 无 `ftyp`、WebM 无 EBML 均被拒绝，错误消息不含磁盘路径。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/video-media.test.js`

Expected: FAIL，原因是 `server/video-media.js` 不存在。

- [ ] **Step 3: 实现格式接口**

在 `server/video-media.js` 导出 `VideoMediaError`、`MAX_VIDEO_BYTES`、`validateVideoDescriptor` 和 `hasValidVideoSignature`；文件名先经 `basename()`，只接受有限映射，不相信用户 MIME。

- [ ] **Step 4: 运行格式测试确认通过**

Run: `node --test test/video-media.test.js`

Expected: PASS。

- [ ] **Step 5: 写 Range 失败测试**

加入完整范围 `bytes=0-3`、开放结尾 `bytes=4-`、后缀 `bytes=-4`、缺失 Range，以及多范围、负数、反向、越界、非数字和零长度资源测试；断言 `{ start, end, length }` 与异常类型。

- [ ] **Step 6: 运行 Range 测试确认失败**

Run: `node --test test/video-media.test.js`

Expected: FAIL，原因是 `parseSingleRange` 尚未导出或行为不完整。

- [ ] **Step 7: 实现 `parseSingleRange(rangeHeader, size)`**

严格只解析 `bytes=` 单范围；后缀长度大于文件时从 0 开始；任一无效输入抛出 `RangeNotSatisfiableError`，供 HTTP 层映射为 `416`。

- [ ] **Step 8: 运行单测并提交**

Run: `node --test test/video-media.test.js`

Expected: PASS。

```bash
git add server/video-media.js test/video-media.test.js
git commit -m "feat: add video media validation helpers"
```

### Task 2: 房间统一播放源模型

**Files:**
- Modify: `server/index.js`
- Modify: `public/app.js`
- Modify: `test/server.integration.test.js`

**Interfaces:**
- Consumes: Task 1 的媒体常量将在后续任务使用，本任务不改变其接口。
- Produces: `room.source`，公开形状至少为 `{ kind, id, fileName, durationMs? }`；曲谱继续包含既有元数据。
- Produces: `publicSource(source)` 去除 `storagePath`；`replaceSource(room, nextSource)` 暂停、归零、原子替换、广播并异步清理旧文件。
- Produces: WebSocket/加入事件使用 `source` 和 `source:loaded`，前端 `renderSource(source)` 对 `kind: 'score'` 保持现有体验。

- [ ] **Step 1: 写来源迁移失败测试**

修改曲谱集成测试：`room:joined.source` 初始为 `null`；曲谱上传收到 `source:loaded`，其中 `source.kind === 'score'`、存在不可预测 `id` 且不暴露 `storagePath`；加载后播放跳转仍正常。

- [ ] **Step 2: 运行集成测试确认失败**

Run: `node --test test/server.integration.test.js`

Expected: FAIL，现有协议仍返回 `score`/`score:loaded`。

- [ ] **Step 3: 服务端迁移到 `source`**

在 `server/index.js` 中把曲谱包装为带随机 ID 的 `kind: 'score'` 来源；新增 `publicSource`、`removeStoredSource`（对临时锁定错误做短次数退避重试）与 `replaceSource`。`playbackState` 从 `room.source?.durationMs` 裁剪，tick/小节字段仅在曲谱来源时计算，视频/空来源返回稳定的默认值或省略曲谱专有值。

- [ ] **Step 4: 前端保持曲谱来源兼容**

在 `public/app.js` 将 `score` 状态替换为 `source`，新增 `renderSource` 并把既有曲谱渲染逻辑收进 `renderScoreSource`；处理 `source:loaded` 和加入事件的 `source`，曲谱 URL 使用当前来源 ID 防止陈旧缓存。

- [ ] **Step 5: 更新曲谱读取端点并验证**

将曲谱读取改为 `GET /api/rooms/:roomId/score/:sourceId`，只有当前曲谱来源 ID 匹配才返回；加入旧 ID 在切换后返回 `404` 的测试。

Run: `npm run check`

Expected: 全部 PASS，现有曲谱 UI 语法检查通过。

- [ ] **Step 6: 提交来源迁移**

```bash
git add server/index.js public/app.js test/server.integration.test.js
git commit -m "refactor: unify room playback sources"
```

### Task 3: 视频原始上传与 Range 流式端点

**Files:**
- Modify: `server/video-media.js`
- Modify: `server/index.js`
- Modify: `test/server.integration.test.js`

**Interfaces:**
- Consumes: Task 1 的 `MAX_VIDEO_BYTES`、描述/签名校验和 Range 解析。
- Consumes: Task 2 的 `replaceSource(room, nextSource)` 与公开来源模型。
- Produces: `streamVideoUpload({ request, temporaryPath, maxBytes }) -> Promise<{ size, headerBytes }>`，逐块写盘、保留足够的签名头，失败删除临时文件。
- Produces: `POST /api/rooms/:roomId/video` 与 `GET /api/rooms/:roomId/video/:sourceId`。
- Produces: WebSocket `source:set-duration`，参数 `{ hostToken, sourceId, durationMs }`。

- [ ] **Step 1: 写授权、格式和失败原子性测试**

在集成测试增加真实的小型 MP4/WebM 标识字节上传；断言无/错 Bearer 令牌为 `401/403`，空文件、错误 MIME/扩展名/签名为 `400/413`，失败上传后原来源不变且 `videos/` 无 `.upload`。

- [ ] **Step 2: 运行目标测试确认失败**

Run: `node --test --test-name-pattern="视频上传" test/server.integration.test.js`

Expected: FAIL，端点为 `404`。

- [ ] **Step 3: 实现流式上传和并发代次**

在 `server/video-media.js` 用 `createWriteStream` 与请求流实现 `streamVideoUpload`；在 `server/index.js` 为每个房间维护单调递增的 `uploadRevision`。请求开始即占用新代次，只有仍为最新代次的完成请求可 `replaceSource`；过期完成请求删除文件并返回 `409`。响应和广播的来源为 `{ kind: 'video', id, fileName, mimeType, size, storagePath }`。

- [ ] **Step 4: 运行上传测试确认通过**

Run: `node --test --test-name-pattern="视频上传" test/server.integration.test.js`

Expected: PASS。

- [ ] **Step 5: 写 Range 与陈旧来源失败测试**

上传已知字节视频后断言：无 Range 为 `200`；`bytes=4-7` 和 `bytes=-4` 为 `206` 且正文、`Content-Range`、`Content-Length`、`Accept-Ranges`、MIME、`Cache-Control: no-store` 正确；多范围/越界为 `416`；来源切换后旧 URL 为 `404`，已开始的读取能安全结束。

- [ ] **Step 6: 实现 Range 文件流**

在视频 GET 路由中调用 `stat` 和 `parseSingleRange`，用 `createReadStream({ start, end })` 输出；把 `RangeNotSatisfiableError` 映射为带 `Content-Range: bytes */<size>` 的 `416`，不向响应暴露路径。

- [ ] **Step 7: 写并实现时长登记测试**

测试成员/错误令牌、错误来源 ID、`NaN`/非正数/超过 24 小时均被拒绝；主机为当前视频登记 `durationMs` 后广播 `source:loaded`，播放跳转被时长裁剪并在结尾暂停。实现 `source:set-duration`，允许范围 `(0, 86_400_000]`。

- [ ] **Step 8: 全量验证并提交**

Run: `npm run check`

Expected: 全部 PASS。

```bash
git add server/video-media.js server/index.js test/server.integration.test.js
git commit -m "feat: stream local videos through room server"
```

### Task 4: 客户端视频同步决策

**Files:**
- Create: `public/video-sync.js`
- Create: `test/video-sync.test.js`

**Interfaces:**
- Produces: `VIDEO_SYNC` 常量，包含全局约束中的四个漂移/速率值。
- Produces: `targetVideoPositionMs(playback, elapsedSinceMessageMs) -> number`。
- Produces: `decideVideoSync({ isHost, isPlaying, targetMs, currentMs, paused, readyState, playbackRate }) -> { shouldPause, shouldPlay, seekToMs, playbackRate }`；一个结果可同时要求暂停与校正位置。

- [ ] **Step 1: 写目标位置与暂停决策失败测试**

断言播放状态会增加消息到达后的本地耗时，暂停状态不会；暂停播放器返回 `shouldPause: true`，暂停偏差超过 150 ms 时同时给出 `seekToMs`，阈值内 `seekToMs` 为 `null`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/video-sync.test.js`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现目标位置和暂停决策**

所有输入先规范化为有限非负数；决策函数只返回动作，不触碰 DOM 或 HTMLVideoElement。

- [ ] **Step 4: 写播放漂移失败测试**

断言：未播放且服务端播放时返回 `shouldPlay: true`；成员偏差 `<250 ms` 不跳转、`250–1000 ms` 返回限于 `0.97–1.03` 的速率、`>1000 ms` 给出 `seekToMs`；回到阈值内时把非 1 速率恢复为 `1`；主机不变速，超过 250 ms 直接给出 `seekToMs`；`readyState < 2` 时不反复请求播放。

- [ ] **Step 5: 实现播放决策并验证**

Run: `node --test test/video-sync.test.js`

Expected: PASS。

- [ ] **Step 6: 提交同步算法**

```bash
git add public/video-sync.js test/video-sync.test.js
git commit -m "feat: add deterministic video sync decisions"
```

### Task 5: 视频上传、显示与房间控制 UI

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Modify: `test/server.integration.test.js`

**Interfaces:**
- Consumes: Task 2 的 `source`/`source:loaded` 协议与 Task 3 的视频端点、时长消息。
- Consumes: Task 4 的 `targetVideoPositionMs` 和 `decideVideoSync`。
- Produces: `renderVideoSource(source)`、`applyVideoPlayback(playback)`、`uploadSelectedVideo(file)` 和统一的全屏目标选择。

- [ ] **Step 1: 写页面结构失败测试**

扩展静态页面集成断言：存在 `#video-file`（accept `.mp4,.webm`）、`#load-video`、`#video-player`（`playsinline`、`preload="metadata"`、无 `controls`）和 `#media-status`；主机动作区仍包含曲谱输入。

- [ ] **Step 2: 运行页面测试确认失败**

Run: `node --test --test-name-pattern="主机页面" test/server.integration.test.js`

Expected: FAIL，视频元素不存在。

- [ ] **Step 3: 实现排练内容 UI 与来源切换**

更新 `public/index.html`/`styles.css`：把“曲谱”改为“排练内容”，为视频加入响应式 `max-width: 100%`、黑色背景和全屏样式。`renderSource` 必须销毁/暂停非当前适配器、复位同步状态，并只显示当前来源相关控件。

- [ ] **Step 4: 实现原始文件上传**

`uploadSelectedVideo(file)` 在客户端校验类型和 2 GiB 上限，用 `fetch` 发送 `File` 本体、Bearer 令牌、编码文件名及 MIME。上传期间禁用按钮并显示“不确定进度”；成功依靠 `source:loaded` 渲染，失败显示服务端中文错误且恢复按钮。

- [ ] **Step 5: 实现主机/成员视频策略**

`renderVideoSource` 设置唯一来源 URL；成员每次渲染及 `volumechange` 都强制 `muted/defaultMuted/volume=0`，主机允许声音。主机 `loadedmetadata` 发送 `source:set-duration`；成员不得发送。`error` 显示编码/文件损坏提示，`waiting`/`playing` 更新缓冲状态。

- [ ] **Step 6: 接入统一播放控制和同步决策**

主机点击播放时先在用户手势中 `await video.play()`，成功后才发送服务端播放；失败时保持服务端暂停。暂停、跳转、`ended`、收到状态、`canplay`、`visibilitychange` 和 WebSocket 重连均调用统一视频适配器；成员 `play()` 拒绝时保留最新状态并在下一次用户交互/可播放事件重试，始终静音。

- [ ] **Step 7: 实现视频全屏与静态验证**

现有全屏按钮根据来源选择 `#alpha-tab` 或 `#video-player`；沉浸式降级同时支持视频。更新页面资源版本查询参数避免旧客户端缓存。

Run: `npm run check`

Expected: 全部 PASS，`node --check public/app.js` 无错误。

- [ ] **Step 8: 人工双设备冒烟并提交**

Run: `npm run dev`

Expected: 主机上传兼容 MP4 后，主机有声、成员静音；播放/暂停/跳转后两端在 1 秒内对齐；刷新成员或切后台恢复后重新对齐；切回曲谱仍可渲染和播放。

```bash
git add public/index.html public/styles.css public/app.js test/server.integration.test.js
git commit -m "feat: add synchronized local video controls"
```

### Task 6: 清理、隐私说明与发布防泄漏

**Files:**
- Modify: `server/index.js`
- Modify: `scripts/release-preflight.mjs`
- Modify: `public/legal.html`
- Modify: `PRIVACY.md`
- Modify: `README.md`
- Modify: `test/server.integration.test.js`

**Interfaces:**
- Consumes: Task 2 的 `removeStoredSource`，Task 3 的 `videos/` 和 `.upload` 生命周期。
- Produces: 服务停止和房间过期的完整视频清理；发布预检拒绝在 `public/`、`build/` 中出现视频文件。

- [ ] **Step 1: 写生命周期和预检失败测试**

在集成测试断言切换来源删除旧文件；补一个可注入短清理宽限期的测试，最后成员离开后来源文件及 `.upload` 消失。为发布预检提取/导出 `containsUserMedia(directory)`，以 `import.meta.url` 直接运行保护包裹命令行入口，新增单测断言 GP、MP4、WebM 均被识别且导入模块不会执行预检。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/server.integration.test.js test/release-preflight.test.js`

Expected: FAIL，视频清理或媒体检测尚未覆盖。

- [ ] **Step 3: 完成清理路径和发布检查**

`scheduleRoomCleanup`、`stopBandRoomServer` 和上传错误统一调用来源/临时文件清理；支持测试专用 `BAND_ROOM_CLEANUP_GRACE_MS`，生产默认仍为 `60_000`。发布预检把视频扩展名加入用户媒体检查，错误文案改为“曲谱或视频文件”。

- [ ] **Step 4: 更新用户与隐私文档**

README 增加本地视频、MP4/WebM、2 GiB、主机有声/成员静音和浏览器编码兼容说明；`public/legal.html` 与 `PRIVACY.md` 明确视频临时存储并在房间内共享、用户应拥有使用权、不上传公网。

- [ ] **Step 5: 全量自动验证**

Run: `npm run check`

Expected: 所有语法检查和测试 PASS，无悬挂进程或临时文件错误。

- [ ] **Step 6: 发布预检**

Run: `node scripts/release-preflight.mjs`

Expected: 输出 `打包前检查通过（Band Room 1.0.4）。`，允许既有未签名构建提醒。

- [ ] **Step 7: 提交文档与清理**

```bash
git add server/index.js scripts/release-preflight.mjs public/legal.html PRIVACY.md README.md test/server.integration.test.js test/release-preflight.test.js
git commit -m "docs: document local video privacy and lifecycle"
```

- [ ] **Step 8: 工作树与差异复核**

Run: `git status --short && git diff --check && git log --oneline origin/main..HEAD`

Expected: 无未提交实现文件，`git diff --check` 无输出，提交序列只包含设计、计划及本功能提交。
