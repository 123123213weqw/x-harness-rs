# XHarness 总任务清单

**基线日期：** 2026-08-22
**完成规则：** 只有实现、规范、测试和用户文档全部落地，任务才算完成。ID 永久稳定，
Commit、Issue、PR 应引用这些 ID。

全面复刻的里程碑、依赖关系、当前执行批次和上游同步规则见
[`FULL_REPLICATION.md`](FULL_REPLICATION.md)。本文件保存稳定任务 ID 和验收条件；
`FULL_REPLICATION.md` 是执行顺序和跨模块主控面板。

当前冻结兼容基线为 `deepseek-harness@141eb6fef8`。2026-08-21 已检测到远端 HEAD
`b150a551b8d4`，但在增量目录和兼容测试完成前不移动冻结基线。

## 已完成基础能力

- [x] `DONE-01` Provider-neutral 流式 Loop 与多 Step 工具执行。
- [x] `DONE-02` Chat Completions 和 Responses SSE Adapter。
- [x] `DONE-03` 运行时 Steering、Injection、Pause/Resume、Cancel、Approval。
- [x] `DONE-04` Append-only 强类型 Session Log 和内存 CAS Store。
- [x] `DONE-05` 跨进程加锁、可恢复崩溃尾部的 JSONL Store。
- [x] `DONE-06` 正式 Tool Registry、Schema 校验、Middleware 和 Policy。
- [x] `DONE-07` 直接 Argv Subprocess Runtime、有界输出与清理。
- [x] `DONE-08` Linux/macOS Workspace FS 与 Observation CAS。
- [x] `DONE-09` Linux Bubblewrap、macOS Seatbelt 和平台抽象。
- [x] `DONE-10` 按 Owner 隔离的持久 PTY Runtime。
- [x] `DONE-11` 匿名有界 Web Fetch 和可插拔 Search。
- [x] `DONE-12` 标准 14 个 Coding Tool。
- [x] `DONE-13` 真实 V100 Qwen 工具 Loop：模型 → 审批 → 写入 → 重放 → 最终回答。
- [x] `DONE-14` 每 Crate 规范和总路线图。
- [x] `DONE-15` Web 线协议第一阶段：52 RPC、四象限信封、Mux/Host Frame、HTTP、
  下行 WebSocket、`/api/respond`、Export/Static 路由骨架。
- [x] `DONE-16` Web Host 基线：52 RPC 全部有状态行为；真实 Loop Turn、14 个原生工具、
  审批响应、Mux/Host 事件投影、JSON Export 和 Loopback Server Binary 全部接通。
- [x] `DONE-17` Context 第一阶段抽象：独立 `xharness-context`、一次性 Surface、Edit 来源
  范围校验、Policy 版本与 Request Header 审计。
- [x] `DONE-18` Host 组合解耦：`xharness-host` 只保留 Provider/平台无关控制面，
  `xharness-host-app` 组合 OpenAI Adapter、Server、Platform、Terminal、Web 和原生工具；
  Host 可显式注入 ContextPolicy。
- [x] `DONE-19` Host Turn Runtime 解耦：定义 `AgentRuntime`、`AgentTurnRequest`、
  `RunningTurn` 和 `ModelRoute`，BasicHost 不再直接持有 Provider/ToolFactory/ContextPolicy 或
  创建 Loop；`LoopAgentRuntime` 作为当前兼容适配器。
- [x] `DONE-20` Apple Silicon 原生 CI：在 GitHub `macos-15` ARM64 Runner 上执行整个
  Workspace 的 Check、Test、Clippy，真实覆盖 FS Symlink Race、Process Group、PTY 和
  Seatbelt 隔离，并生成带 SHA-256 的 `xharness-host-darwin-arm64` 构件。
- [x] `DONE-21` Web Full access 权限预设：接通 `permissions` Projection、Schemastery
  Settings、`commands/list`/`commands/execute` 动态 Remote；前端一次风险确认后，Session 使用
  `danger-full-access + never`，原生工具获得系统范围文件/进程能力且不再逐工具审批；Full access
  已从 `SandboxMode` 移出，只绕过权限隔离，不绕过 `ProcessRuntime`。
- [x] `DONE-22` Web 重启基线工作区：Host 启动时把 canonical cwd 注册为
  `workspace-default`，避免内存状态重置后工作区选择器为空、Composer 看似无法点击。
- [x] `DONE-23` Web/Full access 发布回归：真实 Host 子进程原端口重启后恢复默认 Workspace
  和 WebSocket Carrier；Full access 验证 Workspace 外绝对路径读写、Loopback 网络、Timeout/
  Cancel 仍走受管 Process Group；真实 Chromium 覆盖风险确认取消/确认，并在 TCP 承载连续失败
  至少 8 次后重新拉取 Host、Workspace、Session、History、Settings 与权限投影。
