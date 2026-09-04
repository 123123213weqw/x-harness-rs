# 持久 PTY 规范

**Crate：** `xharness-terminal`
**状态：** Unix PTY 与 Windows ConPTY 已实现并原生测试；不再属于默认模型工具面。

本 Crate 是底层可复用 PTY Runtime。旧 `terminal_open/send/read/signal/close/list` 六工具已经从
`xharness-coding-tools` 和生产 Host 默认 Projection 移除。非交互长任务必须走 `bash` 的受管
后台 Job；未来只有明确需要 TUI/REPL 的专用 Profile 才可以重新设计并选择性投影 PTY 工具。

## Session 身份与所有权

Terminal 以 `(owner, name)` 定位，并拥有生成的 Runtime ID。Name 只能使用 1–64 个
ASCII 字母、数字、`.`、`_`、`-`，只需在同一 Owner 内唯一。所有操作都必须执行 Owner
边界检查；其他 Owner 的 ID/Name 禁止获得访问权。每个 Owner 默认最多 16 个活跃 Session。

## PTY 生命周期

Unix `open` 创建真实 PTY、启动新 Session 并把 Slave 设为 Controlling Terminal；Windows
通过 ConPTY 启动终端并将根进程加入 kill-on-close Job Object。两者都执行直接 `SpawnSpec`。
`send` 在每 Session Writer Lock 下写 Raw Bytes。`read` 从可选单调
Byte Cursor 开始返回输出。`list` 只报告当前 Owner 的 Session。`close` 删除 Session，
发送 TERM，等待配置 Grace，再发送 KILL（必要时回退到杀 Root Child），最后等待退出。

`TerminalRegistry::shutdown()` 先关闭新 Session Admission，再对注册表中每个 PTY 执行
同一 TERM→Grace→KILL→Wait 路径，并返回包含总数、已关闭数和错误的
`TerminalShutdownReport`。Host 不得在 Registry 报告失败时静默退出。

任何未来 Tool Adapter 的 `open` 必须先经过 `NativePlatform::prepare_spawn`。Restricted
Sandbox Probe 不可用时禁止创建裸 PTY；禁止为了绕过后台 Job 或 Sandbox 临时把旧工具塞回
默认 Registry。

## Scrollback

输出持续从 PTY Master Drain 到有界 Scrollback。默认上限 1 MiB 和 10,000 行；任一超限
都淘汰最旧 Byte。每次 Read 返回当前 Cursor 和 `truncated_before_cursor`。Cursor 超过当前
输出位置属于非法。Text 是 Terminal Bytes 的 Lossy UTF-8 渲染，但 Cursor 仍按 Byte 计数。

## Signal 语义

只支持 `Interrupt`、`Terminate`、`Kill`、`Suspend`、`Hangup`。能发现 Foreground
Process Group 时，Signal 必须发给它。输出安静禁止解释为进程退出；权威状态只能来自
Child Process。

## 当前限制

- Session 只存在于进程内，Daemon 重启后不会保留。
- 尚无 Resize/Window Size、OSC 133 Prompt Marker、Foreground-pgid Wait-state 推断、
  Job Attach 或 Terminal Recording。
- Tool Adapter 的 `settle_ms` 只是有界观察延迟，不证明命令已经完成。
- Windows ConPTY 当前不模拟 Unix 的 Suspend/Hangup 信号语义；关闭与 Kill 以 Job 为权威。

## 验收标准

真实 Interactive Shell 测试必须覆盖 Open、Owner 隔离、Name 唯一、Send、按 Cursor
增量 Read、Status/List、Signal、Close，以及无残留 Root Process 的有界清理。还必须覆盖
Registry Shutdown 一次关闭多个 PTY、确认 PID 消失，并拒绝关闭后的新 Session。
Windows 原生测试还必须覆盖 PowerShell 连续输入输出、scrollback 与 Job 清理。
