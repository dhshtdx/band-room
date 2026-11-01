# 乐手端 AlphaTab 原生游标设计

## 意图

乐手端不再使用自绘整高蓝线和手工横向滚动。Guitar Pro 曲谱播放时，乐手端改用与主机一致的 AlphaTab 原生小节游标、拍点游标、音符高亮和自动滚动，同时继续保证只有主机发声、主机独占控制、服务端是唯一权威时钟。

## 目标与非目标

目标：

- 删除容易因缩放、反复段、切轨和重新排版而错位的 `#sync-cursor`。
- 乐手端使用 AlphaTab 原生游标、高亮和滚动。
- 乐手端不加载 SoundFont、不创建 WebAudio 输出、不请求音频权限，也不发声。
- 播放、暂停、跳转、重连和后台恢复仍以服务端状态为准。
- 主机端现有合成器播放、点击跳转和伴奏行为保持不变。

非目标：

- 不改变曲谱解析、服务端时间线或 WebSocket 协议。
- 不允许乐手端控制播放。
- 不改变本地视频同步逻辑。
- 本次不重新设计页面布局或主机端游标样式。

## 已考虑方案

1. **AlphaTab 外部媒体模式（采用）**：乐手端使用 `PlayerMode.EnabledExternalMedia`，以服务端位置作为外部媒体时间轴。无需音色和音频输出，仍能使用 AlphaTab 原生游标。
2. **静音合成器**：让乐手端运行完整合成器并把音量设为零。视觉最接近主机，但每台设备都要加载音色、生成音频并处理浏览器自动播放限制，资源成本过高。
3. **修补自绘游标**：继续调整蓝线样式和坐标映射。无法从根本上消除缩放、重排和反复段错位，因此放弃。

## 前端设计

### AlphaTab 初始化

主机保持 `EnabledSynthesizer`、SoundFont 和现有原生游标配置。

乐手端改为：

- `playerMode: PlayerMode.EnabledExternalMedia`
- `soundFont: null`
- `enableCursor: true`
- `enableElementHighlighting: true`
- `enableAnimatedBeatCursor: true`
- `enableUserInteraction: false`
- `scrollElement` 指向当前 `#alpha-tab` 容器
- `scrollMode: ScrollMode.OffScreen`

外部媒体 handler 只提供 AlphaTab 所需的时长、播放速度、静音音量和空的 `play/pause/seekTo` 接口，不连接任何音频或视频元素。其 `masterVolume` 永远为 `0`。

### 服务端状态适配

曲谱加载且 AlphaTab player ready 后，将最新服务端状态应用到乐手播放器：

- 每次收到曲谱 `playback:state`，通过外部媒体输出的 `updatePosition(positionMs)` 更新 AlphaTab 时间轴。
- `isPlaying` 从假变真时调用 AlphaTab `play()`，使原生游标进入播放状态；从真变假时调用 `pause()`。
- 暂停和跳转时仍立即更新 position，确保原生游标停在权威位置。
- 曲谱尚未渲染完成时只缓存最新状态；player ready 后立即补应用。
- 重连、切轨和切回曲谱时复用相同的“应用最新状态”入口。
- 调用外部媒体专用能力前做运行时能力检测；能力缺失时显示可诊断错误，不回退到自绘蓝线。

服务端仍以约 100 ms 周期广播权威位置。AlphaTab 负责两次更新间的原生游标动画和滚动，客户端不另建第二套权威时钟。

### 删除旧实现

删除 `followerCursor`、`followerBuildTimer`、`buildFollower()`、`updateFollower()`、`followFollowerCursor()`、`#sync-cursor` DOM/CSS，以及调试面板中的自绘坐标字段。保留服务端 tick、拍号和连接状态诊断数据。

## 安全与性能

- 乐手端不提供 SoundFont URL，不调用 `loadSoundFont()`，不创建可发声媒体元素。
- 外部媒体 handler 的音量读写均钳制为 `0`。
- 乐手端禁用 AlphaTab 默认点击跳转，避免绕过主机控制权。
- 只在收到服务端状态时更新外部时间轴，不增加高频轮询。
- 视频来源下不初始化或驱动曲谱播放器，现有来源隔离保持不变。

## 测试与验收

自动化测试覆盖：

- 乐手配置为 `EnabledExternalMedia`，原生游标/高亮开启，SoundFont 为空，用户交互关闭。
- 外部 handler 始终静音，不产生音频加载或播放副作用。
- 播放、暂停、跳转和连续状态更新正确调用 AlphaTab 原生播放器与 `updatePosition()`。
- 状态早于 player ready、重连、切轨、曲谱/视频切换时能应用最新状态且不残留旧播放器。
- 页面不再创建 `#sync-cursor`，旧的手工滚动逻辑不再执行。
- 主机合成器与视频同步相关现有测试不回归。

人工验收使用真实手机/平板：定速、变速、反复、跳房子、暂停、跳转、切轨、横竖屏、全屏和后台恢复；确认游标与主机位置一致、滚动自然、乐手端始终无声且不弹音频权限。

## 回退

实施前稳定点保存在本地分支 `backup/pre-native-client-cursor-20261102`（提交 `a444ae6`）。如外部媒体模式在目标浏览器不可用，可直接从该分支恢复当前蓝线版本，再单独评估静音合成器方案。
