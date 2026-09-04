# XHarness 全面复刻主控计划

**建立日期：** 2026-08-21
**状态更新：** 2026-09-02
**冻结兼容基线：** `deepseek-harness@141eb6fef8`
**已发现上游远端 HEAD：** `b150a551b8d4`（尚未纳入兼容基线）
**执行原则：** 复刻可观察行为、协议和生命周期，不逐行翻译 TypeScript，也不复制 Cordis/HMR。

本文是全面复刻工作的主控面板；稳定任务 ID、详细验收条件和完成状态继续维护在
[`TODO.md`](TODO.md)。每次上游升级先生成差异清单，禁止直接把未知语义混入 Rust 主线。
冻结基线的机器可读目录与逐项矩阵见 [`compat/MATRIX.md`](compat/MATRIX.md)。

## 一、完成定义

一个任务只有同时满足以下条件才能勾选完成：

1. 有中文规范，明确正常、失败、取消、恢复和权限语义。
2. Rust 实现没有把 Provider、平台或 Web DTO 泄漏到错误层级。
3. 单元、集成、协议或浏览器测试覆盖主要路径和至少一个失败路径。
4. Rust 源码同步到 `WZU_Server`，远程通过整个 Workspace 的 Check、Test 和 Clippy。
5. 平台相关功能还必须通过对应 Linux/macOS/Windows 原生验证。
6. 更新本文件、`TODO.md`、对应 Crate Spec 和用户文档。
7. 如果改变 Web 可观察行为，更新冻结协议 Fixture 和兼容矩阵。

## 二、兼容分级

| 等级 | 含义 |
| --- | --- |
| `exact` | 方法、事件、字段、顺序、错误和恢复行为均与冻结上游一致 |
| `behavioral` | 线协议兼容，Rust 内部实现不同，但用户可观察行为一致 |
| `partial` | 已有基础行为，存在已记录差异 |
| `planned` | 已进入稳定 TODO，但尚无兼容承诺 |
| `not-applicable` | Cordis/HMR 等内部机制由 Rust 等价抽象替代 |

## 三、模块总图

```text
XHarness Web UI / CLI / ACP
                |
        xharness-api/server
                |
          xharness-host
                |
          xharness-agent
                |
 prompt / context / token / llm registry
                |
          xharness-core
                |
          xharness-tools
                |
 process / fs / sandbox / terminal / web / git / mcp
                |
        Linux / macOS platform
                |
 session / jsonl / blob / credential-reference
```

## 四、里程碑主表

| 里程碑 | 目标 | 当前状态 | 阻塞后续 |
| --- | --- | --- | --- |
| `M00` | 冻结上游目录、RPC、事件、工具、Prompt、Settings 兼容基线 | 已完成 | 全部 |
| `M01` | 持久 Agent 接管 Web Host，重启不丢输入、不重复副作用 | **主链路已完成**；非 Prompt Mutation Receipt 转入 M05 | Web、Subagent |
| `M02` | 统一 Tool Runtime、Execution ID 和结构化 Shutdown | 生产路径已完成；只剩 Core 旧兼容 API 删除 | MCP、Jobs |
| `M03` | Prompt/Provider Registry、Token Guard、Context Compaction | Registry 基线、最小 Prompt、原生计数、Hard Guard 与自动 Pressure/Overflow 已完成；手动/Pruner/Purpose 路由待完成 | 长上下文、质量 |
| `M04` | Linux/macOS/Windows 原生工具、Readiness 和动态工具投影 | 三平台原生工具和模型侧投影已完成；Web Readiness 仍未完整投影 | 日常使用 |
| `M05` | Web 持久状态、游标续传、认证和完整 UI Projection | 权威 History/Queue、版本化 XHarness UI Bundle/产品插件和部分 Receipt 已完成；Cursor/Auth/完整投影未完成 | 产品发布 |
| `M06` | Git、MCP、Skills、LSP、本地代码索引 | 未开始 | 高级 Coding |
| `M07` | 多模态、Blob、Session Branch/Import/Export | 未开始 | 多模态 Agent |
| `M08` | Subagent、Workflow、Scheduler、Remote Execution | 持久 Schedule 已完成；Subagent/Workflow/Remote 未开始 | 团队 Agent |
| `M09` | 安装包、签名、公证、观测、配额、Fuzz 和安全发布 | Full Debug Trace 和 ARM64 CI 已完成；发行门禁未完成 | 正式版 |

