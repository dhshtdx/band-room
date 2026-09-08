# Band Room · 乐队排练辅助系统

一个局域网内的乐队排练辅助工具。主机电脑运行 Band Room 并独占播放控制，乐手用手机或平板浏览器扫码进入同一房间，
各自查看自己的轨道谱面，跟着同一个播放位置同步走。排练全程不依赖公网，乐手端不需要安装任何 App。

当前版本 **1.0.4**，桌面端项目（macOS / Windows）。这是一个个人开源项目，源码按 AGPL-3.0-only 发布，见 [LICENSE](./LICENSE)。

## 它解决什么问题

排练时每个人的谱不一样（吉他看吉他轨、贝斯看贝斯轨），而且总得有人喊"从第 32 小节再来"。
Band Room 让主机独占播放/暂停/跳转，所有乐手设备的谱面游标与自动滚动都跟着服务端推送的位置走，并且只显示自己那一轨。

## 主要特性

- **局域网房间**：主机生成 7 位数字房间号，乐手扫码或打开 `/join?room=...` 链接加入，最多 32 台设备。
- **服务端唯一时钟**：服务端用 AlphaTab `MidiFileGenerator` 生成展开后的播放时间线与速度图，
  广播绝对 tick、BPM、小节和拍点。客户端只渲染服务端位置，不自行计时，因此多设备不会各自漂移。
- **曲谱支持**：`.gp`、`.gp3`、`.gp4`、`.gp5`、`.gpx`，上限 20 MB；由 AlphaTab 在本机渲染。
- **每人独立选轨**：乐手可自选显示轨道，仅影响自己那台设备。
- **同步游标**：乐手端基于展开时间线建立拍点表，用独立游标叠加到谱面并自动横向滚动。
- **主机伴奏**：主机端 AlphaTab 合成器真实发声；乐手端刻意不加载播放器，因此不会请求音频权限、也不会出声。
- **权限边界**：创建房间时只有主机浏览器取得 `hostToken`，上传与播放控制都随 WebSocket 消息校验该令牌；
  加入链接和二维码不含令牌，可以放心投屏。
- **断线恢复**：WebSocket 按 0.5/1/2/4/5 秒退避重连；页面从后台返回时立即检查连接；
  房间空置后保留 60 秒，主机凭令牌恢复、乐手凭房间号与身份自动回到原房间。
- **全屏看谱**：支持浏览器原生全屏；不支持的移动浏览器自动降级为沉浸式布局。
- **离线可用**：AlphaTab 脚本、Bravura 字体和 sonivox 音色全部由主机本地提供，不依赖 CDN。

## 安装与使用

普通用户不需要安装 Node.js。构建产物位于被 Git 忽略的 `release/`：

- macOS（Apple 芯片与 Intel 均可）：`Band Room-1.0.4.dmg`
- 64 位 Windows 10/11：`Band Room Setup 1.0.4.exe`

打开 **Band Room** 后，应用会自动启动局域网服务器并显示主机控制台。详细步骤、以及首次打开被系统拦截时的处理方法，
见 [安装使用说明.md](./安装使用说明.md)。

> 本项目的安装包**没有代码签名与公证**。首次打开时 macOS 会提示来源不明、Windows 会提示 SmartScreen，
> 需要手动放行一次。这是个人开源项目的现状，不是文件损坏。

## 开发运行

1. 安装 [Node.js 20 LTS](https://nodejs.org/) 或更高版本。
2. 在此目录运行：

   ```bash
   pnpm install --frozen-lockfile
   pnpm dev
   ```

3. 在 Mac 上打开 `http://localhost:4173/host`，点击"创建排练房间"。
4. 手机和 Mac 连接同一 Wi‑Fi，扫描主机页面二维码，或打开页面显示的 `/join?room=...` 局域网链接。

## 验收要点

- 主机生成随机的 7 位纯数字房间号；多个浏览器可加入同一房间，在线成员列表实时更新。
- 仅主机可操作播放/暂停/跳转，乐手端没有控制器；伪造或缺失 `hostToken` 会收到 `HOST_AUTH_INVALID`。
- 服务端在每次状态变更时用自己的时钟计算当前位置后广播；客户端只渲染服务器推送的位置。
- 曲谱只临时保存在数据目录（开发模式为 `work/scores/`），最后一位成员离开房间后自动删除。
- 覆盖定速、变速、反复与跳转的曲谱时，绝对 tick、小节、拍点与主机 AlphaTab 一致。
- 乐手端不加载音色、不调用 `play()/pause()`，因此不会请求音频权限或播放声音。
- 若"正在排版"超过 30 秒，页面会显示明确错误提示；正常曲谱不应超过数秒。

## 构建安装包

```bash
pnpm install --frozen-lockfile
pnpm dist:mac          # 一份 DMG，同时包含 arm64 与 x64
pnpm dist:win          # Windows x64 NSIS 安装器
pnpm dist:checksums    # 为 release/ 顶层的交付产物生成 SHA256SUMS.txt 与发布清单
```

`dist:*` 会先执行 `scripts/release-preflight.mjs`，检查法律文件齐全、包内没有曲谱、版本号与 CHANGELOG 一致，
以及 `public/release-info.json` 填有真实的源码地址。完整发版流程见 [docs/RELEASE.md](./docs/RELEASE.md)。

`dist:win` 需要在 Windows 上构建（或自行配置 wine）；仓库的 CI 只跑语法检查与集成测试，不产出安装包。

桌面壳使用 Electron 启动同一套 Express/WebSocket 服务，自动选择可用端口并打开 `/host`。
上传的临时曲谱写入系统用户数据目录，不会尝试修改只读的应用安装目录。

## 目录结构

```
server/index.js       服务端：房间、时钟、曲谱解析、静态资源
public/               浏览器端：连接、渲染、同步游标、法律页面（无构建步骤）
desktop/main.js       Electron 桌面壳
test/                 node:test 集成测试
scripts/              打包前检查、校验值生成
docs/                 发版流程、测试矩阵、依赖安全、GitHub 发布清单
legal/                第三方许可证全文
release/              构建产物（已被 Git 忽略）
work/scores/          运行时临时曲谱（已被 Git 忽略）
```

## 已知限制

- 房间状态保存在内存中；服务进程重启后旧房间不会恢复，需要重新创建。
- 安装包未做代码签名与公证，首次打开需要手动放行；详见安装说明。
- 面向可信局域网设计，**不应把主机服务暴露到公网**。
- 曲谱上限 20 MB，房间上限 32 台设备。

## 参与与许可

- 原创源码采用 **AGPL-3.0-only**，详见 [LICENSE](./LICENSE)。任何人都可以依许可证自行构建。
- 贡献流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)；安全问题见 [SECURITY.md](./SECURITY.md)。
- 隐私说明见 [PRIVACY.md](./PRIVACY.md)，使用条款见 [TERMS.md](./TERMS.md)，商标说明见 [TRADEMARKS.md](./TRADEMARKS.md)。
- 第三方组件与许可证见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)；依赖审计结论见 [docs/DEPENDENCY_SECURITY.md](./docs/DEPENDENCY_SECURITY.md)。
- 项目不提供、销售或授权任何歌曲与曲谱。请勿提交 `work/`、GP 文件、签名密钥或 `release/` 构建产物。
