# xharness-platform

XHarness 的编译期原生平台下层。它把以下能力组合成宿主唯一入口：

- 共享的 `xharness-process` 直接 Argv 进程运行时；
- 共享的 `xharness-fs` 路径能力与 Observation CAS；
- Linux Bubblewrap 受限执行；
- macOS Seatbelt 受限执行。

模型 Provider 和 Agent Loop 不依赖本 Crate；CLI/Daemon/Web Host 只在应用组合边界创建
`NativePlatform`。受限 Sandbox Probe 失败必须 fail closed，不能静默退回裸执行。

当前还缺面向 Host/UI 的 `CapabilityReport`。因此 Backend 已确认 Bubblewrap 不可用时，
Host 仍可能把 `bash/glob/grep/terminal_open` 定义发给模型；该问题列为 `P0-13`。完整契约见
[`../../docs/specs/platform.md`](../../docs/specs/platform.md)，运行故障见
[`../../docs/operations.md`](../../docs/operations.md)。
