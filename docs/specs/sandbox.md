# 原生沙箱规范

**Crate：** `xharness-sandbox`
**状态：** Linux Bubblewrap 已实现并真实运行；macOS Seatbelt 已实现并交叉检查。

## Policy

`SandboxPolicy` 包含 Canonical Workspace Root、一个 `SandboxMode`、显式 Network
Capability 和可选 Read-only Cwd Root。

- `ReadOnly`：Host 可见文件系统只读；临时空间可以写。
- `WorkspaceWrite`：只有 Workspace 和临时空间可写。
- Network 独立为 `Deny`/`Allow`；文件系统模式禁止暗中放开网络。

`FullAccess` 不属于本 Crate，也不是 `SandboxMode`。产品确认后由 `xharness-platform` 直接不创建
Sandbox Adapter；禁止在这里增加一个“什么都不做的沙箱模式”。

受限模式下，如果原生 Backend 不可用或 Cwd 逃出所有声明 Root，必须 fail closed。

## Linux Bubblewrap

Backend 运行真实最小命令 Probe，并缓存成功/失败。它构造直接 Argv，设置只读 Root Bind、
显式 `/dev` 和 `/proc`、临时 `/tmp`、PID 隔离、Parent-death Handling；只有
`WorkspaceWrite` 才绑定可写 Workspace。Network 默认隔离，只有显式允许才共享。
即使后代调用 `setsid`，PID Namespace 也必须继续包含它。

Probe 成功是“这个具体宿主允许所需 Namespace 操作”，不是只检查 `bwrap --version` 或
`kernel.unprivileged_userns_clone`。容器/云主机可能仍阻止 UID Map 或 Loopback 配置。已观察到
WZU_4080 在 Deny Network Probe 中返回 `loopback: Failed RTM_NEWADDR: Operation not permitted`，
改为共享网络又可能返回 UID Map Permission Denied。该环境中 Restricted Process Tool 必须
保持不可用，不能把错误当瞬态重试。

## macOS Seatbelt

Backend 解析 `sandbox-exec`，根据同一 Policy 生成 Deny-default Profile，允许进程执行和
必要系统读取，只在配置要求时放开 Workspace Write/Network。Path 写入 Profile 前必须
Canonicalize 并正确 Escape。

## 当前限制

- Seatbelt 是 macOS 兼容 Backend，仍需在受支持 macOS 版本做原生运行测试。
- 尚无 Windows AppContainer/Job-object Backend。
- 尚无 Per-call User Namespace 调优、Seccomp Profile、Resource Quota 或 Linux
  Landlock Fallback。
- Host 尚未在模型调用前把已缓存的 Probe 失败转成动态 Tool Availability；目前错误会在每个
  Process Tool 调用时重复出现。
- Full access 位于 Platform 权限层，本 Crate 只实现受限模式。

## 验收标准

测试必须检查精确 Argv/Policy Mapping、Canonical Cwd 校验、Capability 分离、Probe
不可用时 fail closed、Probe Cache、真实 Workspace Write 与 Host Denial，
以及 Linux PID Namespace 内 `setsid` 后代的真实清理。
另需覆盖网络 Namespace/UID Map 分别被宿主禁止的 Probe Fixture，断言失败被缓存、受限命令
没有启动、Host 能获得结构化 Capability Unavailable。
