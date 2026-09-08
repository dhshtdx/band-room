# Band Room · 乐队排练辅助系统

当前状态：六个原始开发阶段均已完成，正在进入公开源码与官方商业发行阶段。

本阶段采用局域网 Web 架构：Mac、Windows 或安卓主机运行 Node.js + Express + ws 服务，乐手用手机/平板浏览器通过同一局域网访问。服务器监听 `0.0.0.0`，排练不依赖公网。

## 普通用户安装

无需安装 Node.js，也无需打开终端。本机构建产物位于被 Git 忽略的 `release/`：

- Apple 芯片 Mac（M1/M2/M3/M4 等）：`Band Room-1.0.3-arm64.dmg`
- Intel 芯片 Mac：`Band Room-1.0.3.dmg`
- 64 位 Windows 10/11：`Band Room Setup 1.0.3.exe`
- Android 7.0 及以上：`Band Room Host-1.0.3.apk`

双击安装后打开 **Band Room**，应用会自动启动局域网服务器并显示主机控制台。详细步骤见 [安装使用说明.md](./安装使用说明.md)。

## 开发运行

1. 安装 [Node.js 20 LTS](https://nodejs.org/) 或更高版本。
2. 在此目录运行：

   ```bash
   npm run dev
   ```

3. 在 Mac 上打开 `http://localhost:4173/host`，点击“创建排练房间”。
4. 手机和 Mac 连接同一 Wi‑Fi，扫描主机页面二维码，或打开页面显示的 `/join?room=...` 局域网链接。

## 阶段 2 验收

- 主机可以创建随机的 7 位纯数字房间号。
- 多个浏览器可加入同一房间。
- 所有已加入设备都会更新在线成员列表。
- 关闭浏览器后，成员列表会更新。
- 仅主机可以操作“播放/暂停”和跳转；乐手端没有控制器。
- 服务端在每次状态变更时使用自己的时钟计算当前位置后广播。客户端只渲染服务器推送的位置，不会自行计时。

## 阶段 3 验收

- 主机可选择 `.gp`、`.gp3`、`.gp4`、`.gp5` 或 `.gpx` 文件，最大 20 MB。
- 服务端使用成熟的 [AlphaTab](https://www.alphatab.net/docs/introduction/) 解析曲谱，并广播标题、作者、速度、小节数和轨道信息。
- 曲谱只临时保存在 `work/scores/`，最后一位成员离开房间后自动删除。

## 阶段 4 验收

- 每个已加入的浏览器都会从主机获取同一份临时曲谱，并由 AlphaTab 在本机渲染，无需互联网或 App。
- 每位成员可以在“显示轨道”下拉框中选择自己的轨道；该选择仅影响该设备。
- AlphaTab 的脚本和 Bravura 字体由 Mac 主机的 `/alphatab/` 本地资源提供，避免 CDN 依赖。
- 谱面渲染完成后，阶段 5 的播放位置映射、光标、自动滚动和主机伴奏会接管排练流程。
- 若“正在排版”超过 30 秒，页面会显示明确错误提示；正常曲谱不应超过数秒。

## 阶段 5

- 乐手端不启用 AlphaTab 播放器、不加载音色、也不调用 `play()`/`pause()`；因此不会请求音频权限或播放声音。
- 服务端直接使用 AlphaTab `MidiFileGenerator` 生成展开后的播放时间线和速度图。每个速度段分别进行 `positionMs ↔ MIDI tick` 换算，与主机 AlphaTab 合成器采用同一套变速规则。
- 播放时间线包含速度自动化、反复次数和跳转后的真实小节顺序；服务端广播绝对播放 tick、当前 BPM、小节、拍点和 occurrence。
- 渲染完成后，客户端按展开时间线用 `boundsLookup.findBeat()` 建立当前轨道的拍点表，并将独立蓝色 DOM 游标叠加到 `onNotesX` / `visualBounds` 坐标。
- 乐手端“同步诊断”显示最新 `positionMs`、绝对 tick、当前 BPM、小节/拍点、最近消息时间和游标坐标。
- 主机“准备伴奏”会主动重新加载本地 `sonivox.sf2`，播放前解除所有 GP 轨道的 mute/solo、恢复通道音量并唤醒 AudioContext；状态栏显示 AudioContext、主音量和实际 NoteOn 数量，便于区分播放器计时与真实 MIDI 输出。
- 主机凭证已闭环：创建房间时仅主机浏览器取得 `hostToken`，上传与播放控制均随 WebSocket 消息携带它；乐手加入链接不含该 token。

## 阶段 6

- WebSocket 断开后按 0.5、1、2、4、5 秒的退避间隔自动重连；手机从锁屏或后台返回时也会立即检查连接。
- 房间最后一个连接断开后保留 60 秒。主机凭 `hostToken` 恢复原房间，乐手以原房间号、昵称和乐器自动重新加入；刷新页面同样可恢复。
- 服务端每 30 秒 ping 一次连接并清理半开 Socket，避免手机网络切换后留下假在线成员。
- 服务端验证上传、播放、暂停和跳转消息携带的主机凭证；仅用 CSS 隐藏按钮不再构成权限边界。
- 主机从 `localhost` 打开时，页面会自动取得 Mac 的局域网 IPv4 地址，生成手机可访问的加入链接和二维码。二维码只包含乐手 URL，不含主机凭证。
- 720px 以下使用移动端自然纵向布局和安全区边距；页面可以正常上下翻动，谱面区域保留横向触摸滚动并抑制滚动链与橡皮筋回弹。

## 全屏看谱

- 谱面加载后点击“全屏看谱”可进入浏览器原生全屏；再次点击或按 `Esc` 退出。
- 不支持原生全屏的移动浏览器会自动使用沉浸式谱面布局。再次点击按钮即可退出。

## 当前限制

- 房间状态保存在内存中；如果 Node.js 服务进程重启，旧房间不会恢复，需要重新创建。
- 当前安装包尚未使用 Apple Developer ID 或 Windows Authenticode 证书签名。首次打开时系统可能显示来源提醒，详见安装说明；正式对外发布前应购买并配置两平台的代码签名证书。

## 开源与官方发行

- Band Room 原创源码采用 **AGPL-3.0-only**，详见 [LICENSE](./LICENSE)。
- 官方签名、公证、经过兼容性验证的安装包以及技术支持可以收费；手机浏览器加入端继续免费。
- 任何人都可以依照许可证自行构建，但不得冒充官方签名发行版。
- 项目不提供、销售或授权歌曲与曲谱。请勿提交 `work/`、GP 文件、签名密钥、商店凭证或 `release/` 构建产物。
- 第三方组件与商标说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)，隐私说明见 [PRIVACY.md](./PRIVACY.md)。
- 安全问题请参阅 [SECURITY.md](./SECURITY.md)，贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
- 依赖审计范围、结果与 Android 构建链剩余风险见 [docs/DEPENDENCY_SECURITY.md](./docs/DEPENDENCY_SECURITY.md)。

## 桌面安装包构建

```bash
pnpm install
pnpm dist:mac        # Apple 芯片 Mac
pnpm dist:mac:intel  # Intel Mac
pnpm dist:win        # Windows x64 NSIS 安装器
pnpm dist:android    # Android 通用 APK
```

以上 `dist:*` 用于本地测试。对外销售必须使用 `release:mac`、`release:win`、`release:android` 或面向 Google Play 的 `release:android:aab`，这些命令会在构建前验证正式签名与法律文件；完整步骤见 [docs/RELEASE.md](./docs/RELEASE.md)。

桌面壳使用 Electron 启动同一套 Express/WebSocket 服务，自动选择可用端口并打开 `/host`。上传的临时曲谱写入系统用户数据目录，不会尝试修改只读的应用安装目录。

安卓壳使用 React Native WebView，并在后台 Node.js Mobile 线程中运行同一套服务。APK 包含 ARM64、ARMv7 和 x86_64 运行库；安卓设备既是主机控制台，也是局域网服务器。