当前只保留一条面向本地单用户产品的主要阻塞链：

```text
M02 删除 Core 旧 Tool 兼容 API → M05 Credential/Cursor
    → M04/M09 安装发布 → M06/M07 生态 → M08 多 Agent
```

M00 与 M01 已不再阻塞正式 Host 主链路；M02 的生产 Tool Runtime、身份与结构化终止
已完成，当前只剩旧 Core 兼容 API 删除。MCP/Skills/LSP/Subagent 不阻塞单用户
Coding Agent 日常使用。

## 五、当前执行批次

### Batch A：兼容基线与持久 Web Agent

> 当前进展：正式 Host 已切到 `DurableLoopAgentRuntime + JSONL + File Lease`，连续 Turn 历史由
> Session Log 重放；HTTP `session.prompt` 已先 Flush Durable Inbox 再返回成功，Claim 与
> Turn/Input 已在同一 CAS Revision，Queue Edit/Remove 也同步到 Inbox。JSONL 目录枚举、
> Session/History/Workspace/Queue 启动 Replay、恢复前订阅与显式 Wake 已完成；History 已直接
> 按稳定 Cursor 查询 Session Log，Host 只缓存受 Event/Byte 双预算约束的连续尾部。Queue 已从
> 完整 Durable Inbox 折叠并在每次变化及 Mux 重连发送权威快照，Driver Attachment 与其分离。
> Prompt RPC Receipt 已从 Durable Inbox
> 历史重建；Approval Asked/Decided 与 Provider Retry/Started 已强类型持久化和投影，Pending
> Approval 已能在原 Turn/Step 上跨重启继续回答；Agent/Permission/Sandbox/Approval Policy 和 Permission Command
> Receipt、Session Title、Model Select、Agent Preset 选择、Goal Snapshot/Tombstone 与 Idle Plan Mode 已持久化；
> Rename/Model/Preset/Goal 的 Session 原子 Receipt 也已完成，Queue/Attachment 等其他
> 变更 RPC Receipt 未持久化，
> 因此 `A-09` 尚不能勾选。Catalog v2 已记录
> 52 固定 RPC、26 动态 Typert RPC、Mux/Host 各 10 个 Frame、11 个转发 Host Event、48 Session
> Event、63 个 Tool 注册点（53 个 Literal）、37 个 Prompt Component、6 个 Settings 注册点
>（5 个静态 Namespace）、69 个 Service Definition、18 个 `ctx.provide`、4 个 Preset 和 233 个
> Package；`A-01/A-02/A-03` 已完成，后续升级用同一 Schema 生成 Delta。

- [x] `A-01` 抽取冻结上游 52 RPC、动态 RPC、Host/Mux Frame、Session Event 目录。
- [x] `A-02` 抽取上游工具、Prompt Section、Settings、Profile、Service Definition 目录。
- [x] `A-03` 生成 `docs/compat/` 机器可读 JSON 和中文矩阵。
- [x] `A-04` 对远端 `b150a551b8d4` 生成相对 `141eb6fef8` 的增量审计，不修改上游工作树。
- [x] `A-05` 为 Host 建立持久 Session/Agent Backend，删除内存 Prompt FIFO 的真源地位。
- [x] `A-06` `session.prompt` 先写 Durable Inbox，再返回成功回执。
- [x] `A-07` Agent Claim、`turn/start`、`user/message` 在同一 CAS Revision 提交。
- [x] `A-07a` `session.prompt/subagent.prompt` 建立跨并发、消费和重启的持久 Admission Receipt；
  相同 RPC ID + Payload 幂等成功，不同 Payload 复用 ID fail closed。
