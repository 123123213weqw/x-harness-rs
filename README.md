# XHarness RS

从零实现的跨平台 AI Agent Harness。核心使用 Rust，目标是提供稳定、可嵌入、
可测试的 Agent Loop；macOS 作为首要本地开发平台，Linux 作为服务器平台。

当前开发版已完成可嵌入 Loop、OpenAI-compatible Provider、append-only Session、
11 个原生 Coding/Job/Web 工具、3 个持久 Schedule 工具与 1 个持久用户交互工具（均按运行时能力动态投影），以及兼容
DeepSeek Harness Web 的第一版
Rust Host。目标不是
把所有能力继续堆进一个 `while`，而是把模型、历史、工具策略、Web 投影和原生执行
能力拆成 typed service。模型 Provider 只由共享核心调用，macOS/Linux/Windows 差异收敛在
最下层，并在编译期选择实现。

```text
XHarness Web UI / future CLI
              |
 xharness-api + server + host
              |
      Long-lived Agent
              |
       Shared Loop Core
       |              |
 Model Provider   Tool Registry
                  /           \
 Session/Event Log   Job Registry + xharness-platform
                          |
             +------------+------------+-----------------+
             |                         |                 |
       macOS Seatbelt             Linux Bubblewrap   Windows ACL/token
       openat/F_GETPATH        openat2/renameat2      Job/ConPTY/ReplaceFileW
```

## 规范与路线图

- [总体架构](docs/architecture.md)
- [全面复刻主控计划](docs/FULL_REPLICATION.md)
- [冻结上游兼容矩阵](docs/compat/MATRIX.md)
- [逐模块规范索引](docs/specs/README.md)
- [上下文预算与压缩](docs/specs/context.md)
- [用户提问与等待交互](docs/specs/user-questions.md)
- [持久定时提醒](docs/specs/schedule.md)
- [Prompt 组装与注入](docs/specs/prompt.md)
- [运行、诊断与故障处理](docs/operations.md)
- [Linux `.deb` 安装与沙箱自配置](docs/specs/linux-deb.md)
- [Windows 原生运行与 DeepSeek 接入](docs/windows.md)
- [Windows 适配与代码复用评估](docs/windows-adaptation-report.md)
- [总 TODO 与交付优先级](docs/TODO.md)
- [Web UI、插件与重建说明](ui/README.md)

行为变更只有在实现、测试、规范和 TODO 状态一致后才算完成。

## Apple Silicon 构件

CI 在 GitHub `macos-15` 的原生 ARM64 Runner 上检查和测试整个 Workspace，并执行真实的
FS Race、Process、PTY 与 Seatbelt 集成测试。每次成功运行都会产出
`xharness-host-darwin-arm64` Artifact，里面包含未签名的 Host、同目录 `rg`、压缩包和 SHA-256
校验文件。Host 会把自身目录置于受管工具 `PATH` 首位，LaunchAgent 的最小环境不会再导致
`glob/grep` 报 `failed to spawn \"rg\"`。
该构件已经是 Apple Silicon 原生二进制，不是从 Linux Cross Compile；正式分发前仍需完成
Developer ID 签名、公证和本机安装验证。

> **当前可用性提醒（2026-09-02）：** Web/持久 Agent/Loop/11 个 Coding/Job/Web 工具、
> 3 个 Schedule 工具与 `ask_user_question`、版本化最小 Coding System
> Prompt、Provider 原生输入计数、请求前 Hard Token Guard 与自动 Compact 已经贯通。无压力时
> Host 逐字重放当前 Surface；达到 80% 或发生 Hard/Provider Overflow 时，会持久摘要安全头部、
> 重新计量后继续。每个 Step 也已按平台 Readiness 动态发送可用工具。Linux Bubblewrap Probe 失败时，
> `bash/glob/grep` 会按设计 fail closed；三个 Job 控制工具仍可收敛历史任务。SIGINT/SIGTERM
> 已走 Agent→Loop→Tool→Job/Process 的结构化收尾，不合作清理会显式报告 Forced Cleanup。详见
> [运行诊断](docs/operations.md)。

