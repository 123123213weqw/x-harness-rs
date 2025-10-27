# 持久 PTY 规范

**Crate：** `xharness-terminal`
**状态：** 已在 Unix 实现；Linux 集成已测试。

## Session 身份与所有权

Terminal 以 `(owner, name)` 定位，并拥有生成的 Runtime ID。Name 只能使用 1–64 个
ASCII 字母、数字、`.`、`_`、`-`，只需在同一 Owner 内唯一。所有操作都必须执行 Owner
边界检查；其他 Owner 的 ID/Name 禁止获得访问权。每个 Owner 默认最多 16 个活跃 Session。

## PTY 生命周期

`open` 创建真实 PTY，启动新 Session，把 Slave 设为 Controlling Terminal，然后执行
直接 `SpawnSpec`。`send` 在每 Session Writer Lock 下写 Raw Bytes。`read` 从可选单调
Byte Cursor 开始返回输出。`list` 只报告当前 Owner 的 Session。`close` 删除 Session，
发送 TERM，等待配置 Grace，再发送 KILL（必要时回退到杀 Root Child），最后等待退出。

Coding Bundle 中的 `terminal_open` 必须先经过 `NativePlatform::prepare_spawn`。Restricted
Sandbox Probe 不可用时禁止创建裸 PTY；Host 应从下一模型 Step 移除 `terminal_open`。只有
存在历史 Session 时才投影对应的 read/send/signal/close，并按原权限边界收尾，禁止跨模式
复用。

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
- 仅 Unix。

## 验收标准

真实 Interactive Shell 测试必须覆盖 Open、Owner 隔离、Name 唯一、Send、按 Cursor
增量 Read、Status/List、Signal、Close，以及无残留 Root Process 的有界清理。