- [ ] `A-08` 把 Agent Event 确定性投影为冻结 Web Session Event。权威 History Cursor、运行/重启
  同源纯投影、结构化 User Message、Approval Asked/Decided、Provider Retry/Started、Agent/
  Permission/Sandbox/Approval Policy 和 Command Lifecycle 已完成；48 个冻结事件当前强类型覆盖
  25 个，剩余 23 个继续逐项做 Schema/Fixture 等价。
- [ ] `A-09` 重启恢复 Workspace、Session、Inbox、运行终态和未决 Outcome。已完成由
  Session Header/Log 可推导的 Workspace、Session、History、模型路由、Next-turn Queue 和
  Pending Turn、Prompt RPC Receipt、Agent/Permission Policy、Permission Command Receipt、Session
  Title、Model Select、Agent Preset 选择、Goal Snapshot/Tombstone、Idle Plan Mode、Pending Approval
  交互恢复，以及 Rename/Model/Preset/Goal 的 Session 原子 Receipt；
  自定义 Workspace 元数据/排序/归档、Settings 以及对应 9 个变更 RPC 的通用 Receipt 已进入
  独立 Control Log。未完成 Session Create/Fork、Queue/Cancel/Attachment、Preset Copy/Remove 等
  变更 RPC 的统一 Receipt、Credential Reference，以及 queued-to-steer 的原子 Move。
- [x] `A-10` Admission/Claim/Request Header/Tool Call/Tool Result/Step End/Turn End 七点均有
  确定性日志前缀测试；真实子进程 SIGKILL 另加入 Approval Asked，共八点。父进程在相同 State Dir
  重启正式 JSONL Host/Core，验证不丢输入、未批准 Tool 不执行、未知 Tool 不重放、
  Interrupted/OutcomeUnknown 和权威结果保留。

### Batch B：工具身份与终止语义

- [ ] `B-01` Core 全面迁移到 `xharness-tools`，删除重复调度器。正式 Tool Batch Scheduler、
  Model-order Barrier、Per-batch Limit 和副作用前 Lifecycle Ack 已在 `xharness-tools` 完成；生产
  Host、当前 11 工具、Fresh/Recovery Batch、Core Command/Journal Bridge 已切换到正式 Executor。
  剩余仅旧 Embedder/Test 迁移与 Core 兼容 Scheduler 类型/分支删除。
- [x] `B-02` 内部 `execution_id` 与 `provider_call_id` 已分离并稳定持久化；两种 OpenAI
  协议重放使用 Provider ID，Journal/Approval/Result 使用 Execution ID。
- [x] `B-03` Approval、Journal、Middleware、Event、Result 全链使用同一 Durable Execution ID；
  Provider Call ID 只保留在线协议重放路径。Core 的重复调度/审批删除继续由 `B-01` 跟踪。
- [x] `B-04` Provider/Tool/Process 放入结构化所有权链；Agent Supervisor 负责共享
  Shutdown Deadline，正式 Tool Batch 和 Process Handle 负责内层 Join。
- [x] `B-05` Cancel 先 Signal，再 Join/强制清理，最后发布终态；超时是
  `CleanupTimeout/ForcedCleanup`，Host 不会将其报告为成功退出。
- [x] `B-06` 逃逸后代、Runtime Drop、Handler Abort、Bash Result 与 Process Death 顺序、
  活动 Provider Stream、持久 PTY 和真实 SIGTERM 回归。`FullAccess setsid()` 逃逸的硬回收
  仍明确属于受限 Sandbox/PID Namespace，不虚假扩大 Process Group 能力边界。

### Batch C：Prompt、Context、Token、Provider