正式 Host 二进制已默认使用 JSONL Durable Agent Session 和跨进程 File Lease；
`session.prompt` 成功回执已绑定 Durable Inbox Flush。启动会枚举并恢复可由日志推导的
Workspace/Session/History/Queue，并在先订阅后显式 Wake Pending Turn。History 直接按稳定 Cursor
查询权威 Session Log，Host 只保留受 Event/Byte 双预算约束的投影尾缓存；Web Queue 从 Durable
`next-turn + next-step` 折叠并在变化及重连发送完整快照。Workspace/Settings 与
对应 Mutation Receipt 已进入独立、Secret-free 的 Host Control JSONL。Prompt RPC Receipt 可从
完整 Inbox 历史重建；Session Rename/Model Select、Preset Select 和 6 个 Goal RPC 也已把状态与
Receipt 在同一 Session Revision 原子提交。同 ID/同 Payload 的并发或重启重试不会重复变更；Pending
Approval 已能在原 Turn/Step 上跨重启继续回答。Create/Fork、Queue/Cancel/Attachment 等其他变更
RPC Receipt 尚未持久化，因此还不是整个 API 的完整 Exactly-once 恢复。

## 工作区模块

### `xharness-api` / `xharness-server`

- 固定兼容 `deepseek-harness@141eb6fef8` 的 52 个 unary RPC 名称
- 四象限 RPC envelope、完整错误码、Mux/Host frame discriminant
- `POST /api/<method>`、`POST /api/respond`
- `/api/events.mux` 与 `/api/events.host` 下行 WebSocket
- 可选 Web dist 静态文件与 SPA fallback

### `xharness-host`

- 可复用的 Provider/平台无关 Host 控制面库
- 52 个 RPC 已全部有基础状态行为，不再只是占位路由
- Session/Workspace/预设/Goal/Settings/模型目录的有状态实现；权威 History/Queue 与部分设置已持久化
- `session.prompt` 直接驱动真实 Rust Loop，并投影 turn/step/chunk/tool 事件
- Prompt FIFO、运行时 Steering/Cancel、工具审批与 `/api/respond` 恢复
- JSON Session export 与 Mux/Host 重连基线
- 可显式注入 `ContextPolicy`，兼容构造器当前默认 Identity
- BasicHost 只通过 `AgentRuntime -> RunningTurn` 驱动任务，不直接持有 Provider、工具工厂或
  ContextPolicy；正式 Host 使用 `DurableLoopAgentRuntime`，`LoopAgentRuntime` 仅为兼容实现

### `xharness-host-app`

- 组合 OpenAI-compatible Provider、HTTP/WS Server、原生 11 个 Coding/Job/Web 工具、持久
  `schedule_create/list/delete` 和 `ask_user_question`
- `NativeToolFactory` 按 Workspace 缓存 Platform、共享 Job Registry 并按 Session Owner 隔离
- SIGINT/SIGTERM 先关闭新 Admission，再收敛 Agent/Loop/Tool/Job/Process；
  Forced Cleanup 导致非零退出
- 当前每个模型 Step 按 Sandbox/Search Readiness 投影工具可用子集；选中 Preset
  已经通过 `xharness-prompt/v1`
  成为 Provider 请求中的第一个 System Message
- 生成 `xharness-host` 二进制，默认监听 `127.0.0.1:3080`

当前 Host 的 Web DTO 是进程内派生缓存，但持久真源已经是 Agent/Session：重启会恢复 Session、
History、Header Workspace、Durable Queue 并续跑 Pending Turn/Pending Approval。History 已按
`beforeSeq/maxMessages` 直接游标查询权威日志；Queue 也从 Durable Inbox 折叠 `queued/steering/context`
并在 Mux 重连发送 Baseline。Workspace/Settings 的 9 个变更 RPC，以及 Session
Rename/Model Select、Preset Select 和 6 个 Goal RPC 已通用 Exactly-once。仍需持久化 Queue、
Credential Reference、其余变更 RPC Receipt，并实现真正自主 Subagent。

### `xharness-agent`

