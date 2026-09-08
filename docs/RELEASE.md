# Band Room 官方发布手册

本手册区分两类产物：`dist:*` 是可供开发测试的未签名构建；`release:*` 是对外收费交付的正式构建。不得把测试构建描述为官方安全版本。

## 1. 每次发布前

1. 更新根目录 `package.json` 的 `version`。
2. 同步 Android 的 `versionName`，并递增 `versionCode`。
3. 更新 `安装使用说明.md`、变更日志和销售页版本号。
4. 执行 `pnpm install --frozen-lockfile` 与 `pnpm check`。
5. 确认 `git status` 中没有 `work/`、GP 文件、安装包、密钥、密码或 `local.properties`。
6. 确认 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`PRIVACY.md`、`TERMS.md` 与 `legal/` 被包含。
7. 在真实主机和至少两台移动设备上完成 `docs/TEST_MATRIX.md`。

## 2. macOS 正式版

外部准备：Apple Developer Program、Developer ID Application 证书、Apple ID 的 app-specific password 和 Team ID。

```bash
export APPLE_ID='你的 Apple ID'
export APPLE_APP_SPECIFIC_PASSWORD='app-specific password'
export APPLE_TEAM_ID='Team ID'
pnpm release:mac
pnpm release:mac:intel
```

证书可以安装在登录钥匙串；也可以按照 electron-builder 文档通过 `CSC_LINK` 和 `CSC_KEY_PASSWORD` 提供。密钥和密码只能保存在本机钥匙串或 CI Secret 中。

构建后验证：

```bash
codesign --verify --deep --strict --verbose=2 '/Applications/Band Room.app'
spctl --assess --type execute --verbose=4 '/Applications/Band Room.app'
xcrun stapler validate 'release/Band Room-1.0.3-arm64.dmg'
```

必须在一台未安装开发证书的干净 Mac 上，从实际下载地址下载安装，验证 Gatekeeper、本地网络权限、音频和卸载。

## 3. Windows 正式版

准备受信任机构签发的 RSA 代码签名证书，或配置 Microsoft Trusted Signing。electron-builder 可从 `CSC_LINK` 与 `CSC_KEY_PASSWORD` 读取证书。

```powershell
$env:CSC_LINK='证书文件或安全地址'
$env:CSC_KEY_PASSWORD='证书密码'
pnpm release:win
```

必须验证 EXE 的数字签名和时间戳，并在干净的 Windows 10/11、Defender 与 Smart App Control/SmartScreen 开启状态下测试安装、升级和卸载。不要在 macOS 上宣称完成 Windows 实机验收。

## 4. Android 正式版

1. 在 Android Studio 选择 `Build → Generate Signed Bundle / APK → Create new`，创建至少 25 年有效期的独立发布密钥。
2. 把密钥放在仓库之外并制作两份加密备份。
3. 复制 `android-host/android/keystore.properties.example` 为 `keystore.properties`，填写实际路径和密码；该文件已被 Git 忽略。
4. 直接交付签名 APK 时执行 `pnpm release:android`。
5. Google Play 使用 AAB 并启用 Play App Signing，执行 `pnpm release:android:aab`。

当前 Gradle 配置会拒绝没有正式密钥的 release 构建，避免再次错误使用 `debug.keystore`。

## 5. 校验值与发布记录

三平台产物齐全后执行：

```bash
pnpm release:checksums
```

该命令在 `release/` 生成 `SHA256SUMS.txt` 和 `release-manifest.json`。将校验值发布到官网；保留每个版本的源代码标签、构建日志、测试记录和签名验证结果。

## 6. 源码与收费安装包

- GitHub 发布源码、标签、构建说明和安全公告。
- 官方收费下载站交付签名安装包；不要把付费安装包公开附加到 GitHub Release。
- 官方下载页必须提供版本、平台、SHA-256、价格、退款规则、支持期限和源码链接。
- 如果分发 AlphaTab 的可执行形式，必须继续提供对应 MPL 源码获取方式及许可证。

## 7. 无法自动完成的外部事项

- 创建并验证开发者/经营主体。
- 购买 Apple 与 Windows 签名资格。
- 创建 Android 正式密钥并由所有者保管密码。
- 开通收款、开票和税务流程。
- 填写真实支持联系方式、退款主体和争议处理地。
- 完成每个平台账户中的最终发布确认。

这些信息不得由代码生成工具猜测或代填。
