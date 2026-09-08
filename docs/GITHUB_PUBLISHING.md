# GitHub 开源发布清单

仓库：<https://github.com/dhshtdx/band-room>

## 上传前

1. 执行 `git status --ignored`，确认 `node_modules/`、`release/`、`work/`、环境变量和日志均被忽略。
2. 执行 `pnpm check`。
3. 检查 Git 历史中从未提交过密钥或曲谱；若提交过，删除当前文件并不足够，必须重写历史并更换密钥。
4. 确认 `LICENSE` 是 AGPL-3.0-only，第三方许可证位于 `legal/`。
5. 只上传源码；安装包属于 `release/`，不上传、也不提交进仓库。

## 仓库设置

- 默认分支要求 CI 通过。
- 启用 Dependabot alerts、secret scanning、push protection 与 private vulnerability reporting。
- Topics 建议：`music-notation`、`guitar-tab`、`websocket`、`local-network`、`electron`。
- About 中说明这是个人开源项目：源码开放，未签名安装包仅供自行测试。
- 标签从 `v1.0.4` 起。仓库历史上曾被压成单个提交，早期版本没有独立标签。

## 不得公开

- 用户或测试 GP 曲谱。
- Apple `.p12`、Windows `.pfx` 等签名材料（即便当前不做签名，也不要提交）。
- 证书密码、Apple app-specific password。
- `release/`、`work/`、`node_modules/` 和本机 SDK 路径。
