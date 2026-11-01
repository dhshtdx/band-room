# Task 1 报告：媒体格式与 Range 协议纯函数

## 实现内容

- 新增 `server/video-media.js`：导出 2 GiB `MAX_VIDEO_BYTES`、`VideoMediaError`、`RangeNotSatisfiableError`、媒体描述规范化与签名检查函数，以及单范围解析函数。
- 媒体只接受 `.mp4` / `video/mp4` 与 `.webm` / `video/webm` 的有限映射；`application/octet-stream` 按扩展名规范化。文件名经 `basename()` 处理。已知长度限制为正安全整数且不超过上限，未知长度保留为省略字段。
- MP4 签名检查偏移 4 的 `ftyp`，WebM 检查开头 EBML 魔数。Range 支持完整、开放结尾和后缀形式；无 Range 返回 `null`，无效输入抛出 `RangeNotSatisfiableError`。
- 新增 `test/video-media.test.js` 覆盖以上行为及不泄露磁盘路径的错误消息。

## RED / GREEN 证据

- 格式 RED：首次运行 `node --test test/video-media.test.js` 因 `server/video-media.js` 不存在而失败（`ERR_MODULE_NOT_FOUND`）。添加媒体纯函数后，同命令通过，2/2。
- Range RED：添加 Range 用例后，同命令因 `RangeNotSatisfiableError` 尚未导出而失败。实现 Range 函数后，同命令通过，4/4。

## 测试结果

- `node --test test/video-media.test.js`：通过，4/4。
- `node --check server/video-media.js`：通过。
- `git diff --check`：通过。
- `npm run check`：失败于既有 `test/server.integration.test.js`；集成测试监听 `0.0.0.0` 时操作被沙箱拒绝（`listen EPERM`）。本轮新增的 4 项测试均通过，未把受阻的集成测试记作通过。

## 变更文件

- `server/video-media.js`
- `test/video-media.test.js`
- `.superpowers/sdd/2026-11-01-local-video-playback/task-1-report.md`

## 自审

- 检查了导出接口、字节偏移、Range 边界和安全错误消息；`git diff --check` 无空白错误。
- 未发现需要额外改动的问题。

## 问题

- 完整检查中的 HTTP 集成测试需要监听本机网络端口，当前沙箱禁止该操作；需在允许监听的环境重跑完整 `npm run check`。
