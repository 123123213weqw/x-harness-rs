# 运行、诊断与故障处理

**最后核对：** 2026-08-22

本文记录当前 Rust Web Host 的运行边界。生产能力以源码和各项规范为准；这里不给尚未实现的
自动降级制造假象。

Host 默认把 Agent Session JSONL、Host Control JSONL 和跨进程 Lease 保存在平台数据目录的
`sessions/`、`control/` 与 `leases/`：macOS 为 `~/Library/Application Support/XHarness`，Linux 为
`${XDG_DATA_HOME:-~/.local/share}/xharness`。可用 `XHARNESS_STATE_DIR` 或 `--state-dir` 覆盖；
测试、临时部署和多实例运行必须使用独立目录。

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
- Coding Bundle 注册 14 个稳定工具名；每个模型 Step 只注入当前 Platform/Search/Terminal
  Readiness 可用的子集。
- Preset、权限、Workspace、Coding Workflow 和 Plan Policy 已通过 `xharness-prompt/v1` 真实注入
  System Prompt；Request Header 保存版本和 Hash，System 不进入 Transcript。
- 模型历史、实际 Turn 和 Admission Queue 已写 JSONL Session。启动会枚举并恢复 Session、History、
  Header CWD 对应 Workspace 和 Pending Turn。Prompt RPC Receipt 由完整 Inbox 历史恢复，同 RPC ID
  与 Payload 的请求可安全重试；Workspace 自定义元数据、Settings、审批和其他变更 RPC Receipt
  仍在内存中，因此尚不是整个 API 的完整 Exactly-once 恢复。
- 正式 Host 已安装请求前 Token Guard；配置模型时必须显式声明真实窗口。当前没有自动上下文
  压缩，超限会在本地失败且 Provider Attempt 为零。
- 一个 Host 可以从 `XHARNESS_PROVIDERS_FILE` 加载多个 OpenAI-compatible 路由。Web 只连接
  Host，4080/V100 的 Base URL、协议、上游模型名和窗口预算由 Registry 分别管理。

## 多 Provider 部署

推荐让远端模型服务只监听服务器 loopback，再通过 SSH 转发到运行 Web Host 的机器：

```bash
ssh -N -L 127.0.0.1:19626:127.0.0.1:19626 WZU_4080
ssh -N -J WZU_4080 -L 127.0.0.1:8000:127.0.0.1:8000 WZU_Server
```

随后复制并修改 `config/providers.example.json`，再用：

```bash
XHARNESS_PROVIDERS_FILE=/absolute/path/providers.json \
xharness-host --bind 127.0.0.1:3082
```

启动检查必须分别请求每个 Base URL 的 `/models` 和一次最小生成；SSH Forward 存活不代表远端
模型端口正在监听。配置修改目前需要重启 Host。历史 Session 若选择了已删除路由，仍可浏览，
但 Pending Turn 必须保持 `model-unavailable`，禁止悄悄切到默认 GPU。

当前 WZU_Server 的系统 vLLM/PyTorch CUDA 13 wheel 不包含 V100 `sm_70` kernel，会在启动时返回
`no kernel image is available`。在完成原生 vLLM 重编译前，可用仓库中的单用户部署桥：

```bash
CUDA_VISIBLE_DEVICES=0 python scripts/v100-openai-transformers.py \
  --model /path/to/Qwen3.5-9B \
  --served-model qwen3.5-9b-v100 \
  --context-window 32768 \
  --host 127.0.0.1 --port 8000
```

该桥只负责把 Transformers/Qwen XML 工具调用正规化为流式 Chat Completions；Loop、审批、工具、
Session 和路由仍全部在 Rust Host。它按单用户串行请求，不是高并发生产推理服务器。

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
  `sandbox/mode={mode:"danger-full-access"}`；进程仍必须由 Process Runtime 托管。

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

当前 Hard Guard 已阻止再次向 Provider 发送超窗请求。启动示例：

```bash
XHARNESS_MODEL=your-model \
XHARNESS_CONTEXT_WINDOW=53248 \
XHARNESS_MAX_OUTPUT_TOKENS=4096 \
XHARNESS_TOKEN_SAFETY_MARGIN=1024 \
xharness-host
```

可使用等价参数 `--context-window`、`--max-output-tokens` 和 `--token-safety-margin`。Guard 将
总窗口减去输出预留和安全余量后再接纳输入；Chat/Responses 同时收到对应的原生最大输出字段。
后续分页读取、确定性工具结果压缩和不修改原日志的 Surface Replace 仍由
[上下文预算规范](specs/context.md)定义。

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