- 复刻 DeepSeek Harness 的 `next-turn` / `next-step` 双 Inbox 语义
- `agent/inbox/spliced` 事件可从 Session Log 完整重放，Pending 输入不进入模型历史
- Claim 删除与 `turn/start + user/message` 支持同一 CAS Revision 原子提交
- 进程内 Agent Registry；macOS/Linux File Lease 排除第二个进程同时驱动同一 Session
- Idle/Running/Maintenance 生命周期状态机，从 Session 最后 Turn 坐标恢复
- AgentSupervisor 自动连续消费多 Turn，Active Steer 先持久排队再中断并在恢复时按 ID 去重
- AgentSupervisor 关闭新 Activation，对全部 Worker 共享 Deadline，等待活动 Loop 取消和
  持久 Turn 闭合；超时 Abort 有显式 `forced_cleanup` 结果
- 启动枚举、Pending Turn 先订阅后显式 Wake、无重复 Append 已完成
- Prompt Admission 的持久 Receipt/冲突检测已完成
- Pending Approval 可用原 Approval/Execution ID 在重启后恢复，回答前不会执行 Tool
- 当前剩余 Queue 原子 Move/Mutation Receipt、Credential Reference 与其他非 Prompt Receipt；
  部署级八点硬崩溃矩阵已完成

### `xharness-interaction`

- 冻结 `ask_user_question` 的 1—3 问题、每题最多 3 个选项和可选自由文本契约
- 短期答案进入 Context，显式长期目标使用受管 `agent_markdown` 目标且不接受模型指定路径
- 支持 Submit、部分/空答案 Continue、可恢复 Draft、Dismiss 不结算以及幂等 Resolution 状态机
- 复用正式 `ToolRegistry/ToolSpec`；交互工具使用 `Exclusive + External Settlement + Standalone
  Batch`，等待用户时不触发普通工具超时，混合副作用批次在启动前拒绝，但仍响应结构化 Cancel
- Session Event/Flush、Pending Recovery、`DurableQuestionHub`、`/api/respond`、冻结 Web User
  Questions 组件协议和受管 AGENTS.md Memory Sink 已接通；Host 重启会复用原交互 ID 继续原 Turn
- 折叠卡片会保留当前前端草稿；冻结 UI 尚无跨整页刷新 Draft RPC，Compact 原子切点继续在 TODO

### `xharness-core`

- `LoopEngine::start(LoopRequest) -> LoopRun`
- 流式 `text_delta`、`reasoning_delta` 与工具生命周期事件
- tool-call delta 聚合和多轮模型调用
- 请求输出前的安全重试；已经产生 delta 后禁止重试
- 生产工具批次委托 `xharness-tools::ToolExecutor` 执行 `parallel/keyed/exclusive` 调度；Core
  兼容调度 API 只服务尚未迁移的 Embedder/Test
- 工具超时、取消、panic、未知工具和参数错误统一写回模型
- 默认完整上下文重放，单个工具结果写回限制为 256 KiB；超限使用确定性 UTF-8 Head/Tail
  Envelope（含原始/遗漏 Byte 与 SHA-256），但这仍不是整体 Token 预算或持久 Spill
- 默认最多 128 个模型步骤
- Session 检查点和中断工具批次防重放
- `LoopRun::send(LoopCommand)` 运行时控制：消息注入、Steering、暂停/恢复、取消
- 可选的逐次工具审批；拒绝结果按普通工具错误安全写回模型

### `xharness-context`

- 从完整 Session Transcript 投影一次性的模型可见 `ContextSurface`
- Policy 输入同时包含 Provider、Model、Step 与全部工具 Schema
- Surface 替换记录源消息范围、替换数量、原因和 Policy 版本
- Core 在 Provider I/O 前验证 Surface，并把审计元数据写入 Request Header
- `IdentityContextPolicy` 只保留给嵌入式兼容；正式 Durable Host 使用
  `ToolResultPruningContextPolicy`（投影身份 `context-history-pruning/v2`）在请求 Surface 上
  确定性缩短超过 8,192 字符的 Tool Message、已成功的大型 `write/edit` 历史参数和已完成 Turn
  reasoning，再由独立持久 Compact Coordinator 处理历史范围；Call/Result 拓扑、当前 Turn
  reasoning、opaque Provider Item 和原始 Session 始终保留

### `xharness-token`

