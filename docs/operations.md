# 运行、诊断与故障处理

**最后核对：** 2026-08-21

本文记录当前 Rust Web Host 的运行边界。生产能力以源码和各项规范为准；这里不给尚未实现的
自动降级制造假象。

## 启动前检查

1. 明确 Provider 协议：`chat` 或 `responses`，禁止自动回退。
2. 明确模型真实上下文窗口。llama.cpp 的 `-c` 是服务端硬上限，不等于模型宣称的训练窗口。
3. 检查 Workspace、沙箱模式与网络能力。
4. Linux 受限模式必须先运行 Bubblewrap 最小 Probe；失败即代表 Process 工具不可用。
5. 确认 Web Host 仅绑定 loopback；远程认证和 Origin Policy 尚未完成。

正式 Ubuntu 安装优先使用 `.deb`：其 `postinst` 会自动检测 AppArmor、安装匹配本机 ABI 的
官方 Bwrap Profile，并执行真实隔离测试。用户只在 apt/dpkg 安装时完成一次管理员授权，日常
启动不再修改系统。细节见[Linux `.deb` 安装规范](specs/linux-deb.md)。

## 当前 Web Host 能力

- 52 个上游兼容 RPC 有基础状态行为。
- `session.prompt` 可驱动真实 Rust Loop。
- 每个模型 Step 当前固定注入 14 个工具的 name/description/Schema。
- Preset 文本目前没有作为 System Prompt 注入。
- Host 状态、队列、审批和消息历史仍主要在内存中，重启不会完整恢复。
- 当前没有请求前 Token Guard 或自动上下文压缩。

## Sandbox Probe 失败

典型错误：

```text
native sandbox is unavailable: minimal isolation probe failed:
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

含义：宿主/容器策略阻止 Bubblewrap 创建所需 namespace 或配置 loopback。此时 `bash`、
`glob`、`grep` 和新建进程的 `terminal_open` 会失败；可信 Rust 内执行的 `read/write/edit`
不走同一路径，可能仍可用。`terminal_read/list/close` 只管理已有 Session，不应与“能否新建
受限进程”混为一谈。这不是瞬态网络错误，重复调用通常没有意义。

处理原则：

- 保持受限模式 fail closed，不静默退回裸执行。
- 优先部署兼容的 Bubblewrap 环境或实现/启用 Landlock 等后备 Backend。
- Host 应把 Probe 结果投影为 Capability，并从下一 Step 移除 `bash/glob/grep/terminal_open`；
  只有存在历史 Terminal 时才保留相应的 read/signal/close 管理工具。
- 只有操作者明确选择 `Full access` 时才允许关闭权限沙箱，并明确记录
  `sandbox/mode={enabled:false,mode:"disabled"}`；进程仍必须由 Process Runtime 托管。

## Context 超窗

典型错误：

```text
request (64196 tokens) exceeds the available context size (53248 tokens)
```

这表示 Harness 发出的完整请求已经超过服务端窗口，不是模型生成阶段“突然停止”。界面中的
`Stopped` 也可能只是一个模型 Step 以 Tool Call 结束；最终 `This turn failed` 才是终态。

临时人工规避：

- 新建 Session，避免继续重放已经膨胀的历史。
- 不要整文件读取；先读取入口、符号附近或小范围行。
- 服务端扩窗只能在显存和模型部署确实支持时使用，不能替代 Host 预算管理。

正式修复由[上下文预算规范](specs/context.md)定义：请求前计量、输出预留、分页读取、确定性
工具结果压缩和不修改原日志的 Surface Replace。

## 诊断 Session

排查失败 Turn 时至少记录：Session ID、模型/协议、服务端上下文参数、每 Step Finish Reason、
Usage、工具 Schema 数量、各消息/工具结果字节数、Sandbox Probe 结果和最终业务错误。导出中禁止
包含 API Key 或环境凭据。

判断顺序：

1. Provider 是否在开始生成前返回 4xx；若是，先看 Context/协议。
2. 哪个 Tool Result 让下一 Step 的输入突然增长。
3. Process 工具是否共享同一个已缓存的 Sandbox Probe 失败。
4. 模型是否在已经获得足够信息后仍发起无必要读取。
5. 实际 Provider 请求是否包含预期 System Prompt 与 Tool 子集。

## 发布验证

本机禁止编译 Rust。源码通过 `scripts/remote-rust-test.sh WZU_Server` 同步到远端，再执行
Workspace `fmt/check/test/clippy`。GPU 相关真实模型测试优先使用对应服务器；任何诊断 Fixture
都必须去除路径之外的敏感配置与凭据。