- [ ] `C-01` 实现完整有序 Prompt Registry；最小 `xharness-prompt/v1` 组装和版本化 Request
  Header 已完成，剩余动态注册、Scope、Variable 与 Provider Section。
- [x] `C-02` 真实注入 Coding Preset，而不是只在 Web 中保存文本。
- [ ] `C-03` 实现 Provider/Model/Purpose Registry 和能力发现。Provider/Model 多路由、公共
  Route 与上游模型名分离、每路由 Token Guard、JSON 配置和 Web 目录已实现；Purpose、
  Reasoning 原生控制与模型 Capability 发现仍待完成。
- [x] `C-04` 实现 Tokenizer 抽象与安全估算后备；Chat/Responses Provider 原生完整请求输入计数
  已接入，404/405/501 时缓存 Capability Miss 并回退保守 Meter。
- [x] `C-05` Provider I/O 前计量 System/消息/工具 Schema/协议模板/输出预留。
- [x] `C-06` 固化 `64196 > 53248` 为 Provider Attempt=0 的回归。
- [ ] `C-07` 分页 Read、Tool Result Spill 和 Head/Relevant/Tail Surface。分页 Read、版本绑定
  Cursor 与单结果确定性 Head/Tail Envelope 已完成；Spill、Relevant 与历史 Surface Replace 待完成。
- [x] `C-08` Surface Replace/摘要不删除原 Event Log。`DONE-57` 已完成强类型 Compaction 事务、
  Checkpoint `surfaceReplace`、重启闭合和重新计量；`DONE-68` 的一次性 Tool Result Pruner 仍需在
  `C-07/P0-12` 落成持久 Spill/Reference，但不会改变本项已经成立的 Event Log 不变量。

### Batch D：平台与可扩展工具

- [ ] `D-01` 启动时探测 Sandbox、Search、Browser、Git、LSP 能力。已完成 Sandbox 与 Search
  缓存 Readiness；默认模型面已移除 PTY，Browser/Git/LSP 尚未接入。
- [ ] `D-02` 不可用工具从模型请求和 Web 工具目录中同时移除。模型请求侧已完成；Web UI
  工具目录/Workspace Readiness 投影尚未接通。
- [ ] `D-03` 扩展 FS：list/mkdir/move/copy/delete/patch/image/binary/paged-read。Paged Read 已完成。
- [ ] `D-04` 后台 Job Registry 第一阶段、Process-tree 清理已完成；剩余完成通知/Wake、重启
  Outcome Unknown/Orphan Reconciliation 和 Spill。
- [ ] `D-05` 专用 Terminal Profile 的 Resize、OSC133、Foreground PGID、Settle Reason；默认
  模型面不再提供旧六工具。
- [ ] `D-06` Web Search Provider、引用对象、正文提取、缓存和 SSRF/Rebinding。
- [x] `D-07` Linux/macOS/Windows 等价语义测试；底层分别使用 Process Group、Job Object、
  Bubblewrap/Seatbelt/ACL partial、PTY/ConPTY，不要求系统调用相同。

### Batch E：Web 产品闭环

- [x] `E-01` 事件改为按事件数和序列化 Byte 双预算的有界 Journal，并提供 Lag/Resume Cursor
  Subscription；跨 WebSocket 连接的持久 Cursor 继续由 `E-02` 完成。
- [ ] `E-02` WebSocket 支持 Cursor Resume、Lag、Reconnect 和 Session Mux。
- [x] `E-03` History 从 Session Log 按 `beforeSeq/maxMessages` 重建，不依赖进程内
  `Vec<Value>`；Host Event DTO 仅保留有界连续尾部，Search/Fork 也不因驱逐丢历史。
- [ ] `E-04` Approval/Terminal/File/Web/Usage/Recovery Projection 全量对齐。
- [ ] `E-05` Health、Readiness、诊断包和部署状态接口。
- [ ] `E-06` 默认 Loopback；远程模式增加 Auth、Origin、Owner/Workspace 隔离。
- [ ] `E-07` Settings/Profile/Credential Reference 持久化且日志永不含 Secret。
  Settings 已完成；Control Log 会拒绝非空 Secret 字段。Profile 与 Credential Reference 尚未完成。