- Provider-neutral `TokenMeter`，不依赖 llama.cpp 或任一推理后端
- Core 优先使用 Provider 原生完整请求计数；Chat/Responses 已接入各自输入 Token 端点
- 计数端点不支持时回退保守 UTF-8/JSON Byte Meter；后续本地精确 Tokenizer 实现同一 Trait
- Core 在 Provider I/O 前执行 Hard Guard，预算报告写入 Request Header
- 正式 Host 配置模型时强制声明 Context Window，并把输出预留下发给 Provider

### `xharness-prompt`

- 按稳定顺序组装 Preset、权限、Workspace、Coding Workflow 和 Plan Policy
- 每个 Section、最终 System 和整个 Assembly 均有可审计版本/Hash
- Core 在历史前注入 System，并把 Prompt Audit 与 Tool Definition Hash 写入 Request Header
- System 不进入 Session Transcript；Chat Completions/Responses 请求体均有顺序测试

### `xharness-compaction` / `xharness-debug`

- Compaction 已实现 Provider-neutral 压力规划、80% 触发阈值、16% 最近尾部保留、Tool Pair
  安全切点、Unicode Pruner、Checkpoint Frame 和 Summary Trait；正式 Durable Host 已启用请求前
  Pressure、Hard Overflow、Provider 400 Context Overflow、摘要重计量和持久 Surface Replace
- `compaction/start|summary|end|prune` 已进入 Session/Web 事件词汇；手动 `/compact` 与生产
  Tool Result Pruner 仍是下一切片
- Debug 默认 Noop 零 I/O；显式 Full 模式将 Host/Core/Provider/Tool/Process/PTY/Sandbox/Web/
  Server 事件写入 Secret-safe JSONL，并把大 Payload 放入内容寻址 Blob
- Full Debug 是可删除诊断旁路，不替代权威 Session；Rotation/Retention、指标聚合和 Diagnostic
  Bundle 仍待实现

### `xharness-provider-openai`

- Chat Completions 与 Responses API，协议显式选择
- 增量 SSE：任意网络分片、CRLF、多行 data 和 UTF-8 边界
- Responses 使用 `store=false` 并保留 opaque provider items
- Harness Execution ID 与 Provider Call ID 分离持久化；Chat/Responses Tool Output 使用正确的
  Provider 原生关联 ID
- API Key 不进入 Session，并在 `Debug` 输出中脱敏

### `xharness-session`

- append-only `SessionEvent` 日志，单调 `seq` 与 CAS `Revision`
- `turn/step/request/assistant/tool` 生命周期事件
- 消息历史由日志纯投影，不维护第二份可变 transcript
- 模型请求头保存实际 input、provider/model、system 与 tool schema
- 工具调用先持久化、再允许副作用；崩溃恢复时缺失结果记为
  `outcome_unknown`，绝不自动重放

### `xharness-session-jsonl`

- 每个 Session 一个 JSONL 文件：immutable header + atomic append batch
- 严格校验 revision/seq/格式；中间损坏立即拒绝
- 可恢复未写完的最终 JSON 行，并在下次 append 时修复尾部
- `create_new` 防覆盖、Session ID 路径约束、symlink 拒绝与显式 `sync_data`

### `xharness-control`

- Host 全局状态与 Agent Session 分离：Workspace、Settings、归档和 Mutation Receipt 独立落账
- 每次变更用一个 CAS Revision 原子提交状态事件与通用 Receipt，再经过显式 Flush 才返回成功
- Memory 与跨进程锁定的 JSONL Store 共享相同投影；最终 Torn JSON 行可恢复，中间损坏 fail closed
- 相同 RPC ID/Method/Payload 重放原响应，不同 Payload 复用 ID 冲突
- Settings/Receipt 在写盘前递归拒绝非空 Password、Token、Secret、Authorization 与 API Key 字段

### `xharness-process`

- 三平台 `program + argv` 直接执行，不进行隐式 shell 解析
- 显式 cwd 与 `env_clear` 环境；提供 credential 变量清洗 helper
- Unix 每次调用建立独立 session/process group；Windows 暂停创建、加入 kill-on-close Job 后恢复
- timeout/cancel 收敛整个 Process Group/Job，并等待根进程与受管后代退出
- Supervisor 在 Runtime Abort 时同步清理受管进程树；输出 EOF 只在有界 Grace 内等待
- stdout/stderr 并行 drain，有界保留、总字节计数与 UTF-8 边界安全截断
- 非零退出码是结构化正常结果，不会被误判为 runtime 异常
- Unix process group 只负责生命周期；Windows Job 禁止创建时序逃逸，但不代替文件/网络沙箱

