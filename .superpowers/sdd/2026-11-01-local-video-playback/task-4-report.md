# Task 4 报告：客户端视频同步决策

## RED / GREEN

- RED：先新增 `test/video-sync.test.js`，`node --test test/video-sync.test.js` 因 `public/video-sync.js` 不存在而失败，符合预期。
- GREEN：实现纯函数模块后，同一命令通过 4/4 项测试。测试覆盖服务端播放位置外推、暂停 seek 可与暂停动作并存、成员追赶速率方向和限幅、硬 seek、主机策略、阈值内恢复 1 倍速及缓冲未就绪时抑制播放请求。

## 实现

- 新增 `VIDEO_SYNC` 常量，集中保存 150/250/1000 ms 阈值和 0.97–1.03 倍速范围。
- `targetVideoPositionMs` 规范化非有限/负数输入，仅在服务端播放时增加消息到达后的耗时，并保证返回有限非负值。
- `decideVideoSync` 返回 `{ shouldPause, shouldPlay, seekToMs, playbackRate }`；偏差较大时可同时暂停并 seek。成员按偏差方向在中等漂移时变速，较大漂移时直接 seek；主机不变速。媒体 `readyState < 2` 时不请求播放。
- 无 DOM 或 `HTMLVideoElement` 操作。

## 测试

- `node --test test/video-sync.test.js`：通过，4/4。
- `npm run check`：语法检查通过；同步模块测试通过。集成测试因监听 `0.0.0.0` 报 `listen EPERM: operation not permitted 0.0.0.0`，完整命令退出码 1。按任务指示由控制器在其环境补跑。
- `git diff --check`：通过。

## 文件

- 新增 `public/video-sync.js`
- 新增 `test/video-sync.test.js`
- 新增本报告

## 自审

- 结果对象能同时表达暂停和 seek，没有合并为单一 action。
- 成员落后目标时速率大于 1，超前时小于 1，且受 0.97–1.03 限制；偏差回到 250 ms 内恢复 1。
- 非播放状态超过 150 ms 时输出 seek；主机播放中超过 250 ms 直接 seek；成员播放中超过 1000 ms 直接 seek。
- 未发现额外文件改动；当前唯一验证限制为完整集成测试的监听权限错误。