- [ ] `E-08` 真实 Chromium 覆盖刷新、断线、Host 重启和审批恢复。
- [x] `E-09` 持久 User Questions：`ask_user_question` 的公共类型、有限选项/自定义输入、
  Draft/Continue/Cancel 状态机、Tool Registry、Session Flush/Recovery、
  `question/requested|resolved` Mux 投影、现有前端组件复用和受管 AGENTS.md Memory Sink 已完成。
  跨刷新 Draft 同步与 Compact 原子安全切点分别保留给 `E-08/P1-03`，不阻塞当前交互闭环。

### Batch F：生态与高级能力

- [ ] `F-01` Git 安全 Argv 工具与 Worktree 感知。
- [ ] `F-02` MCP Stdio/HTTP Client、Namespace、Lifecycle 和 Policy Mapping。
- [ ] `F-03` Skills 发现、版本、Scope、Token Budget 和请求审计。
- [ ] `F-04` Owner-scoped LSP、Diagnostic、Definition/Reference/Symbol。
- [ ] `F-05` Ignore-aware 本地代码索引。
- [ ] `F-06` Typed Content Block、Blob Store、图片/文件 Provider Encoding。
- [ ] `F-07` Session Branch、Ancestry、Compaction Surface、导入/导出。

### Batch G：多 Agent、Workflow 与生产发布

- [ ] `G-01` Child Agent Activation、父子事件、Continuation 和有界并发。
- [ ] `G-02` Workflow DAG、Checkpoint、Idempotency、Manual Gate。
- [x] `G-03` Scheduler、Recurring、Missed-run Policy 和执行历史。`DONE-71` 已完成
  Session-owner `after/at/every`、Idle-only Agent Wake、固定相位周期、离线 latest-only catch-up、
  稳定 Delivery ID、持久 `schedule/change` 历史、重启恢复和 Web 实时投影。
- [ ] `G-04` Remote Platform/Workspace Sync/Capability Attestation。
- [ ] `G-05` Linux `.deb` 干净 VM 矩阵、AppArmor/bwrap 安装后探测。
- [ ] `G-06` macOS 签名、公证、安装、Web TLS 和真实 Provider Loop。
- [ ] `G-07` OpenTelemetry、TTFT/TPOT、Token/Cache/Tool 指标和配额。默认 Noop/显式 Full 的
  Secret-safe Debug Trace 已贯通 Host/Core/Provider/Tool/Process/PTY/Sandbox/Web/Server；聚合指标、
  Rotation/Retention、Diagnostic Bundle 和 OTel Adapter 尚未完成。
- [ ] `G-08` Fuzz、Fault Injection、Benchmark、SBOM、License、签名构件。

## 六、上游同步规则

1. `xharness-api::UPSTREAM_CONTRACT_REVISION` 始终指向已通过兼容测试的提交。
2. 检测到新 HEAD 只创建 Delta：新增、删除、字段变化、语义变化、测试变化。
3. Delta 必须逐项映射到稳定 TODO ID，禁止直接把上游代码合并到 Rust 仓库。
4. Web dist 升级前必须先通过旧版与新版双版本协议测试。
5. 上游内部重构若不改变可观察行为，标记为 `not-applicable`，不制造 Rust 复杂度。

## 七、完成后的产品形态

- 同一套 Rust 核心同时运行在 macOS 本地与 Linux 服务器。
- DeepSeek Harness Web 可以直接连接 Rust Host。
- CLI、Web、未来 ACP 共享同一个长期 Agent 和 Session 真源。
- Provider、工具、平台和存储均可替换，但 Loop 与 Web 协议不需要跟着重写。
- 崩溃恢复、权限、工具副作用和上下文预算都有可执行测试，而不是依赖提示词约定。