### `xharness-fs`

- 统一 `FsService`、opaque target 与 per-session observation CAS
- 读后才能覆盖；stale/blind write fail closed
- 同目录临时文件、文件 `fsync`、原子发布和目录 `fsync`
- Linux 使用 `openat2 + renameat2`；macOS 使用逐级 `openat(O_NOFOLLOW)`、
  `F_GETPATH + renameatx_np`；Windows 拒绝 reparse escape 并使用 `ReplaceFileW` 保留 DACL

### `xharness-sandbox` / `xharness-platform`

- `NativeSandbox` 编译期选择：Linux Bubblewrap、macOS Seatbelt、Windows ACL partial
- Sandbox 仅含 `ReadOnly / WorkspaceWrite` 和独立网络能力；`DangerFullAccess` 是 Host/Platform
  权限预设，不伪装成沙箱模式
- Restricted 模式后端不可用时 fail closed，不会静默裸跑
- `NativePlatform` 是宿主唯一平台入口，组合 FS、Process 与 Sandbox；Loop 与 Provider
  不依赖操作系统实现

### `xharness-coding-tools`

- 基础工具：`bash/read/write/edit/glob/grep`
- 后台任务：`bash(run_in_background=true)` + `job_output/job_list/job_kill`
- Web：`web_search/web_fetch`
- `CodingToolBundle::specs()` 经 Capability 投影后注册为 `ToolExecutor`，直接接入
  `LoopRequest.tool_executor`
- 变更类工具默认要求宿主审批；`read/glob/grep/web` 可安全并行
- `read` 默认 32 KiB/400 行，支持 `offset`、`start_line`、`limit`、`line_limit` 和版本绑定
  `next_cursor`；大结果 Spill 仍属于上下文 P0 修复

### `xharness-jobs`

- 生产者无关的 Reserve/Commit 注册模式；副作用前先检查每 Owner 10 个活跃任务上限
- `running/stopping/completed/killed/failed` First-wins，按 Owner 隔离可预测 Job ID
- 每条流 256 KiB 未读 Tail、消费式输出、有限 Wait、幂等 Kill 和有界 Shutdown
- Started/Stopping/Finished 广播 seam 已实现；自动唤醒 Idle Agent、持久 Spill 和崩溃后
  Orphan Reconciliation 留在后续 TODO

### `xharness-schedule`

- 复用正式 Tool Registry，提供 `schedule_create/list/delete`，与 Job 的“立即启动后台进程”明确分层
- `schedule/change` 日志是持久真源；进程内 Timer 可丢弃，Host 重启后自动重挂或补发 overdue 提醒
- 支持 `after`、显式 Offset/IANA 时区 `at` 与最小 5 分钟 `every`；周期漏跑只补最新一次
- 只在 Agent Idle 边界投递注入安全的 reminder followup，并沿普通 RunningTurn 实时投影到 Web

### `xharness-terminal` / `xharness-web`

- 真 PTY 底层 Crate 仍保留供专用 Profile 使用，但旧六工具不再进入默认模型 Schema
- owner/name 隔离、单调 cursor、按 bytes+lines 双重限制 scrollback
- 信号发往终端 foreground process group，close 执行 TERM → grace → KILL
- Registry Shutdown 会拒绝新 PTY，并一次收敛全部 Owner/Session 后返回清理报告
- `web_fetch` 仅匿名 HTTP(S)、同源跳转、私网目标拒绝；HTML 先去除 Script/Style 等噪声，
  再生成最多 8,000 字符的 `reader-extractive/v1` 摘要，并支持可选 `focus` 相关段落排名
- DNS 校验地址与实际连接固定；Clash/Surge 的 `198.18/15` Fake-IP 先经加密公共 DNS 验证，
  不放宽直接私网/Reserved IP。Fetch 属于 Host 受控能力，在两种 Session 权限下行为一致
- `web_search` 必须显式注入 Provider；当前包含可选的 Exa 实现，不伪造“本地搜索”

### `xharness-tools`

