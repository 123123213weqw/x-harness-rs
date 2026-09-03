# 子进程运行时规范

**Crate：** `xharness-process`
**状态：** Linux/macOS Process Group 与 Windows Job Object 已实现并在三平台 CI 原生测试。

## Spawn 契约

`SpawnSpec` 必须包含 Program、直接 Argv 和显式 Cwd。运行时禁止隐式调用 Shell。子进程
环境先清空，再用显式值重建；可选 Secret Scrubber 会删除像凭据的变量名，但不能误删
`MONKEY`、`KEYBOARD` 这类普通名称。

Unix 子进程拥有新的 Session/Process Group。Windows 子进程以 `CREATE_SUSPENDED` 创建，
先加入 kill-on-close Job Object，再恢复主线程，禁止首条用户指令前派生后代逃逸 Job。
`ProcessHandle` 拥有唯一 Result
Receiver；`ProcessCancellation` 是可 Clone 的终止能力，允许一个任务取消、另一个任务
等待完全收敛。

## 输出契约

Stdout/Stderr 必须并发 Drain，避免 Pipe Deadlock。每条流报告保留文本、读取总字节和
是否截断。Cap 必须保持有效 UTF-8 Scalar 边界；源数据中真实非法字节可以 Lossy 表示。
非零 Exit Status 是正常的结构化 `ProcessOutput`，不是 Runtime Error。

`ProcessHandle::output_observer()` 另提供可 Clone、非消费的实时窗口。调用者以 stdout/stderr
绝对 Cursor 读取 `ProcessOutputSnapshot`，再用单调 Revision 等待变化。窗口与最终 Capture 使用
相同 per-stream Cap，但 Final Capture 保留 Head，Live Observer 保留 Tail；Cursor 落在已淘汰区域
时明确 `truncated=true`。Supervisor 无论成功或基础设施失败都必须发布 `finished` Revision。
Job Producer 可将该观察面转换成自己的单消费输出，但 Process Runtime 本身不持有模型 Cursor。

## 终止

Timeout、显式 Cancel 和 Handle Drop 都请求终止。Unix Supervisor 先向 Process Group 发送
TERM，等待配置的 Grace，再发送 KILL；Windows 对整个 Job 调用 `TerminateJobObject`。
两者都必须等待根进程和进程树收敛后再发布结果。`TerminationReason` 必须区分 Normal Exit、
Timeout 和 Cancellation。

Supervisor 内部还持有同步 `ProcessTreeGuard`：即使 Tokio Runtime 关闭或任务被
Abort，Guard Drop 也会清理受管 Process Group/Job，不把清理寄托给已停止的
Async Runtime。Root/Group 终止后，Stdout/Stderr 只允许在有界
`capture_drain_grace` 内等待 EOF；Windows 还轮询 Job active-process accounting 至零。超时返回
`CaptureDrainTimedOut`，不能无限挂起或
伪造成功结果。

## 安全边界

Unix Process Group 只用于生命周期协调，不是硬隔离。非受限进程的后代可以创建新 Session
逃逸。受限 Coding Tool 因此必须运行在 `xharness-sandbox` 之下，由 PID Namespace/OS
Policy 提供硬后代 containment。Windows Job 不允许 breakaway，负责 FullAccess 和受限模式的
进程树生命周期回收；它仍不是文件、网络或资源配额沙箱。

`ProcessRuntime` 能启动进程不代表 Restricted Process Capability 可用；Host 必须同时检查
原生 Sandbox Probe。Probe 失败时不得调用本层裸跑命令，也不得把错误当成普通进程 Exit。

## 当前限制

- 后台 Job Registry 已在独立 `xharness-jobs` 实现；Process 层仍无 Spill File。
- `FullAccess` 下主动 `setsid()` 逃离原 Process Group 的后代仍无法被本层硬回收；
  保留 Pipe 的逃逸后代会被有界 Drain 检测为 Cleanup Failure。需要硬保证时必须使用
  Linux PID Namespace/macOS Seatbelt 等受限后端，不能把 Process Group 当成安全边界。

## 验收标准

测试必须覆盖直接 Argv/无 Shell Injection、显式 Cwd/Env、Secret Scrub、正常和非零退出、
并发 Stdout/Stderr、Live Observer 的增量/Tail/Revision、Unicode 安全 Cap、Timeout Escalation、显式 Cancel 以及 Leader/
Descendant 清理。还必须覆盖 Runtime Drop 时的同步最后清理、逃逸 Session 持有
Pipe 时的有界失败、受限 PID Namespace 中后代的硬回收，以及 Windows 上“暂停创建、入 Job、
恢复运行”和根进程退出后的后代清理。