- [x] `DONE-24` 冻结上游兼容 Catalog v2：机器可读记录 52 固定 RPC、26 动态 Typert RPC、
  Mux/Host Frame、转发事件、48 Session Event、Tool、四类 Prompt Component、Settings、
  Service Definition/Provision、Preset 和 Package；生成器对重复目录和无法解析的 Remote fail fast。
- [x] `DONE-25` 持久 Host 启动恢复第一阶段：`Store::list_headers` 可验证枚举 Memory/JSONL
  会话；Host 从强类型日志重建 Session、History、模型路由、Workspace 归属和 Durable Queue；
  恢复 Worker 必须先为每个稳定输入 ID 订阅，再显式 Wake，未领取输入续跑时不重复 Append；
  真实 Host 子进程在同一状态目录重启后仍能列出 Session 和 Assistant History。
- [x] `DONE-26` Prompt Admission 持久回执：`session.prompt` 与 `subagent.prompt` 在附件物化和
  Runtime 调用前，以 RPC ID + 规范化 Payload SHA-256 做会话内幂等判定；并发同 Payload 只
  Admission 一次，不同 Payload 复用 ID fail closed。回执从完整 `agent/inbox/spliced` 历史
  重建，成功响应丢失、消息已消费或 Host 重启后重试都不会重复插入输入。
- [x] `DONE-27` 七个持久切点的确定性恢复矩阵：Admission、Claim、Request Header、Tool Call、
  Tool Result、Step End、Turn End。已证明未闭合 Turn 变为 `Interrupted`、已落账 Tool Call 只产
  `OutcomeUnknown` 而不重放、权威 Tool Result/Completed Turn 保持不变、原输入只派生一次。
- [x] `DONE-28` 八点真实 SIGKILL 矩阵：独立子进程使用正式 JSONL Store，在 Admission、Claim、
  Request Header、Tool Call、Approval Asked、Tool Result、Step End、Turn End 写入 Ready Marker
  后由父进程发送 SIGKILL；随后在同一 State Dir 重启 Durable Host/Core。矩阵验证 Admission
  不丢不重、未审批 Tool 不执行、未知 Tool 不重放、Interrupted/OutcomeUnknown/权威终态符合规范。
- [x] `DONE-29` Web History 权威投影：Durable Runtime 暴露不可变 Session Cut，History 查询和
  Driver 按 Session Sequence 刷新同一纯投影；运行中与重启后的 Events/Projections 逐字相等，
  User 的结构化 Content、Source 与 Timezone 从 Inbox 元数据恢复。内存 Event DTO 不再是正式
  History 真源。
- [x] `DONE-30` Approval/Provider Retry 持久控制事件：新增强类型 `approval/asked`、
  `approval/decided`、`llm/retry`、`llm/retry-started` 及生命周期校验；审批使用独立 ID，Asked/
  Decided 在工具副作用前 Flush，Provider Retry 在下一次 I/O 前以稳定链 ID 落账；Web History
  从同一权威 Session 投影冻结字段。该里程碑把 48 个冻结事件的强类型覆盖推进到 16 个。
- [x] `DONE-31` Session 创建与权限命令持久化：Durable Runtime 提供 Turn 外强类型 Event CAS/
  Flush Seam；创建时持久化 Agent Preset、Permission Preset、Sandbox Mode 与 Approval Policy，
  `/permission` 的 Command Run、策略三元组和 Command Done 按顺序落账。Full access 的冻结线值修正
  为 `danger-full-access`，Host 重启从日志恢复权限而非退回默认。48 个冻结事件当前覆盖 22 个。
- [x] `DONE-32` Session Title 与 Agent Preset 持久化：`session.rename` 写入强类型、log-only、
  latest-wins 的 `session/title`；`agentPreset.select` 复用 `agent-preset/selected`。两者均经过
  Per-session Admission Fence 和 Flush Barrier 后才更新内存投影，重启从 Session Log 折叠恢复；
  运行中 Rename 被 Core 视为允许的外部控制事件。48 个冻结事件当前覆盖 23 个。
- [x] `DONE-33` Goal 全快照事件与恢复：6 个 Goal RPC 经 Per-session Admission Fence 写入
  `goal/change`；Create/Edit/Pause/Resume/Complete 使用 version 1 全快照，Clear 使用递增 Revision
  Tombstone。Session 校验 ID/Revision/Phase/时间和定义迁移，History/Projection 与重启从同一日志
  折叠，默认 `maxGoalRounds=256`。48 个冻结事件当前覆盖 24 个。