- 唯一名称 Registry、确定性 schema 列表与 JSON object/schema 校验
- 已有 Durable Journal 时接收并原样贯通 `execution_id`；独立调用时才生成进程内 ID，所有失败均
  物化为结构化结果
- `pre → monotonic guards → approval → around → handler → post → finalize → observer`
- guard 只允许把权限从 allow 收紧到 ask/deny，后续 middleware 不能反向放宽
- 缺失、异常、panic 或超时的审批 provider 全部 fail closed
- handler timeout/panic/cancel 与 middleware panic 不会炸掉 Agent Loop
- `parallel/keyed/exclusive` declarative gate；同 key 串行、exclusive 形成全局屏障
- `ToolBatchRun` 统一 Model-order 调度、Batch 并发上限、真实完成事件和稳定重放顺序
- `ToolLifecycle::started` 在 Handler 副作用前等待宿主持久边界，失败或 Panic 时 fail closed

## 最小嵌入

```rust,no_run
use std::sync::Arc;

use futures::StreamExt;
use xharness_core::{AgentMessage, LoopEngine, LoopRequest};
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig,
};

#[tokio::main]
async fn main() {
    let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::Responses,
        "https://api.openai.com/v1",
        std::env::var("OPENAI_API_KEY").unwrap(),
        "your-model",
    ))
    .unwrap();

    let request = LoopRequest::new(
        Arc::new(provider),
        vec![AgentMessage::user("分析当前目录")],
    );
    let mut run = LoopEngine.start(request);

    while let Some(event) = run.events().next().await {
        println!("{event:?}");
    }
    println!("{:?}", run.result().await.status);
}
```

## 运行时控制

`LoopRun` 内部带有独立的有界命令通道。宿主可以在消费事件的同时控制运行：

```rust,no_run
use xharness_core::{AgentMessage, InjectionMode, LoopCommand};

# async fn control(run: &xharness_core::LoopRun) -> Result<(), xharness_core::LoopControlError> {
run.send(LoopCommand::InjectMessage {
    message: AgentMessage::user("下一轮同时检查测试覆盖率"),
    mode: InjectionMode::NextStep,
}).await?;

// 中断当前模型流；已输出的正文会保存为 interrupted assistant turn。
run.send(LoopCommand::Steer(AgentMessage::user(
    "停止当前方向，改为先修复编译错误",
))).await?;

run.send(LoopCommand::Pause).await?;
run.send(LoopCommand::Resume).await?;
# Ok(())
# }
```

需要审批的工具使用 `.requires_approval()` 声明。Loop 会发出
`ToolApprovalRequested`，宿主随后发送 `ApproveTool` 或 `RejectTool`。暂停时不再启动新工具，
但已经启动的工具允许收尾；工具运行期间收到的 Steering 会延迟到完整工具批次之后，避免破坏
assistant tool-call 与 tool result 的协议顺序。

## 持久 Session

设置 `journal_store` 后，事件日志会取代旧 snapshot store 成为历史真源。下面使用磁盘
JSONL；测试或嵌入场景也可使用 `xharness_session::MemorySessionStore`：

```rust,no_run
use std::sync::Arc;

use xharness_core::{AgentMessage, LoopEngine, LoopRequest};
use xharness_session_jsonl::JsonlSessionStore;

# fn provider() -> Arc<dyn xharness_core::ModelProvider> { todo!() }
# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let store = Arc::new(JsonlSessionStore::new(".xharness/sessions")?);
let mut request = LoopRequest::new(provider(), vec![AgentMessage::user("继续修复项目")]);
request.session_id = Some("project-main".into());
request.journal_store = Some(store);

let run = LoopEngine.start(request);
let result = run.result().await;
assert!(result.error.is_none(), "{:?}", result.error);
# Ok(())
# }
```

写入边界如下：用户输入和 request header 在模型调用前 flush；完整 assistant
tool-call 在工具运行前 flush；完整工具批次按模型原顺序写入并 flush。进程若死在
tool-call 与 tool-result 之间，下次恢复只生成 `outcome_unknown`，让模型先检查外部状态。
当前 JSONL backend 使用进程内互斥和 OS 文件锁保护跨进程 CAS；更高层仍应使用
single-writer lease 来表达 Agent 所有权。SQLite backend 属于 Agent 控制层下一阶段。

