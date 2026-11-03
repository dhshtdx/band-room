---
name: band-room-macos-release
description: 为 Band Room 打 macOS 安装包（DMG，arm64 + x64）。当用户要求"打 mac 包""出 DMG""编译 mac 版本""dist:mac"或升级版本后需要重新产出 macOS 安装包时使用。涵盖 pnpm 环境修复、Electron 二进制补装、ELECTRON_RUN_AS_NODE 劫持、universal 构建、以及无签名包的验证与交付。
---

# Band Room · macOS 打包

## 何时用这个 skill

- 用户说"打 mac 包"、"出 DMG"、"编译 Mac 版本"、"发版"
- 版本号改了要重新出安装包
- 打包报错、DMG 打不开、应用启动即退出

## 0. 先决条件检查

```bash
cd <项目根>            # 含 package.json 与 electron-builder 配置
node -v                # 需要 >= 20，实测 24.19.0
sw_vers                # 需要 macOS 12+
xcode-select -p        # 有 CommandLineTools 即可，不需要完整 Xcode
```

`package.json` 里必须有 `build` 字段（appId / productName / mac.target / dmg 布局）。
本项目的配置在 `package.json` 的 `build` 段，**不是** `electron-builder.yml`。

## 1. 装 pnpm（这台机器每次都要）

`corepack enable` 会尝试写 `/usr/local/bin` 并失败：

```
Internal Error: EACCES: permission denied, symlink '../lib/node_modules/corepack/dist/pnpm.js'
```

不要纠缠权限，直接装到用户目录：

```bash
npm i -g pnpm --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
pnpm -v
```

⚠️ `npm i -g pnpm` 会警告 `preinstall/postinstall not covered by allowScripts`，
这是 npm 11+ 的新提示，**不用加 `--allow-scripts`**，pnpm 本体能正常运行。

## 2. 装依赖

```bash
pnpm install --frozen-lockfile
```

看到 `Lockfile passes supply-chain policies` + `Packages: +N` 即成功。

## 3. 补装 Electron 二进制（关键坑）

pnpm 的 `pnpm-workspace.yaml` 里 `allowBuilds` 只放行了部分包，`electron` 的
postinstall 被跳过，结果是 `node_modules/electron/dist` **为空**，
`path.txt` 也不存在。此时直接打包会失败或打出空壳。

手动补：

```bash
cd node_modules/electron && node install.js && cd -
ls node_modules/electron/dist          # 应该看到 Electron.app
cat node_modules/electron/path.txt     # 应该是 Electron.app/Contents/MacOS/Electron
```

二进制会命中 `~/Library/Caches/electron/` 缓存，无需联网重下。

**更稳的做法**：在 `pnpm-workspace.yaml` 里加 `allowBuilds: { electron: true }`，
或 `pnpm approve-builds`，从根上避免。

## 4. 跑测试

```bash
npm run check
```

这个项目的 `check` = 6 个文件的 `node --check` + `node --test`。
实测基线 **74 项测试**（加了 Android 后是 83 项），必须全绿再打包。

## 5. 打包

三种目标，按需选：

```bash
# 推荐：一份 universal DMG（arm64 + x86_64 二合一）
npx electron-builder --mac dmg --universal

# 或分架构出两份
npx electron-builder --mac dmg --arm64 --x64

# 项目自带入口（含发版预检）
npm run dist:mac
```

`dist:mac` 会先跑 `scripts/release-preflight.mjs`，检查：
法律文件齐全、包内无曲谱/视频、版本号与 CHANGELOG 一致、`public/release-info.json` 有真实源码地址。

### 构建产物位置

```
release/
├── Band Room-<version>-universal.dmg    ← universal
├── Band Room-<version>-arm64.dmg        ← Apple Silicon
├── Band Room-<version>.dmg              ← Intel
├── Band Room-<version>*.dmg.blockmap
├── mac/  mac-arm64/  mac-universal/      ← 中间产物，别交付
├── SHA256SUMS.txt                        ← dist:checksums 生成
└── release-manifest.json
```

生成校验值：

```bash
npm run dist:checksums
```

它只统计 `release/` **顶层**的 `.dmg/.exe/.msi/.zip`，不会把中间目录重复计入。

## 6. 验证

### 架构检查

```bash
lipo -archs "release/mac-universal/Band Room.app/Contents/MacOS/Band Room"
# universal 应输出：x86_64 arm64
```

### 挂载 DMG

```bash
hdiutil attach "release/Band Room-<version>-universal.dmg" -nobrowse -mountpoint /tmp/brmnt
ls /tmp/brmnt          # 应看到 Band Room.app 与 Applications 快捷方式
lipo -archs "/tmp/brmnt/Band Room.app/Contents/MacOS/Band Room"
hdiutil detach /tmp/brmnt -quiet
```

### 启动验证（关键坑二）

**绝对不要**在 shell 里直接 `./Band\ Room` 启动。这台机器的环境里带着：

