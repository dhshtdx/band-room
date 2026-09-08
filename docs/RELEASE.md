# Band Room 发版流程

这是一个个人开源项目，没有代码签名、公证或收费交付环节。发版的目标只有三个：
**源码可构建、产物可验证、许可证随包分发。**

## 1. 发版前

1. 更新 `package.json` 的 `version`。
2. 在 `CHANGELOG.md` 顶部写一条 `## <新版本号> - YYYY-MM-DD` 的变更记录
   （打包前检查会校验版本号与 CHANGELOG 一致，缺失会直接中止）。
3. 确认 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`PRIVACY.md`、`TERMS.md`、`TRADEMARKS.md`、`legal/` 均在仓库中。
4. 确认 `public/release-info.json` 的 `sourceUrl` 指向真实仓库地址（AGPL 要求向接收者提供对应源代码）。
5. 执行 `pnpm install --frozen-lockfile` 与 `pnpm check`。
6. 执行 `git status --ignored`，确认 `work/`、GP 曲谱、`release/`、`node_modules/`、签名密钥与环境变量都未被提交。

## 2. 构建

```bash
pnpm dist:mac        # 一份 DMG，同时包含 arm64 与 x64
pnpm dist:win        # Windows x64 NSIS 安装器（需在 Windows 上构建或自行配置 wine）
```

两个命令都会先运行 `scripts/release-preflight.mjs`。该检查只做开源项目需要的事：
法律文件齐全、包内不含任何 GP 文件、版本号与 CHANGELOG 一致、源码地址可用。

## 3. 产物与校验值

macOS 与 Windows 产物就绪后：

```bash
pnpm dist:checksums
```

该命令在 `release/` 生成 `SHA256SUMS.txt` 与 `release-manifest.json`，只统计 `release/` 顶层的交付产物，
不会把 `mac-arm64/`、`win-unpacked/` 等中间目录的二进制重复计入。

把哈希值与版本号一起写进发布说明，方便下载者自行核对：

```bash
shasum -a 256 "release/Band Room-1.0.4.dmg"
```

## 4. 发布

1. 提交代码并打标签，例如 `v1.0.4`。
2. 在 GitHub Release 中附上 `SHA256SUMS.txt` 与 `release-manifest.json`，
   并把 DMG / EXE 作为附件上传（或只提供自行构建的说明）。
3. 发布说明中必须保留以下两条，否则下载者会以为是文件损坏：
   - 安装包**未经代码签名与公证**，首次打开需要手动放行（右键打开，或 `xattr -dr com.apple.quarantine`）。
   - 支持的系统：macOS 12 及以上（Apple 芯片与 Intel）、64 位 Windows 10 / 11。
4. 如果分发了 AlphaTab 的可执行形式，必须同时提供其 MPL-2.0 对应源码获取方式，见 `THIRD_PARTY_NOTICES.md`。

## 5. 实机验证

发布前至少在一台真实主机和两台移动设备上走一遍 `docs/TEST_MATRIX.md`，
并把结果（版本、日期、设备、系统、网络、结论）记在发布说明或 Issue 中。

## 6. 明确不做的事

- 不购买或配置 Apple Developer ID、Windows 代码签名证书。
- 不做公证、不做自动更新、不做收款与授权校验。
- 不把安装包提交进 Git 仓库（`release/` 已被忽略）。

如果将来希望普通用户"双击即开"，再补签名与公证即可；届时可重新引入相应的预检与环境变量校验。
