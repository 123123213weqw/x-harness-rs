# xharness-platform

XHarness 的编译期原生平台下层。它把以下能力组合成宿主唯一入口：

- 共享的 `xharness-process` 直接 Argv 进程运行时；
- 共享的 `xharness-fs` 路径能力与 Observation CAS；
- Linux Bubblewrap 受限执行；
- macOS Seatbelt 受限执行。

模型 Provider 和 Agent Loop 不依赖本 Crate；CLI/Daemon/Web Host 只在应用组合边界创建
`NativePlatform`。受限 Sandbox Probe 失败必须 fail closed，不能静默退回裸执行。

`NativePlatform::capability_report()` 会对同一 Platform 组合缓存一次真实 Sandbox Probe，
Host 据此移除确定不可用的进程/PTY 工具；Full access 则明确报告 `none-full-access`，不会为
Readiness 创建 Sandbox。Web UI 的 Readiness 投影仍列为 `P0-13`。完整契约见
[`../../docs/specs/platform.md`](../../docs/specs/platform.md)，运行故障见
[`../../docs/operations.md`](../../docs/operations.md)。
