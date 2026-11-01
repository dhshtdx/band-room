# 整分支最终集中修复报告

日期：2026-11-02。起始提交：`580ec7c`。原全量检查基线：47/47。

本轮需求仅来自 `final-findings.md` 的三项；已参考本地视频播放设计。没有派发子代理或审查代理。

## 1. 结尾重播与同来源重连

根因：结尾播放只发送 `set-playing=true`，服务端权威位置仍为时长；随后收到的暂停快照被未确认的主机意图屏蔽。同来源 `room:joined` 又因来源未变化而保留该意图。

修复：

- 从服务端或本地位置判断已到结尾，先将本地视频位置归零，在用户点击调用栈中立即调用 `play()`。
- 等待本地播放成功后，按顺序发送现有协议 `seek positionMs=0`、`set-playing isPlaying=true`。归零消息发送失败时不发送开始消息。
- 任意 `room:joined` 先取消旧主机意图、失效旧播放尝试，清除待确认状态和旧播放快照，再应用新房间的来源与权威播放状态。清除旧快照避免同来源元数据渲染先应用旧播放状态。
- 保留来源 ID、房间 ID、控制版本、意图对象四重异步结果校验。

文件：`public/app.js`、`test/app.video.test.js`。

RED（实现之前）：

```text
node --test test/app.video.test.js test/video-sync.test.js
tests 27; pass 24; fail 3

结尾重播：actual 仅有 set-playing，expected 先 seek(0) 再 set-playing。
同来源重连，playPending=true：actual 为旧意图对象，expected null。
同来源重连，playPending=false：actual 为旧意图对象，expected null。
```

增强本地归零断言后再次执行 RED：

```text
node --test --test-reporter=tap test/app.video.test.js
tests 20; pass 17; fail 3
在本地 play 开始前也应归零：actual 12，expected 0。
另外两个失败仍为重连后旧意图未清空。
```

GREEN：

```text
node --test test/app.video.test.js test/video-sync.test.js
tests 27; pass 27; fail 0; cancelled 0; skipped 0
```

## 2. 停机等待进行中的曲谱上传及清理

根因：视频上传和来源删除已有待完成任务集合，WebSocket 曲谱上传没有；停机在 `writeFile()` 尚未完成时收集当前来源，因而漏掉尚未安装的新曲谱。

修复：

- 从曲谱上传请求开始跟踪任务，任务覆盖解析、写盘、来源代次校验、安装或失效结果清理，直到整个处理完成才移出集合。
- 停止开始后忽略新 WebSocket 请求，既有 `isCurrentSourceUpload()` 继续使尚未完成的安装失效。
- 停机同时等待曲谱及视频上传；再清理当前来源并排空已有来源清理集合。
- 不改变跨来源 `sourceRevision` 递增和冲突检查，不改变既有重复停机行为。

文件：`server/index.js`、`test/server.shutdown.test.js`。

新增真实服务端回归测试使用两道闸门：真实曲谱文件写出后挂起 `writeFile()` 返回；随后让失效结果的真实删除单独挂起。分别验证停机不能提前返回，最终文件不存在且曲谱目录为空，并再次调用停机确认幂等。只替换文件操作的等待边界，保留真实落盘、真实删除、真实 WebSocket 请求和服务端处理。

RED：本代理本地执行命令遇到监听权限限制，控制器在实现前补跑并确认断言失败：

```text
node --test --test-reporter=tap test/server.shutdown.test.js
tests 1; pass 0; fail 1
写盘任务挂起时停机不得返回
actual: 'stopped'
expected: 'writing'
```

GREEN（控制器补跑）：

```text
node --test test/server.shutdown.test.js test/server.integration.test.js
tests 21; pass 21; fail 0
```

其中既有来源交错、视频生命周期、权限、主机播放控制及 EBUSY 清理重试测试均通过。

## 3. 精确同步阈值持久测试

文件：`test/video-sync.test.js`。无需修改生产同步算法，现有行为符合设计。本项属于已知行为测试固化，新增测试在生产实现修改前已通过；没有将其记作生产缺陷的 RED。

- 暂停：两种漂移方向均覆盖 150ms 不跳转、151ms 跳转。
- 成员播放：249ms 恢复正常速率；250/251ms 按方向调整速率；1000ms 仍限速追赶；1001ms 跳转并恢复正常速率。
- 主机播放：249/250ms 不跳转；251/1000/1001ms 跳转；始终恢复 1.0 倍速。

额外在独立临时目录复制真实测试和模块，逐一改变比较符，验证边界测试能捕获实际错误；仓库生产文件未作任何临时变更：

```text
node --input-type=module <<'NODE' ... spawnSync(node, ['--test', '--test-reporter=tap', copiedTest]) ... NODE
paused-150-inclusive: caught (6 pass, 1 fail)
member-250-exclusive: caught (6 pass, 1 fail)
host-250-inclusive: caught (6 pass, 1 fail)
hard-1000-inclusive: caught (6 pass, 1 fail)
exit 0
```

## 全量验证与执行环境

本代理提交前执行：

```text
npm run check
语法检查通过；客户端与发布预检测试通过后，服务端监听失败：
Error: listen EPERM: operation not permitted 0.0.0.0
code: 'EPERM', syscall: 'listen', address: '0.0.0.0'
```

中文解释：本代理运行环境限制监听本地端口，服务端测试无法启动；这是执行环境权限限制，不是测试断言失败。本地此运行没有全量通过结论，挂起进程已终止。

控制器在生产代码冻结后、提交前补跑：

```text
npm run check
tests 54; pass 54; fail 0; cancelled 0; skipped 0
语法检查全部通过，输出干净。
```

本代理另执行 `git diff --check`：退出 0，无输出。

## 自审与关注点

- 三项需求全部落实；生产变更只涉及客户端主机播放/重连状态和服务端停机任务跟踪。
- 没有新增或改变消息协议；重播使用已有 seek 与 set-playing 消息，通过 WebSocket 顺序传递。
- 本地 `play()` 成功前不向服务端归零或开始；显式暂停、来源变化、房间失效仍可使旧异步完成失效；两阶段同来源重连均有持久测试。
- 跨来源 revision 语义保留；停止后新请求不能再产生安装；已开始的曲谱任务等待到其失效清理完成；旧来源清理重试集合仍在停机末尾排空。
- 成员静音、主机有声正常速率、原曲谱伴奏、视频和曲谱切换均受现有通过测试保护。
- 全量从 47 项增至 54 项；新增 3 项客户端回归、1 项真实服务端停机回归、3 项精确阈值测试。
- 本轮没有执行桌面包内或真实多设备的手动媒体解码验收；原设计中的这类发布前验收仍应保留。没有发现本轮未解决的代码问题。