- [x] `DONE-34` Idle Plan Mode 持久化基线：动态 Command 目录暴露 `/plan`，空参数进入、`off`
  退出；成功选择以 `command/run → plan/mode → command/done` Flush 并投影 `{active,pending}`，
  重启从最后事件恢复。运行中 Pending Pre-step、附带 Message/Image Steering 和 `exit_plan_mode`
  仍归 `P0-14/P1-01`，当前 fail explicit 而非静默丢输入。48 个冻结事件覆盖 25 个。
- [x] `DONE-35` 真实最小 Coding System Prompt：新增 `xharness-prompt` 确定性有序组装器，
  将选中 Preset、权限、Workspace、Coding 工作流和 Plan Policy 组装为每轮第一个 System
  Message；Request Header 保存 Assembler/Assembly/Section/System Hash 与 Tool Definition Hash，
  Transcript 不保存 System。Chat Completions、Responses、Host Provider 边界和重启 Pending Turn
  均有测试；Cancel 在 Turn 已结束时改为幂等，避免控制终态竞态。
- [x] `DONE-36` 请求前上下文硬预算：新增 Provider-neutral `xharness-token` 与可替换
  `TokenMeter`，生产 Host 配置模型时强制显式声明 Context Window；Core 在 Context Surface
  完成后、Provider I/O 前计量 System/消息/工具/协议开销并预留输出与安全余量，预算报告写入
  Request Header。Chat/Responses 分别下发 `max_tokens`/`max_output_tokens`；固定
  `64196 > 53248` 回归验证 Provider Attempt 为零。当前保守 UTF-8/JSON Byte Meter 保证宁可
  过估，不把精确 Tokenizer 绑定到 llama.cpp；精确 Adapter 与自动压缩仍归 `P1-03`。
- [x] `DONE-37` 模型 `read` 分页：默认页从 256 KiB/2,000 行降为 32 KiB/400 行，暴露
  `offset`、`start_line`、`limit`、`line_limit` 与 Opaque `next_cursor`。Cursor 固定原页限制并
  绑定完整文件 SHA-256，文件变化后继续读取 fail stale；底层仍完整计算 Version 并保持
  Observation CAS。测试覆盖 Line 起点、连续 Cursor、UTF-8 边界、Cursor Roundtrip、版本变化
  和模型工具真实两页读取。
- [x] `DONE-38` 确定性 Tool Result Head/Tail Reduce：超过单结果模型预算时优先生成
  `head_tail/v1` JSON Envelope，保留 UTF-8 安全头尾、原始 Byte 数、遗漏 Byte 数和 SHA-256；
  相同输入逐字稳定，极小预算继续使用合法 JSON 前缀后备。原始 `ToolResult` 仍通过运行事件交给
  宿主，但持久内容寻址 Spill/Reference 与历史 Surface Replace 尚未实现。
- [x] `DONE-39` 原生平台 Readiness 与模型工具动态投影：`NativePlatform` 对同一 Workspace/
  Permission 组合只 Probe 一次并缓存强类型 `CapabilityReport`；Host 在每次模型 Step 前根据
  Sandbox、Search Provider 与现存 Terminal 状态裁剪工具。受限进程不可用时移除
  `bash/glob/grep/terminal_open`，未配置 Search 时移除 `web_search`；Full access 明确报告
  `none-full-access`，不会为探测偷偷创建 Sandbox。确定性测试覆盖不可用能力的模型可见子集。
- [x] `DONE-40` Tool 双重身份与 Provider Replay：每个调用分别持久化全 Session 唯一的
  Harness `execution_id` 与 Provider 原生 `provider_call_id`；Journal、Approval、Tool Result 和
  Web 审计继续使用前者，Chat/Responses 的 Assistant Tool Call 与 Tool Output 统一使用后者。
  旧日志缺少原生 ID 时确定性回退到 Execution ID，Responses Opaque Item 与
  `function_call_output.call_id` 不再错配。
- [x] `DONE-41` 有界 Loop Event Journal：删除无界 MPSC，改为按事件数和序列化 Byte 双预算的
  非阻塞 Ring Journal。慢消费者收到强类型 `events_lagged { missed, resume_seq }`，可通过
  `subscribe_events_from(resume_seq)` 从最早保留事件继续；完全不消费事件不会阻塞 `result()`，
  单个超大事件也会被逐出而不是突破内存预算。Drop、Cancel 和工具清理竞态保持确定终态。
- [x] `DONE-42` Pending Approval 跨重启续跑：Session 纯投影区分“尚未越过审批边界”和
  “工具结果未知”；Core 在原 Turn/Step 上重发相同 Approval ID，只有再次收到 Allowed-once 才
  执行，拒绝则写回 Tool Error。Agent 在 Host 订阅后显式唤醒恢复 Turn，Web 重新生成可回答的
  `approval/requested` RPC；Provider 只从下一 Step 继续，既不伪造新 User Turn，也不把未批准
  Tool 写成 `outcome_unknown`。测试覆盖 Core、Agent/Host 和 Provider Native Call ID 重放。
