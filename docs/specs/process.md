# 子进程运行时规范

**Crate：** `xharness-process`
**状态：** 已实现 Unix Process Group；Linux 运行时已经测试。

## Spawn 契约

`SpawnSpec` 必须包含 Program、直接 Argv 和显式 Cwd。运行时禁止隐式调用 Shell。子进程
环境先清空，再用显式值重建；可选 Secret Scrubber 会删除像凭据的变量名，但不能误删
`MONKEY`、`KEYBOARD` 这类普通名称。

Spawn 的子进程拥有新的 Unix Session/Process Group。`ProcessHandle` 拥有唯一 Result
Receiver；`ProcessCancellation` 是可 Clone 的终止能力，允许一个任务取消、另一个任务
等待完全收敛。

## 输出契约

Stdout/Stderr 必须并发 Drain，避免 Pipe Deadlock。每条流报告保留文本、读取总字节和
是否截断。Cap 必须保持有效 UTF-8 Scalar 边界；源数据中真实非法字节可以 Lossy 表示。
非零 Exit Status 是正常的结构化 `ProcessOutput`，不是 Runtime Error。

## 终止

Timeout、显式 Cancel 和 Handle Drop 都请求终止。Supervisor 先向 Process Group 发送
TERM，等待配置的 Grace，再发送 KILL 并等待 Root Child。`TerminationReason` 必须区分
Normal Exit、Timeout 和 Cancellation。

## 安全边界

Process Group 只用于生命周期协调，不是硬隔离。非受限进程的后代可以创建新 Session
逃逸。受限 Coding Tool 因此必须运行在 `xharness-sandbox` 之下，由 PID Namespace/OS
Policy 提供硬后代 containment。`DangerFullAccess` 明确不承诺此能力。

`ProcessRuntime` 能启动进程不代表 Restricted Process Capability 可用；Host 必须同时检查
原生 Sandbox Probe。Probe 失败时不得调用本层裸跑命令，也不得把错误当成普通进程 Exit。

## 当前限制

- 仅 Unix；尚无 Windows Job Object。
- 尚无后台 Job Registry 或 Spill File。
- 如果嵌入 Runtime 直接 Abort Supervisor Task，Process Group 清理只能 Best Effort；
  Host 仍必须做结构化 Shutdown。

## 验收标准

测试必须覆盖直接 Argv/无 Shell Injection、显式 Cwd/Env、Secret Scrub、正常和非零退出、
并发 Stdout/Stderr、Unicode 安全 Cap、Timeout Escalation、显式 Cancel 以及 Leader/
Descendant 清理。