## 启动 Web Host

仓库已经版本化保存 XHarness 自有 Web 插件、品牌覆盖、重建脚本和可直接部署的完整静态 Bundle：

```text
ui/plugins/     XHarness Context/Schedule 等产品插件源码
ui/overrides/   品牌组件与图标源码覆盖
ui/dist/        Fresh Clone 可直接由 Rust Host 托管的静态 Bundle
```

`ui/dist` 基于冻结版本 DeepSeek Harness Web UI 的 MIT 许可构建，第三方声明见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。上游 `@deepseek-ai/dsh-*` 名称是浏览器插件
协议兼容标识，不是残留的可见品牌。Host 支持环境变量和等价的 `--bind`、`--workspace`、`--static-dir`、
`--provider`、`--model`、`--base-url`、`--api-key`、`--protocol` 参数：

```bash
XHARNESS_WORKSPACE=/path/to/project \
XHARNESS_WEB_DIST=$PWD/ui/dist \
XHARNESS_BASE_URL=http://your-model-server:8000/v1 \
XHARNESS_MODEL=your-model \
XHARNESS_CONTEXT_WINDOW=53248 \
XHARNESS_MAX_OUTPUT_TOKENS=4096 \
XHARNESS_TOKEN_SAFETY_MARGIN=1024 \
XHARNESS_API_KEY=optional-key \
XHARNESS_PROTOCOL=chat \
cargo run -p xharness-host-app --bin xharness-host
```

浏览器打开 `http://127.0.0.1:3080/`。`XHARNESS_PROTOCOL` 只能显式使用 `chat` 或
`responses`，不会自动回退。没有配置模型时 Host 仍能启动和浏览状态，但
`session.prompt` 会返回 `model-unavailable`。远程部署前必须先补认证/Origin 策略；当前
安全默认是仅监听 loopback。

Windows 11 / Windows Server 2025 可以直接使用 PowerShell 7、ConPTY、Job Object 和
restricted-token ACL 后端，不需要 WSL。DeepSeek 官方 API 的无明文凭据启动、
SSH/Git Bash 调用和安全边界见 [Windows 原生支持](docs/windows.md)。

同一个 Host 同时接入 4080、V100 或云端接口时，使用
`XHARNESS_PROVIDERS_FILE` / `--providers-file` 加载多路由 JSON：

```bash
XHARNESS_PROVIDERS_FILE=$PWD/config/providers.example.json \
XHARNESS_WORKSPACE=/path/to/project \
XHARNESS_WEB_DIST=$PWD/ui/dist \
xharness-host --bind 127.0.0.1:3082
```

从冻结上游重新生成 Web Bundle：

```bash
scripts/rebuild-ui.sh /path/to/deepseek-harness
node scripts/test-context-plugin.mjs
node scripts/test-schedule-plugin.mjs
```

重建脚本会先编译完整上游 Client face，再把产品插件加入同一依赖图并生成
`ui/dist/client-graph.json`。提交 Web 改动时必须同时提交插件/覆盖源码、重建脚本变更和新的
`ui/dist`，避免仓库源码与实际部署页面漂移。

配置中的公共 `provider/model` 是 Web 与 Session 使用的稳定路由；`upstream_model` 是具体
OpenAI-compatible 服务接受的线协议模型名。Context Window 的硬上限不由 Harness 猜测：优先由
精确 Provider/Deployment 的结构化 Capability 端点报告；`fallback_context_window_tokens` 只是
端点不支持能力发现时的显式兼容值，并以 `deployment_declared_fallback` 来源投影，不能冒充服务端
报告。目标输出 `max_output_tokens`、可选 `minimum_output_tokens` 和安全余量仍属于 Harness 请求
策略。云端凭据只通过 `api_key_env` 引用环境变量，禁止写入配置文件。配置示例见
[`config/providers.example.json`](config/providers.example.json)，完整不变量见
[LLM/Provider Registry 规范](docs/specs/model-registry.md)。旧的单接口参数保持兼容。