- [x] `DONE-43` 持久 Web History 游标与有界尾缓存：Durable `session.history` 不再从
  `SessionRecord.events` 切片，而是按 `beforeSeq + maxMessages` 直接查询并纯投影权威 Session
  Log；Host 仅保留按 Event 数和序列化 Byte 双预算约束的连续尾部，Sequence 不因驱逐重编号。
  Session Search 与 Fork 同样读取权威日志。测试覆盖尾缓存已驱逐 37/42 个事件后仍能取回完整
  42 个事件、跨页 Cursor 严格递减，以及 Host 重启前后等价。
- [x] `DONE-44` Host Control Log 与首批通用 Mutation Receipt：新增 `xharness-control`，以
  Append-only Event、CAS Revision、跨进程锁和 JSONL Crash-tail 恢复持久化 Workspace
  定义/标题/排序/Session 排序/归档以及 Settings 文档。Workspace 6 个变更 RPC 与 Settings 3 个
  变更 RPC 把状态事件和 `{rpcId, method, fingerprint, response}` 在同一 Revision 落账并 Flush；
  同 ID/同 Payload 跨并发和重启逐字重放原响应，不同 Payload fail closed。日志递归拒绝非空
  Password/Token/Secret/API Key 字段，真实 Host 子进程重启验证自定义 Workspace、Settings 和回执。
- [x] `DONE-45` Session 级原子 Mutation Receipt：新增内部、log-only 的
  `xharness/mutation-committed`，状态事件与 `{rpcId, method, fingerprint, response}` 在同一
  Session CAS Revision 落账并 Flush。`session.rename`、`session.selectModel`、
  `agentPreset.select` 和 6 个 Goal RPC 共 9 个变更接口支持同 ID/同 Payload 跨重启逐字重放，
  ID 冲突 fail closed；模型选择以 `session/model-selected` latest-wins 事件恢复，不再依赖最近一次
  Request Header。Web History 只投影隐藏的回执占位，不暴露 Fingerprint 或 Response Body。
- [x] `DONE-46` Durable Inbox 权威 Web Queue：`session/queue` 不再读取 Host Driver FIFO，而是从
  Session Log 的完整 `agent/inbox/spliced` 历史折叠 `next-turn + next-step`。三种 Placement 固定为
  `queued/steering/context`，每次 Insert/Edit/Remove/Claim 后发送完整快照；Mux 重连为所有 Session
  发送 subscribed/projection，并为非空 Inbox 发送 Queue Baseline。`session.updateQueue` 先修改
  Durable Inbox，Claim 竞态返回 `queue-item-not-found`，非文本 Edit 返回冻结 Attachment Error；
  Host FIFO 只保留 RunningTurn Attachment，不再是真源。
- [x] `DONE-47` Tool Execution ID 跨层贯通：Core 在 Tool Call 落账后把同一个 Durable
  `execution_id` 通过 `ToolInvocation` 交给兼容桥；`xharness-coding-tools` 将其显式绑定到
  `xharness-tools::ToolRequest`，因此 Registry、Middleware、Approval、Handler、Observer 和 Result
  不再另造进程内身份。Provider 原生 `provider_call_id` 仍只用于线协议重放。已覆盖非法外部 ID、
  Executor 原样传播以及 Journal → Core Handler 的一致性回归；Core 重复 Scheduling/Approval
  的删除仍属于 `P0-03` 下一阶段。
- [x] `DONE-48` 正式 Tool Batch Scheduler 与副作用边界：`xharness-tools` 新增 Model-order
  Batch Runtime，统一执行全局并发上限、Parallel、Keyed FIFO 与 Exclusive Barrier；完成事件按
  真实完成顺序输出，最终 Result 按原始调用顺序重排。新增 `ToolLifecycle::started`，只有 Policy、
  Approval、Concurrency Admission 和宿主 Durable Start Acknowledge 全部成功后 Handler 才能产生
  副作用；Lifecycle Error/Panic 均 fail closed。Batch Drop/Cancel 会广播到全部 Call Token，调用方
  可继续等待 Result 收敛。该 Runtime 已具备接管 Core Scheduler 的独立契约，Core 接线与旧实现
  删除继续属于 `P0-03`。
- [x] `DONE-49` 正式 Tool Runtime 接管生产 Host：`LoopRequest` 新增互斥的
  `tool_executor` 边界，模型 Tool Definition、Context/Token Budget、Request Header、Fresh Batch 与
  Pending Approval Recovery 均读取同一个 Registry/Executor。Core 通过 Channel Bridge 把 Web
  Command 转为正式 Approval Provider，并在 `ToolLifecycle::started` Ack 前发布 Tool Started；
  Completion 真实顺序投影、Result 模型顺序落账。`SessionToolFactory` 现在返回 Executor，原生 14
  工具、Full Access 裁剪和 Durable Host 默认全部走新路径；`core_specs()`、自动批准适配器及
  Coding Tools 对 Core 的生产依赖已删除。旧 `LoopRequest.tools` 仅为尚未迁移的 Embedder/Test
  保留，不能和新 Executor 同时配置。