```
ELECTRON_RUN_AS_NODE=1
```

Electron 会退化成 Node REPL，输出 `Welcome to Node.js v24.x.x`，看起来像启动失败。

正确做法：

```bash
env -u ELECTRON_RUN_AS_NODE open -a "/path/to/Band Room.app"
```

或按完整路径启动二进制：

```bash
cd ".../Band Room.app/Contents/MacOS"
env -u ELECTRON_RUN_AS_NODE nohup ./"Band Room" > /tmp/br.log 2>&1 &
```

成功标志（日志里出现）：

```
主机控制台：http://localhost:<随机端口>
局域网加入地址：http://<LAN-IP>:<随机端口>
```

### 功能冒烟

```bash
PORT=$(grep -oE ':[0-9]{5}' /tmp/br.log | head -1 | tr -d ':')
curl -s http://127.0.0.1:$PORT/api/health
# {"ok":true,"service":"Band Room","version":"x.y.z","rooms":0,...}
```

### 签名状态（预期就是没签名）

```bash
codesign -dv --verbose=2 "release/mac-universal/Band Room.app"
# Signature=adhoc
spctl -a -vvv --type execute "release/mac-universal/Band Room.app"
# code has no resources but signature indicates they must be present
```

上面两条输出**都是正常的**。`hardenedRuntime: false` + 无 Developer ID，
所以 Gatekeeper 会拦。交付时在说明里写清放行方式：

```bash
xattr -dr com.apple.quarantine "/Applications/Band Room.app"
```

### 确认包内没有用户媒体

```bash
node node_modules/.pnpm/@electron+asar@*/node_modules/@electron/asar/bin/asar.js \
  list "release/mac-universal/Band Room.app/Contents/Resources/app.asar" \
  | grep -iE '\.(gp|gp3|gp4|gp5|gpx|mp4|webm)$'
# 必须无输出
```

## 7. 版本升级清单

改版本号时，这几处必须同步，漏一个就发不出去：

| 文件 | 字段 |
|---|---|
| `package.json` | `version` |
| `CHANGELOG.md` | 顶部 `## <version> ` 条目（preflight 会校验） |
| `public/release-info.json` | `sourceUrl` 不能是占位值 |
| `android/app/build.gradle.kts` | `versionName` + `versionCode`（打 Android 时） |

`versionCode` 用 `主*10000 + 次*100 + 修`：`1.0.4` → `10004`。

## 8. 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `dist` 目录为空 / 打出的 app 打不开 | electron postinstall 被跳过 | 见第 3 步手动 `node install.js` |
| `corepack: EACCES symlink` | `/usr/local/bin` 不可写 | 装到 `~/.local` |
| 启动掉进 Node REPL | `ELECTRON_RUN_AS_NODE=1` | `env -u ELECTRON_RUN_AS_NODE` |
| preflight 报 CHANGELOG 无该版本 | 改了 version 没写变更记录 | 补 CHANGELOG 顶部条目 |
| preflight 报 sourceUrl 是占位值 | release-info.json 没填 | 填真实仓库地址 |
| 打开提示"应用已损坏" | 下载带了隔离属性 | `xattr -dr com.apple.quarantine` |
| `open -a` 命中的是旧版本 | `/Applications` 有同名旧包 | 先删旧包再装 |
| DMG 体积异常大 | 把 `mac-*/` 中间目录也算进去了 | 只交付 `release/` 顶层文件 |
| `SHA256SUMS.txt` 里列了某个 dmg 但文件不存在 | 产物被移走/手动拷走，blockmap 留下了 | 见下方「产物完整性复查」 |
| `--universal` 报错 | 某个原生依赖缺单架构 | 改分架构出两份 DMG |

## 9. 产物完整性复查

每次交付前跑一遍，确认 `SHA256SUMS.txt` 与实际文件对得上：

```bash
cd release
shasum -a 256 -c SHA256SUMS.txt
# 每行应输出 "Band Room-*.dmg: OK"
```

如果有 `No such file or directory`，说明某个 dmg 被移走了（拷到桌面、
拖进聊天窗口后删掉等），但 `blockmap` 和清单还留着。
**不要只看文件列表就认为齐全**——按清单逐个校验才可靠。

一旦真正丢包，用构建中间产物重打，而不是重新跑一遍完整构建：

```bash
npx electron-builder --mac dmg --universal   # 会复用 mac-universal/
```

## 10. 本项目已知基线

- Electron `43.4.0`，electron-builder `26.15.3`
- `mac.target = ["dmg"]`，`hardenedRuntime: false`，`gatekeeperAssess: false`
- 桌面壳 `desktop/main.js` 偏好端口 `4173`，被占用时回落到随机端口
- universal DMG 约 **214 MB**，arm64 约 **121 MB**，x64 约 **123 MB**
- app 解包后约 **503 MB**（universal）
- 无签名、无公证，属于预期状态
