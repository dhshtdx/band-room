# GitHub 开源发布清单

公开仓库：<https://github.com/dhshtdx/band-room>

## 上传前

1. 执行 `git status --ignored`，确认 `node_modules/`、`release/`、`work/`、`local.properties`、所有 keystore、环境变量和日志均被忽略。
2. 执行 `pnpm check`。
3. 检查 Git 历史中从未提交过密钥或曲谱；若提交过，删除当前文件并不足够，必须重写历史并更换密钥。
4. 确认 `LICENSE` 是 AGPL-3.0-only，第三方许可证位于 `legal/`。
5. 只上传源码，不上传收费安装包。

## 仓库设置

- 默认分支启用 pull request、CI 必须通过和禁止 force push。
- 启用 Dependabot alerts、secret scanning、push protection 与 private vulnerability reporting。
- Topics 建议：`music-notation`、`guitar-tab`、`websocket`、`local-network`、`electron`、`react-native`。
- About 中明确“Community source; official signed builds and support may be paid.”
- 首个标签使用 `v1.0.3-source`，避免与尚未签名的旧测试安装包混淆。

## 不得公开

- 用户或测试 GP 曲谱。
- Android `.jks/.keystore`、Apple `.p12`、Windows `.pfx`。
- 证书密码、Apple app-specific password、支付密钥、客户列表。
- `release/`、`work/`、`node_modules/` 和本机 SDK 路径。