- [x] `DONE-50` 正式 Tool Runtime 回归矩阵：Core 的恢复审批、并行审批、拒绝、重复 Provider
  Call ID、取消和 Crash Cut 已迁移到 `ToolExecutor` 路径；补齐 Registry Definition 投影、未知
  工具、坏 JSON、Schema Error、空 Batch、重复 Order、零并发和 Cooperative Quiescence 测试。
  测试发现并修复了 Core Bridge 串行等待单个审批导致第二个并行审批永远无法投影的问题；现在
  多个 Approval 先全部发布，再按 Execution ID 独立决议。取消会关闭所有已落账 Approval，并在
  返回 Run Result 前等待正式 Batch 收敛；等待 Lifecycle Ack 时取消也不会启动 Handler。

## P0 — 可日常使用的本地 Coding Agent



- [ ] `P0-02` **持久长生命周期 Agent 层。** 新增 `xharness-agent`：Agent、Turn、Step、
  Durable Inbox Message ID、Claim/Ack、Next-turn/Next-step 语义、Single-writer Session
  Lease 和重启续跑。
  Host-facing `AgentRuntime -> RunningTurn` 替换边界已经完成，本项实现持久 Runtime 并替换
  `LoopAgentRuntime`。
  已完成：`agent/inbox/spliced` 事件、Next-turn/Next-step Replay、稳定 Message ID、原子 Claim
  Prelude、进程内 Registry、Memory/File Lease、AgentSupervisor、多 Turn Driver、Idle Inject、
  Active Turn 持久 Steering 和消费恢复去重。`xharness-host-app` 已默认组合
  `DurableLoopAgentRuntime + JSONL Store + File Lease`，连续 Turn 的模型历史来自持久日志；
  `session.prompt` 使用 RPC ID 作为稳定输入 ID，先完成 Durable Inbox Flush 才返回成功，
  Queue Edit/Remove 同步写入 Inbox，多条预准入消息用 `TurnStarted.input_ids` 绑定各自缓冲事件流。
  `Store::list_headers`、Host 启动 Replay、Workspace/Session/History/Queue 重建和 Pending Turn
  显式 Wake 已完成；History 已按 Cursor 直接查询权威日志，Host Event Projection 只保留有界
  尾部。Web Queue 已从完整 Durable Inbox 折叠两条列表并在重连发送 Baseline；Host 内存 FIFO
  只承担 Driver Attachment。Workspace 自定义元数据、排序、归档与 Settings 已进入独立 Host Control Log，相关
  9 个变更 RPC 使用通用 Exactly-once Receipt。Session Log 内的 Rename、Model Select、Preset
  Select 和 6 个 Goal RPC 也已使用同 Revision 原子 Receipt。剩余：将同一 Receipt 框架扩展到
  Session Create/Fork、Queue/Cancel/Attachment、Preset
  Copy/Remove 等变更 RPC，并实现 Secret-free Credential Reference Store；
  七点通用日志前缀和包含 Approval Asked 的八点真实子进程 SIGKILL/同目录重启矩阵均已完成。
  Approval Asked/Decided、Provider Retry/Started、Agent/Permission/Sandbox/Approval Policy 与
  Permission Command Receipt 已进入强类型 Session Log 和确定性 Web History；Pending Approval
  已能在重启后按原 Approval/Execution ID 重新投影并继续回答。剩余完整 48 Event 词汇继续归本项
  与 `P2-01`。
  **验收：** 输入被接受后到下次 Request 之间崩溃不能丢输入，也不能重复 Tool Side Effect。

- [ ] `P0-03` **端到端统一使用 `xharness-tools`。** 从 Core 删除重复的 Scheduling/Approval，
  淘汰兼容 `xharness-core::ToolSpec`。同一个 Execution ID 必须贯穿 Journal、Approval、
  Middleware、Event 和 Result。
  已完成：Durable Execution ID 已贯穿 Journal、Core Event/Approval、`ToolInvocation`、
  `xharness-tools` Middleware/Approval/Handler/Observer 与 Result；未提供 ID 的独立 Executor 调用仍
  安全生成进程内唯一 ID。`ToolExecutor` 已独占生产路径的 Batch Scheduling、Schema、Approval、
  Timeout/Panic/Cancel，`ToolBatchRun`、副作用前 Lifecycle Ack、Core Command/Journal Bridge 和
  `core_specs()` 删除均已完成。剩余是迁移 Core 自身的旧兼容测试/外部 Embedder，随后删除
  `LoopRequest.tools`、`xharness-core::ToolSpec`、`ScheduledTool` 和旧 Approval/Scheduler 分支。

