# 原生平台门面规范

**Crate：** `xharness-platform`
**状态：** Linux 已实现并实测；macOS 已实现并交叉检查。

## 目标

`NativePlatform` 是模型工具所需的唯一原生组合入口。它拥有一个 `FsService`、
`ProcessRuntime` 和编译期选择的 `NativeSandbox`。Core、Session、Provider Crate 禁止
按操作系统分支。

## 契约

`PlatformConfig` 绑定 Canonical Workspace、Sandbox Mode、Network Capability 和可选
Read-only Cwd Root。`NativePlatform::new` 必须使用同一权限边界初始化全部原生服务。
`prepare_spawn` 只应用 Sandbox Policy、不启动进程；`spawn` 先 Prepare 再 Launch，
返回受管 `ProcessHandle`。

平台还必须提供无副作用、可缓存的 `CapabilityReport`：FS Read/Mutation、Restricted Process、
PTY、Network 和具体 Sandbox Backend 的 Available/Unavailable Reason。报告用于 Host/UI 和
下一 Step 的 Tool Projection；它不能自动改变 Policy，也不能把 unavailable 变成 Full Access。

支持目标为 `target_os=linux` 和 `target_os=macos`。在定义 Backend 契约前，不支持的平台
应故意编译失败。`PlatformKind::CURRENT` 在编译期选择，禁止运行时 Probe 决定。

## 依赖方向

```text
coding tools -> NativePlatform -> fs + process + native sandbox
core/provider/session ----------------X（禁止原生依赖）
```

受限 Shell/Terminal 进程禁止绕过 `prepare_spawn`。可信进程内文件修改仍必须经过
`FsService` Path/CAS 规则。

## 当前限制

- 尚无面向 CLI/UI 的 Host Capability Report。
- 因此当前 Host 即使已经缓存 Bubblewrap Probe 失败，仍会向模型发送依赖它的工具定义。
- 尚无运行时 Backend Plugin 或 Remote-execution Platform。
- macOS 仍需要真实原生集成运行和打包产物验证。

## 验收标准

测试必须证明门面共享配置的 Workspace/Policy，正确选择目标平台，并确保 Prepare/Spawn
命令经过原生 Sandbox。两个目标平台家族都必须通过编译期 Lint。
Capability 测试必须证明 Probe 只执行一次、错误原因稳定、动态工具投影可消费该报告，并且
`DangerFullAccess` 只有显式配置时才显示为可用。