推理强度同样属于精确模型路由，而不是前端全局枚举。模型可通过 `reasoning.efforts` 声明自己
支持的 ID、显示名和说明，并用 `default_effort` 指定默认项；DeepSeek Harness 的模型菜单会只
显示当前模型实际声明的选项。每项 `request_patch` 由 OpenAI-compatible Adapter 在请求发出前
合并，可映射 `reasoning_effort`、llama.cpp 的 `chat_template_kwargs` 或其他端点扩展。Patch
禁止覆盖 `model/messages/input/tools/stream/max_tokens` 等 Core 所有字段。选择值在网络前按精确
模型校验，并持久化到 Session 与 `request/header`；切换到不支持推理等级的模型时不会继承旧值。

模型服务的真实上下文以部署参数为准。例如 llama.cpp 的 `-c 53248` 代表整个请求窗口，
System、历史、工具 Schema、模板和输出预留都要共享它。Session 可以通过 Web 在该硬上限内选择
更小的软窗口；选择值写入 Session，Token Guard 与 Compact 都按该软窗口工作，超过 Provider 上限
则在网络前拒绝。能力未知且没有显式兼容 fallback 时正式 Host 拒绝启动。正式 Durable Host默认
自动压缩；嵌入式 Core 只有显式提供 Journal、Token Guard 和 Compaction Config 才启用。长任务
细节见[上下文预算规范](docs/specs/context.md)。

## Linux `.deb`

正式包在 `postinst` 中自动安装匹配当前 Ubuntu AppArmor ABI 的
`bwrap-userns-restrict`，并以非特权用户验证 Workspace 写入、外部拒写、Network Namespace
和 PID 后代清理。它不会关闭全局 User Namespace 加固，也不会自动切换 Full Access。

遵守远程编译策略，从 Mac 发起：

```bash
scripts/remote-build-deb.sh WZU_Server
```

产物下载到本地 `dist/`。完整安装/升级/卸载契约见
[`docs/specs/linux-deb.md`](docs/specs/linux-deb.md)。

## 远程开发

不要在本机编译 Rust。使用：

```bash
scripts/remote-rust-test.sh WZU_Server
```

源码会同步到 `WZU_Server:~/codex-build/x-harness-rs/`，然后远程运行：

```text
cargo fmt --check --all
cargo check --workspace --all-targets
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

当前测试覆盖：正文/reasoning、多轮工具、分片 tool calls、坏参数、未知工具、超时、
panic、重试边界、取消、步骤限制、UTF-8 截断、并发上限、keyed/exclusive 屏障、
历史顺序、异常批次恢复、消费者提前退出、消息注入、模型中断、暂停/恢复、工具审批、
工具期间延迟 Steering、durable call-before-side-effect、outcome-unknown 恢复、JSONL
CAS/损坏/断尾恢复、两个 OpenAI 协议的原生 HTTP 集成、真实 Host 进程重启、Full access
Workspace 外读写/网络/进程清理、Runtime Drop、不合作 Handler、Bash Result 不早于
Leader/Descendant 死亡、Job 五态/输出/Shutdown、真实 Host SIGTERM，以及真实 Chromium 的权限
确认和 retry #8 后完整基线恢复。
Loop 运行事件使用按数量与 Byte 双预算的非阻塞 Journal，测试覆盖慢消费者 Lag、Resume Cursor、
完全不消费和单个超大事件。
浏览器黑盒测试的环境变量和运行方法见
[`tests/web-e2e/README.md`](tests/web-e2e/README.md)。

## 路线图

1. 删除 Core 旧 `LoopRequest.tools` 兼容 Scheduler，所有 Embedder/Test 统一到 `xharness-tools`
2. 完成强类型配置与 Credential Reference Store，再补 Web Host 认证/Origin 策略
3. WebSocket 持久 Cursor Resume、完整 Mutation Receipt 和 Web Readiness 投影
4. macOS Live Provider/安装验证、Developer ID 签名与公证
5. 大工具结果持久 Spill/Pruner、手动 `/compact`、完整 Prompt Registry 和 Purpose Router
6. Job 完成通知/Wake、Skills、MCP、LSP、附件与 Subagent/Workflow 调度

完整任务、优先级和验收条件见 [`docs/TODO.md`](docs/TODO.md)；架构边界与
不变量见 [`docs/architecture.md`](docs/architecture.md)。

## License

Apache-2.0