- [x] `P0-04` **Provider Call ID 映射。** `ToolCall` 已分别保存内部 Execution ID 和
  Provider Native Call ID。Responses Opaque Item Replay、无 Opaque Responses 和 Chat 均保证
  Tool Output ID 与 Assistant Call 匹配；审计事件继续使用稳定 Namespaced ID。测试覆盖跨 Step
  复用 Provider ID、旧日志回退、Session 重放和两种真实请求体编码。

- [x] `P0-05` **有界事件投递。** Loop 已使用逻辑 Append-only、物理有界的 Event Ring
  Journal，按事件数与序列化 Byte 双预算驱逐；Subscription 提供明确 Lag/Resume Cursor。
  忽略事件的 Host 不会积累无界 Channel，也不会阻塞 `result()`。WebSocket 跨连接 Cursor
  继续由 `P2-02` 完成，不再由 Core 临时流承担。

- [ ] `P0-06` **结构化 Shutdown 和 Quiescence。** 用 Scope 管理 Provider/Tool/Process
  Task；Cancel 必须 Signal 并 Join。定义超过有界 Grace 后的 Forced-cleanup 终态。
  **测试：** Runtime Shutdown、Handler Abort、Descendant、受限工具 Result 不能早于进程死亡。

- [ ] `P0-07` **macOS 原生运行验证。** 在真实 Apple Silicon Mac 上运行 FS Race、Seatbelt、
  PTY Lifecycle、Web TLS、Live Loop，并打包/签名 CLI。仅 Cross Compilation 不算完成。
  ARM64 原生 CI、FS/Process/PTY/Seatbelt 测试和未签名 Host 构件已经完成；剩余 Web TLS、
  真实 Provider Live Loop、开发者签名、公证和本机安装/启动验证。

- [ ] `P0-08` **Web DNS Rebinding 加固。** 每个连接绑定到已验证 Resolve Address，同时
  保留 TLS Host/SNI；Redirect 重新应用 Policy。测试 Rebinding、IPv4-mapped IPv6 和
  Reserved Range。

- [ ] `P0-09` **配置与凭据边界。** 强类型配置文件、环境覆盖、Provider/Search Secret
  Reference、Redacted Debug、Event Log 禁止 Secret、文件权限校验。不做 Plugin/HMR Loader。
  候选上游 `b150a551b8d4` 新增 Authorization Seam；本项同时建立 Credential Store，然后新增
  one-in-flight-per-key Authorization Flow/Interaction、Cancel/Settlement 和 Web Prompt/Notice
  Projection。Authorization 不得进入模型 Prompt，Secret Prompt 不得进入任何日志。

- [ ] `P0-10` **真实协议矩阵。** 针对支持端点运行 Chat/Responses 真实 Tool Loop，覆盖
  Reasoning、多并行 Call、Tool Failure、Cancel、Usage、Long Context。保存不含 Secret 的
  可复现 Fixture。

- [x] `P0-11` **请求前上下文硬预算。** 在 Provider I/O 前计量 System、消息、全部工具
  Schema、协议模板和输出预留；窗口未知或预算超限时结构化失败。加入 2026-08-21 的
  `64196 > 53248` 固定回归，断言超限时 Provider Attempt 为零。`xharness-token` 已提供统一
  `TokenMeter`、保守 Byte Meter、强类型 Budget/Report/Error；正式 Host 配置模型时缺少窗口会
  拒绝启动。每次成功预算的分项进入 Request Header，输出上限进入两种 OpenAI 线协议。

- [ ] `P0-12` **大结果治理与分页 Read。** `read` 增加 Byte/Line Range 和下一页 Cursor，
  默认降到适合模型的小页；工具原始输出落日志/Spill，模型 Surface 只保留确定性的
  Head/Relevant/Tail、元数据和引用。不得破坏 Observation CAS。
  已完成：模型 Schema 的 Byte/Line 起点、页大小/行数和版本绑定 Cursor；默认 32 KiB/400 行，
  Cursor 延续原限制且文件变化后拒绝拼接；单结果超限使用带 Hash/Byte 统计的确定性 Head/Tail
  Envelope。剩余：原始大输出持久 Spill/Reference、Relevant 片段选择和历史 Surface Replace。

- [ ] `P0-13` **Platform Readiness 与动态工具投影。** 模型请求侧已完成：Host 缓存
  Sandbox/Search/PTY Readiness，并在每个 Step 只发送实际可用工具；已确认失败的 Sandbox 不会
  被每轮重复 Probe。剩余：把同一报告接入 Web UI 的 Workspace Readiness 投影，并补
  WZU_4080 `RTM_NEWADDR` Bubblewrap 失败的固定诊断夹具与浏览器提示回归。

- [x] `P0-14` **真实 Coding System Prompt 注入。** 把选中的 `AgentPreset.content` 通过有
  版本的最小 Prompt Assembler 变成 `Role::System`，明确分页读取、不可用工具不重试、证据
  足够即回答和审批规则。测试必须解析 Provider 请求体，而不是只检查 Host 内存。
  已实现 `xharness-prompt/v1`：Preset/Permission/Workspace/Workflow/Plan 的顺序固定，动态内容
  以 SHA-256 版本化；Core 在 Context Policy 前注入并在 Request Header 记录审计元数据，
  Provider 两种线协议与 Host 实际请求均验证。完整可注册 Scope/Variable/Provider Section 仍归
  `P1-01`，Token Guard 仍归 `P0-11/P1-03`。

- [ ] `P0-15` **Linux `.deb` 自动沙箱配置。** 依赖声明、AppArmor 检测、官方
  `bwrap-userns-restrict` 安装/升级/保留管理员文件、语法校验、四项真实隔离 Probe、状态 Hash、
  远程打包和卸载已实现。剩余：在干净 Ubuntu 24.04 VM 完成 dpkg 矩阵，并在 WZU_4080 输入
  管理员授权真实安装后，重启 Host 验证 Coding Tool。

## P1 — Coding 质量与上下文效率

- [ ] `P1-01` **Prompt Registry。** 有序 System Section、Workspace Context、Tool Guidance、
  Variable、Provider-specific Section、确定性 Request Header Capture 和 Prompt Version ID。
  `P0-14` 只交付最小可用注入，本项完成完整注册、Scope 与组合能力。

- [ ] `P1-02` **LLM/Provider Registry。** 按 Provider/Model/Purpose 路由，把 Prepared Call
  绑定到一个注册 Adapter，暴露 Reasoning/Max-token 控制，并在不猜协议的情况下发现模型能力。

- [ ] `P1-03` **Token Meter 与 Context Policy。** Provider-aware Token Estimate、最大输入
  Guard、确定性 Tool Output Reduce、Surface Replace，以及不修改原 Event Log 的可选 Summary。
  `P0-11/P0-12` 先封死超窗，本项补 Provider-aware 精确计量、摘要和长期压缩策略。

- [ ] `P1-04` **动态 Tool Projection。** 每个 Profile/Step 只发送相关工具，同时保持 Schema
  稳定。与始终发送 14 工具比较 Token/Cache 消耗和工具选择质量。

- [ ] `P1-05` **更完整的 Tool Description。** 增加何时用、何时不用、前置条件、输出语义、
  `bash` 与 Terminal 选择指导；使用固定工具选择数据集评估。

- [ ] `P1-06` **扩展 FS Tool。** 增加目录创建/列表、安全 Delete/Move/Copy、Binary/Image
  Read、Unified Diff/Patch、按行读取和显式 Spill Reference；继续保持 Observation CAS 和审批。

- [ ] `P1-07` **后台 Job。** One-shot Bash `run_in_background`、Owner-scoped Job Registry、
  Status/Read/Cancel、有界 Spill、重启后 Outcome 语义和 Process-tree 清理。

- [ ] `P1-08` **补全 Terminal 协议。** Resize、OSC 133 Prompt Marker、Foreground-pgid/
  Read-state Observation、Active-send 互斥，以及明确 Settle Reason：`stdin_read`、
  `inferred_idle`、`timeout`、`session_exit`。

- [ ] `P1-09` **多模态 Message 与 Attachment。** 强类型 Text/Image/File Block、内容寻址
  Blob Store、Image Metadata/Budget、Provider Encoding，用持久 Reference 替代内联大数据。

- [ ] `P1-10` **Web 质量。** 更多 Search Provider、稳定 Source/Citation Object、内容去重、
  更好的正文提取、Cache，以及作为独立高信任 Capability 的可选登录态 Browser。

- [ ] `P1-11` **Session Branch 与 Projection。** 从 Revision Fork、不可变 Ancestry、命名
  Branch、Inspect/Query API、Compaction Surface Event、确定性 Transcript Export/Import。

- [ ] `P1-12` **资源 Policy。** CPU/Memory/File/Process/Output Quota、Per-tool Policy、
  条件允许时接 Linux cgroup v2，并让 Quota Failure 可观测。

## P2 — Host、API 与 UI

- [ ] `P2-01` **持久 Agent-backed Web API。** Carrier、52 方法目录、内存 CRUD、Start/
  Steer/Cancel/Approve、History Projection、Optional Capability Response 和 Export Body 已完成。
  正式 Host 的 Prompt Admission、模型历史和 Agent Driver 已使用持久 Session/Inbox Store；
  下一步把 Workspace/Session/Queue/History Projection、Approval 和枚举索引从 `BasicHost`
  内存迁出，并增加 Health/Readiness，同时保持冻结的线协议。

- [ ] `P2-02` **流式传输增强。** 提供带 Cursor Resume、Lag Detection、Reconnect 和
  Per-session Multiplexing 的 WebSocket/SSE 下行事件流。

- [ ] `P2-03` **Web UI 完整投影。** 继续把 DeepSeek Harness UI 作为 Client Projection：
  Session、流式 Reasoning/Text、Tool Card、Approval、Terminal、File、Web Source、Usage、
  Recovery State。

- [ ] `P2-04` **Host 认证与授权。** 默认仅本地；远程使用 Bearer/Session Auth、Workspace/
  Owner 隔离、CSRF/Origin Policy、Audit Log 和显式 Network Exposure。

- [ ] `P2-05` **可观测性。** 结构化 Tracing、Per-step Latency/TTFT/TPOT、Tool Duration、
  Retry/Cancel Reason、Token/Cache Accounting、OpenTelemetry 接口和 Secret-safe Diagnostic Bundle。

- [ ] `P2-06` **Settings 与 Profile。** Versioned YAML/TOML Profile、有序 Patch Layer、
  Validation/Dump、Migration，以及 Model/Tool/Policy Preset。

## P2 — 生态能力

- [ ] `P2-07` **MCP Client。** Stdio/HTTP Transport、Lifecycle、Capability/Schema Import、
  Cancellation、Approval/Policy Mapping、Namespace 和 Credential Isolation。

- [ ] `P2-08` **Skills。** 发现/加载有版本的 Instruction Package，显式 Scope 和 Token
  Budget；在 Request Header 中记录选中的 Skill Version。

- [ ] `P2-09` **LSP 集成。** Owner-scoped Language Server、Diagnostic、Definition/
  Reference/Symbol Tool、Restart/Backoff、有界输出和 Workspace Policy。

- [ ] `P2-10` **Git 工具。** 安全直接 Argv 的 Status/Diff/Log、Mutation Approval、
  Worktree Awareness，并禁止隐式 Push/转发 Credential。

- [ ] `P2-11` **本地代码索引。** Ignore-aware 增量 Search/Index 和确定性 Reference；必须
  与公共 Web Search 分开。

## P3 — 多 Agent 与 Workflow

- [ ] `P3-01` **Subagent。** 命名 Child Activation、独立 Tool/Provider/Profile Scope、
  Parent-child Event Link、独立 Cancel、Continuation 和有界并发。必须建立在持久 Agent/
  Inbox 上，不能直接塞进 `LoopRun`。

- [ ] `P3-02` **Workflow Graph。** 强类型 Sequential/Parallel/Join/Condition Node、
  Checkpointed Execution、Idempotency Key、Replay Inspection 和 Manual Gate。

- [ ] `P3-03` **Scheduler/Automation。** 持久 Timer、Wakeup、Recurring Job、Missed-run
  Policy、Owner Permission 和可观测执行历史。

- [ ] `P3-04` **远程执行。** 显式 Remote Platform Interface、Workspace Sync/内容寻址、
  Policy/Capability Attestation；受限远端不可意外回退为本地 Full Access。

## 持续发布门禁

- [x] `REL-01` 每次变更在 Linux 对整个 Workspace 执行 Fmt、`check --all-targets`、Test、
  Clippy `-D warnings`。
- [x] `REL-02` macOS 原生 CI，覆盖 Sandbox/PTY/FS 集成测试。
- [ ] `REL-03` SSE、JSONL Crash Tail、Event Lifecycle、Tool-call Assembly、Path Resolve、
  Schema Input 的 Property/Fuzz Test。
- [ ] `REL-04` 每个 Durability Barrier 和 Tool Side-effect Boundary 的 Fault Injection。
- [ ] `REL-05` TTFT Overhead、Event Throughput、JSONL Growth、Tool Scheduling、Long Context、
  PTY Scrollback、Web Extraction Benchmark。Long Context 必须报告 System/Message/Tool/Template/
  Output Reserve 分项，并包含多个并行大文件结果导致单 Step 暴涨的用例。
- [ ] `REL-06` Semver/API Audit：Non-exhaustive Extensible Type、Builder、Deprecation Window、
  Changelog、Reproducible Lockfile、SBOM、License、Signed Artifact。
- [ ] `REL-07` Security Regression：Symlink Race、Sandbox Escape、Process Descendant、SSRF/
  Rebinding、Credential Leak、Approval Fail-open、Log Corruption、Cross-owner Access。
