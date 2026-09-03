# XHarness 总任务清单

**状态日期：** 2026-09-02
**完成规则：** 只有实现、规范、测试和用户文档全部落地，任务才算完成。ID 永久稳定，
Commit、Issue、PR 应引用这些 ID。

全面复刻的里程碑、依赖关系、当前执行批次和上游同步规则见
[`FULL_REPLICATION.md`](FULL_REPLICATION.md)。本文件保存稳定任务 ID 和验收条件；
`FULL_REPLICATION.md` 是执行顺序和跨模块主控面板。

当前冻结兼容基线为 `deepseek-harness@141eb6fef8`。2026-08-21 已检测到远端 HEAD
`b150a551b8d4`，但在增量目录和兼容测试完成前不移动冻结基线。

## 当前状态快照

当前正式 `xharness-host-app` 已具备可日常使用的本地 Coding Agent 主链路：Web RPC、
`DurableLoopAgentRuntime`、双层 Durable Inbox、JSONL Session、File Lease、Prompt/Token Guard、
OpenAI-compatible Chat/Responses、多 Provider/Model 路由、正式 Tool Runtime、动态投影的 11 个
Coding/Job/Web Tool、Linux/macOS/Windows 原生平台、审批恢复、权威 History/Queue 和全链路 Debug Trace。

当前共有 `DONE-01`—`DONE-73` 七十三个完成里程碑。最近一批已经关闭输入在 TTFT 前不可见、
Web 对话重启恢复、模型性能指标投影、长思考输出预算、大 Session 热路径、逐模型推理强度、
Context 占用圆环、Harness 构造视图、Web Fetch 大结果直接挤爆 Context 的回归，以及后台 Job
第一阶段、持久 Schedule、会话权限/推理强度刷新保持和历史 Assistant 请求侧投影。

以下能力已经完成主体，不应再描述成“尚未接入”：

- 长生命周期 Agent 已接管正式 Host；输入先 Flush 再确认，Claim 与 `turn/start + user/message`
  原子提交，Pending Turn/Approval 可以在重启后续跑。
- 正式生产 Tool 路径已经由 `xharness-tools::ToolExecutor` 接管；Core 旧类型只剩 Embedder/Test
  兼容删除工作。
- Provider 原生输入 Token 计数端点已经接入；端点不支持时才回退到保守 Meter。
- 自动 Context Compaction 已接入正式 Durable Host：80% Pressure、请求前 Hard Overflow 和
  Provider 无 Delta 的 400 Context Overflow 都会进入有界压缩恢复；成功后重新构造并计量请求，
  Session/Web 使用不删除原 Event Log 的 Surface Replace。
- `web_fetch` 已使用 8,000 字符的确定性 Reader 摘要；历史或当前批次遗留的大 Tool Result 会先
  经过 8,192 字符的请求侧 Pruner，再进入 Compact 与 Token Guard。原始 Session Event 不丢失。
- Platform/Search Readiness 已裁剪每个模型 Step 的工具定义；尚缺 Web Readiness 投影。
- 正式 Host 已实现结构化 Shutdown：关闭 Admission，Signal/Join Agent、Loop、Tool、Job
  和 Process；超时清理会显式报告 Forced Cleanup。
- macOS ARM64 已在原生 GitHub Runner 运行 Workspace、FS、Process、PTY、Seatbelt 测试并生成
  未签名构件；剩余是 Live Provider、签名、公证和安装验证。
- 当前 XHarness Web 源插件、品牌覆盖、重建脚本和可直接部署的静态 Bundle 已与 Rust 后端收敛到
  同一仓库的 `ui/`；Fresh Clone 不再依赖本机相邻的旧 `x-harness` 工作树才能启动网页。

当前最短阻塞链调整为：**大结果持久 Spill/Reference 与 Pruner Replace → 删除 Core 旧 Tool
兼容层 → Credential Reference/配置 → 远程 Web Auth → WebSocket Cursor Resume →
macOS 签名/公证与发布验证**。手动 `/compact`、独立摘要 Purpose 路由和精确 Tokenizer 作为
Context P1 后续并行推进；MCP、Skills、LSP、Subagent 和 Workflow 不阻塞本地单用户 Coding Agent。

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
- [x] `DONE-12` 标准 11 个 Coding/Job/Web Tool；旧六个 Terminal Tool 已退出默认模型面。
- [x] `DONE-13` 真实 V100 Qwen 工具 Loop：模型 → 审批 → 写入 → 重放 → 最终回答。
- [x] `DONE-14` 每 Crate 规范和总路线图。
- [x] `DONE-15` Web 线协议第一阶段：52 RPC、四象限信封、Mux/Host Frame、HTTP、
  下行 WebSocket、`/api/respond`、Export/Static 路由骨架。
- [x] `DONE-16` Web Host 基线：52 RPC 全部有状态行为；真实 Loop Turn、原生工具、
  审批响应、Mux/Host 事件投影、JSON Export 和 Loopback Server Binary 全部接通。
- [x] `DONE-17` Context 第一阶段抽象：独立 `xharness-context`、一次性 Surface、Edit 来源
  范围校验、Policy 版本与 Request Header 审计。
- [x] `DONE-18` Host 组合解耦：`xharness-host` 只保留 Provider/平台无关控制面，
  `xharness-host-app` 组合 OpenAI Adapter、Server、Platform、Job、Web 和原生工具；
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
  仍归 `P0-14/P1-01`，当前 fail explicit 而非静默丢输入；加上 `DONE-57` 的四个 Compaction
  事件和 `DONE-66` 的 `request/context` 后，48 个冻结事件当前强类型覆盖 30 个。
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
  过估，不把精确 Tokenizer 绑定到 llama.cpp；自动 Pressure/Overflow 已在 `P1-03` 接线，请求侧
  通用 Pruner 已由 `DONE-68` 接入。精确 Adapter、手动 Compact 与持久 Pruner Replace 仍归该项。
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
  Sandbox 与 Search Provider 状态裁剪工具。受限进程不可用时移除 `bash/glob/grep`，仍保留
  Job 控制器收敛历史任务；未配置 Search 时移除 `web_search`；Full access 明确报告
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
  Completion 真实顺序投影、Result 模型顺序落账。`SessionToolFactory` 现在返回 Executor，原生
  Tool Bundle、Full Access 裁剪和 Durable Host 默认全部走新路径；`core_specs()`、自动批准适配器及
  Coding Tools 对 Core 的生产依赖已删除。旧 `LoopRequest.tools` 仅为尚未迁移的 Embedder/Test
  保留，不能和新 Executor 同时配置。
- [x] `DONE-50` 正式 Tool Runtime 回归矩阵：Core 的恢复审批、并行审批、拒绝、重复 Provider
  Call ID、取消和 Crash Cut 已迁移到 `ToolExecutor` 路径；补齐 Registry Definition 投影、未知
  工具、坏 JSON、Schema Error、空 Batch、重复 Order、零并发和 Cooperative Quiescence 测试。
  测试发现并修复了 Core Bridge 串行等待单个审批导致第二个并行审批永远无法投影的问题；现在
  多个 Approval 先全部发布，再按 Execution ID 独立决议。取消会关闭所有已落账 Approval，并在
  返回 Run Result 前等待正式 Batch 收敛；等待 Lifecycle Ack 时取消也不会启动 Handler。
- [x] `DONE-51` 多 Provider/Model Registry 基线：一个 Durable Runtime 可注册多条公共路由，
  Web 暴露模型目录并在选择/启动前 fail closed；每条路由独立绑定 Adapter 与 Token Guard。
- [x] `DONE-52` Provider 原生输入 Token 计数：Chat 使用 `/chat/completions/input_tokens`，
  Responses 使用 `/responses/input_tokens`；按最终结构化请求计数，404/405/501 能力缺失会缓存并
  回退保守 Meter，其他错误不静默降级。
- [x] `DONE-53` Durable 流式检查点：Assistant Text/Reasoning/Tool-call Chunk 在 Session 中按
  最多 64 个事件或 250ms 批量落账，Host 从权威序列刷新投影，在不逐 Token `fsync` 的前提下保持
  Provider 流式节奏和崩溃可恢复性。
- [x] `DONE-54` Bash Pipeline 失败传播：One-shot Bash 默认启用 `pipefail`，`git push ... |
  tail` 等管线不再以最后一个过滤命令的零退出码掩盖前序失败，并有真实工具回归。
- [x] `DONE-55` Provider-neutral Compaction 规划器：默认阈值/保留比例、Pressure/Overflow/Manual
  规划、Tool Call/Result 安全切点、Unicode Tool Result Pruner、Checkpoint Frame 和 Summary Trait
  已完成；生产自动接线由 `DONE-57` 关闭。
- [x] `DONE-56` Full Debug Trace 全链路接线：默认 Noop 零 I/O；Full 模式以全局 Sequence、
  Secret Redaction、有界 Blob 和显式 Flush 记录 Host/Core/Provider/Tool/Process/PTY/Sandbox/Web/
  Server，跨层测试已覆盖同一 Scope 关联。
- [x] `DONE-57` Durable 自动 Context Compaction：正式 Host 默认安装
  `CompactionConfig::default()`；Core 在 80% Pressure、请求前 Hard Overflow 和 Provider 无 Delta 的
  400 Context Overflow 三个入口执行有界恢复。Session 强类型记录 `compaction/start|summary|end|prune`
  与 Checkpoint `surfaceReplace`，成功批次原子替换模型 Surface 而不删除源 Event；失败/中断写错误
  End，重启闭合悬空 Start。每次成功 Replace 后重新组装、原生计数并走 Token Guard；Web 投影
  `surfaceOp={op:replace,start,end}` 和 `sourceEventSeqs`。WZU_Server 全 Workspace Test、Check、
  Clippy `-D warnings` 与 Fmt 均通过。
- [x] `DONE-58` 结构化 Shutdown/Quiescence：正式 Tool Batch 取消会 Signal 并 Join，
  不合作 Handler 返回 `CleanupTimeout` 并使 Loop 显式 Failed；Process Supervisor 在
  Runtime Abort 时同步 KILL 受管 Group，输出 EOF 有界收敛。Agent Supervisor 关闭新
  Admission，用共享 Deadline 收敛所有 Worker；Host 在 SIGINT/SIGTERM 后再关闭共享
  PTY Registry 并 Flush Shutdown Trace。测试覆盖 Runtime Drop、逃逸 Session、不合作
  Handler、活动 Provider Stream、Bash Leader/Descendant、多 PTY 和真实 Host SIGTERM。
  WZU_Server 全 Workspace Test、Check、Clippy `-D warnings` 与 Fmt 均通过。
- [x] `DONE-59` 可重复 Compact 消融基线：正式 Host 新增 `default/off/JSON` 策略选择，明确
  `auto=false` 只关闭 Pressure、`off` 才是真正无压缩；标准库 Runner 通过正式 Web RPC 为四个
  Variant 创建独立 Host/State/Session，落盘权威 History、Debug Trace、Usage、Compact 事件、
  质量和退出状态。RTX 4080 上 Qwen3.8-27B 四组烟测均精确回忆 3/3 事实，Auto 两组各完成一次
  Durable Replace，四个 Host 均正常退出；证据固化在
  `docs/evidence/compaction-qwen-4080-20260825/`。正式性能结论仍需多任务、多 Seed、轮换顺序和
  Variant 间 Provider Prefix Cache 冷启动。
- [x] `DONE-60` macOS LaunchAgent 工具依赖闭环：受管 Tool PATH 不再照抄 launchd 的最小
  `/usr/bin:/bin`，而是优先 Host 同目录并补齐用户/系统常见目录；ARM64 Artifact 同目录打包
  `xharness-host + rg`。本机已用双 V100 Qwen3.8-27B 真实执行 `glob`，返回 24 个 Cargo Manifest、
  `tool/result.ok=true` 并完成最终回答；当前 LaunchAgent 也已使用 bundled ARM64 ripgrep。
- [x] `DONE-61` Web 模型性能确定性投影：Host 新增 Provider-neutral 的 Usage Mapper 与纯
  `tokenUsage/sessionStats` 折叠器，统一把旧 snake_case 和新 camelCase Usage 输出为冻结的
  Web camelCase 契约；Live、History、Restart 与 Ephemeral 路径共用同一算法。TTFT、Decode
  Token/s、Token/Cache Accounting、LLM/Tool Duration 均从权威 Session Event 重建，同一步
  Usage 采用后样本替换而不重复累计；缺失 Provider Usage 时不伪造吞吐。WZU_Server 全
  Workspace Fmt、Check、Test 和 Clippy `-D warnings` 已通过；GitHub Linux 与原生 macOS
  ARM64 CI 通过并生成 Release。新版本已部署到本机 3082，双 V100 27B 真实流与强制重启前后
  Projection 等价验证均通过。
- [x] `DONE-62` Web Context Inspector：Core 每个 Step 的 `request/header` 已保存经过
  ContextPolicy、压缩和 Token Guard 后的完整 `input/tools/options`；Host 同时投影上游兼容的
  `config/system/tools` 与 XHarness 审计扩展。前端在 `Chat | Trajectory` 后注册第三个
  `Context` Tab，支持按请求切换、实际发送、压缩前/后、Diff、搜索、Token Budget、Tool Schema、
  Raw JSON，以及 System/人类/Reasoning/回答/Tool Call/Tool Result/压缩 checkpoint 颜色分类。
  产品插件进入静态模块图，具备 Node 烟雾测试和浏览器真实 Session 验证；规范见
  [`specs/context-inspector.md`](specs/context-inspector.md)。
- [x] `DONE-63` 长思考动态输出预算与安全续写：模型路由把目标输出、最小输出保留和安全余量
  分离，Token Guard 根据本次真实输入生成 `selectedOutputTokens`；默认允许 2 次新请求续写和
  131,072 Token 的 Turn 级累计上限，不设置独立的小 Reasoning 硬限制。`Length` 已成为
  `MaxTokens` 一等终态，部分 Text/Reasoning 正常持久化，残缺 Tool Call/Replay Envelope 禁止
  执行；纯思考、正文和 Tool Call 分别使用安全恢复指令。Host/Web 投影上游兼容的
  `turn/end: max-tokens`，不再显示通用失败。V100 路由目标 49,152、最小保留 16,384、安全余量
  4,096；4080 路由目标 16,384、最小保留 8,192。WZU_Server 的 Token/Core/Session/Host/
  Host-app 定向测试全部通过。
- [x] `DONE-64` 大 Session 流式热路径治理：Session 的不可变 Cut 使用 `Arc<Vec<Event>>`
  共享已校验前缀，单写者 Append 通过 Copy-on-write 保持旧快照隔离；JSONL Store 在进程内保存
  经文件身份、长度、纳秒时间戳和有界内容采样校验的写穿快照，Append/Flush 可移动热快照，避免
  每个检查点重新解析或克隆整份日志；跨进程 Advisory Lock 与磁盘 Revision 仍是 CAS 真源。Core 在持久化前合并相邻
  Text/Reasoning Delta，并以 64 个原始碎片、4 KiB 或 250 ms 任一阈值触发检查点。Web History
  对已有完整 Assistant Message 的 Chunk 只保留最终消息，对尚未完成 Step 的同类 Chunk 合并为
  最大 64 KiB 的投影块；连续尾缓存用隐藏占位保持 Sequence 不变。修复针对东京部署中单会话
  11.94 MiB、44,881 Event（其中 44,557 Chunk）导致的反复全量回放和浏览器超大事件列表。
  冷启动解析先校验每行 Batch Revision，再对汇总后的完整 Cut 只运行一次 Session 生命周期校验，
  不再为每行重复校验此前全部前缀。
- [x] `DONE-65` 精确模型推理强度：`ModelDescriptor` 为每条 Provider/Model 路由保存有序
  Effort、说明和默认值，Web `session.models/llm.models` 只投影当前模型真实能力，现成模型菜单
  动态显示并持久化选择。Session 选择与 Runtime 在写事件和网络前拒绝未知 Effort；Core 把
  Opaque ID 贯穿每个 Provider Request，OpenAI-compatible Adapter 用每档 `request_patch` 映射
  `reasoning_effort`、`chat_template_kwargs` 等端点原生字段，并禁止覆盖消息、工具、流和输出预算
  等 Core 所有字段。默认值进入新 Session 和 `request/header`，模型切换不会继承旧强度；配置、
  Registry、RPC、恢复与 Wire 映射均有回归测试，WZU_Server 全 Workspace Fmt、Check、Test 和
  Clippy `-D warnings` 通过。
- [x] `DONE-66` 输入框 Context 占用圆环：Core 在路由或容量变化时持久化标准
  `request/context`；Host 新增可重建、可增量发布的 `contextPressure` Projection，并为旧
  `request/header.options.tokenBudget` 日志保留容量迁移。Context 工具栏移除重复 Token 文本，
  直接启用聊天输入框原生无文字圆环及其按需详情面板。
- [x] `DONE-67` Harness 构造视图：Context 页的同权胶囊改为默认折叠的单行请求详情，
  Tool Definitions 移出模型输入正文；新增第四个 `Harness` Tab，从选中 RequestHeader 快照
  重建 Prompt Assembly、最终 System Prompt、可搜索 Tool Registry、Context Policy 和 Runtime
  Route。浏览器已验证 13 个真实模型可见工具与 4 个 Prompt Section，无新增后端协议。
- [x] `DONE-68` Web Reader 摘要与当前批次大结果保护：`web_fetch` 的模型可见预算从 100,000
  字符降为 8,000，HTML 在 Markdown 前移除 Script/Style/Template/SVG 等噪声，并用确定性
  `reader-extractive/v1` 按标题、章节、表格、前部和可选 Focus 选段；响应报告 Source/Extracted
  字符与算法版本。正式 Host 同时从 `IdentityContextPolicy` 切换到 8,192 字符的
  `ToolResultPruningContextPolicy`，旧 Session 或最新未可 Compact 的大工具结果在请求 Surface
  上形成 `tool_result_pruned/v1` Envelope，原始日志与 Tool Call ID 不变。该修复针对真实回归：
  Codeforces 抓取读取 261,147 Byte、写回 102,434 Byte，连续两次 Compact 后仍以
  `120811 > 118784` 被请求前 Token Guard 拒绝。
- [x] `DONE-69` Web Fake-IP 与 macOS `/dev/null` 修复：公共域名被 Clash/Surge TUN 解析为
  `198.18.0.0/15` 时，不再误报 Private Target；Host 引入加密公共 DNS 验证并把真实地址固定到
  HTTP Client，直接 Reserved/Private IP 仍拒绝。`web_fetch` 明确独立于 Session 进程权限，
  Workspace-write 下可用而 Bash 网络仍隔离。Seatbelt 仅额外允许精确的 `/dev/null` 字符设备
  写入，修复 `command 2>/dev/null` 的假失败，不扩大 Workspace 外普通文件写权限。
- [x] `DONE-70` 通用后台 Job 第一阶段：新增生产者无关 `xharness-jobs`，实现
  Reserve-before-side-effect/Commit、按 Kind 单调 ID、Owner Fence、`running/stopping/completed/
  killed/failed` First-wins、每 Owner 10 个活跃任务、100 条终态保留、每流 256 KiB 未读 Tail、
  Wait Timeout、幂等 Kill、Cancel Hook 异常零状态变更、Lease Drop Force-fail、三类 Lifecycle
  Broadcast 与有界 Shutdown。`bash` 新增 `run_in_background=true` 并用 Process Live Observer
  增量喂入 Job；模型新增 `job_output/job_list/job_kill`，旧六个 `terminal_*` 从默认 Tool Schema
  移除；Host 同步注入 Job 跨 Step 选择规则，模型输出隐藏 Owner/PID/通知账本。WZU_Server 定向
  测试覆盖全部五态、动态配置、Owner/容量/历史保留/UTF-8/丢输出、非零退出、Kill、进程树和
  Shutdown Cancel 异常/超时 Corner Case，并提供可选 DeepSeek PTY/nohup 行为测试。2026-09-01
  DeepSeek V4 Flash 实测正确选择 `bash(run_in_background=true) -> job_output(wait=true)`，未生成
  `nohup/&/PTY/screen/tmux`。
- [x] `DONE-71` 持久 Schedule：复用正式 Tool Registry、Session Log 与 Durable Agent，新增
  `schedule_create/list/delete` 和版本化 `schedule/change`；支持 `after`、显式 Offset/IANA 时区
  `at`、最小 5 分钟固定相位 `every`、DST 校验、离线 latest-only catch-up、ID 永不复用和稳定
  Delivery Message ID。Timer 是可丢弃投影，Host 重启会重挂或补发 overdue；到期只在 Idle 边界
  以注入安全 reminder followup 唤醒 Agent，并沿普通 RunningTurn 实时投影到 Web。远程测试覆盖
  规则校验、时区、调度、Busy/Idle、恢复和 Host 背景回合；模型行为验收保留为部署后测试。
- [x] `DONE-72` 会话选择刷新保持：模型恢复先折叠最后一个显式 `session/model-selected`，只有
  旧日志不存在显式选择时才回退最后一个 `request/header`，避免 Provider 未回写 Effort 时把
  用户选择的推理强度恢复成模型默认值；真实 Web 权限回归新增浏览器 Reload，Composer 在 Turn
  运行期间禁用权限切换，避免 Host 拒绝策略热切换后 UI 暂时显示未落盘的 Full access。
- [x] `DONE-73` 历史 Assistant 请求侧投影：正式 Context Policy 升级为
  `context-history-pruning/v2`；只有匹配到后续 `ok=true` Tool Result 的大型 `write.content`、
  `edit.old/new` 才替换成带字符数、UTF-8 Byte 数和 SHA-256 的
  `tool_arguments_pruned/v1`，失败、未完成和坏 JSON 调用逐字保留。最新 User Turn reasoning 与
  opaque Provider Item 保留，旧 Turn plaintext reasoning 从一次性 Surface 移除；Responses
  `function_call` 与 provider-neutral Tool Call 同步投影，Call ID、Result 和源日志不变。
  WZU_Server 32 Tool Call Release 消融把请求消息从 1,136,998 Byte 降至 42,150 Byte
  （-96.29%），Policy CPU 从每次 0.159 ms 增至 3.639 ms；全 Workspace Test、Check、Clippy
  `-D warnings` 通过。当前真实会话最后一次请求重放估算从 90,363 Byte 降至 35,699 Byte
  （-60.49%）。真实 Provider TTFT/Prefill A/B 仍按 `REL-05` 单独验收，不能由 Payload 降幅替代。
- [x] `DONE-74` Bash Tool View：Rust Host 对权威 Session、旧内存适配器、Live Mux、分页 History
  和重启日志统一投影上游 `callView/resultView.card="terminal"`。Call 保留 command/cwd/description；
  前台结果从结构化 Metadata 恢复 stdout/stderr/exitCode/signal，并明确标出截断。后台 Job、坏 JSON、
  错误形状均 Fail-closed 回退通用卡片；旧日志可从 JSON Tool Result 恢复。WZU_Server 回归覆盖运行中、
  完成、非零退出、截断、后台结果、坏参数、Legacy Live/History 等边界。
- [x] `DONE-75` Tool Arguments Durable Coalescer：同一 Turn/Step/Tool Index 且兼容 ID/Name 的相邻
  参数碎片在 Checkpoint 内合并；Direct Embed 仍收到每个实时 Delta，冲突身份 Fail-closed 分帧。
  DeepSeek V4 Flash 真实 Coding Run 中 4 个 Tool Call 和外部验收均通过，实时 Delta 110 条、Durable
  Chunk 5 条（-95.45%）。Full Debug 继续保留原始 Provider/Core 证据，不与普通下行量混淆。
- [x] `DONE-76` Windows 原生适配：新增集中审计的 Win32 原语层，Process 使用
  `CREATE_SUSPENDED → Job Object → ResumeThread` 消除派生竞态，文件系统覆盖大小写边界、
  reparse point、CAS、DACL 与 `ReplaceFileW`，受限写入使用 restricted-token ACL partial 后端，
  终端使用 ConPTY，模型命令使用 PowerShell 7 并可显式调用 OpenSSH/Git Bash。Windows Server
  2025 CI 执行全 workspace format/check/test/clippy、release 打包；DeepSeek V4 长任务验收保持
  手动 secret workflow，未实际运行前不得声称在线通过。

## P0 — 可日常使用的本地 Coding Agent



- [x] `P0-02` **持久长生命周期 Agent 层。** 新增 `xharness-agent`：Agent、Turn、Step、
  Durable Inbox Message ID、Claim/Ack、Next-turn/Next-step 语义、Single-writer Session
  Lease 和重启续跑。
  Host-facing `AgentRuntime -> RunningTurn` 替换边界以及正式 Host 的持久 Runtime 接管均已完成。
  已实现：`agent/inbox/spliced` 事件、Next-turn/Next-step Replay、稳定 Message ID、原子 Claim
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
  Select 和 6 个 Goal RPC 也已使用同 Revision 原子 Receipt。Session Create/Fork、Queue/Cancel/
  Attachment、Preset Copy/Remove 等剩余通用 Receipt 归 `P2-01`；Secret-free Credential
  Reference Store 归 `P0-09`，不再作为长生命周期 Agent 主链路的完成阻塞项。
  七点通用日志前缀和包含 Approval Asked 的八点真实子进程 SIGKILL/同目录重启矩阵均已完成。
  Approval Asked/Decided、Provider Retry/Started、Agent/Permission/Sandbox/Approval Policy 与
  Permission Command Receipt 已进入强类型 Session Log 和确定性 Web History；Pending Approval
  已能在重启后按原 Approval/Execution ID 重新投影并继续回答。剩余冻结 Event 词汇归 `P2-01`
  的 Web 完整投影。
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

- [x] `P0-06` **结构化 Shutdown 和 Quiescence。** 正式生产路径已用明确所有权管理
  Provider/Tool/Process/PTY Task；Cancel 必须 Signal 并 Join，超过 Grace 记为
  `CleanupTimeout/ForcedCleanup`，不伪造普通 Cancelled。Agent/Host 关闭会阻止新 Admission，
  共享一个 Deadline，并在所有持久 Terminal 收尾后才成功退出。旧
  `LoopRequest.tools` 兼容 Scheduler 的完全删除仍归 `P0-03`，正式 Host 已不使用它。
  `FullAccess` 不能硬回收主动 `setsid()` 逃离 Group 的孤儿；该安全保证仍属于
  Linux PID Namespace/受限 Sandbox，保留 Pipe 的逃逸会被有界 Drain 检测为失败。

- [ ] `P0-07` **macOS 原生运行验证。** 在真实 Apple Silicon Mac 上运行 FS Race、Seatbelt、
  PTY Lifecycle、Web TLS、Live Loop，并打包/签名 CLI。仅 Cross Compilation 不算完成。
  ARM64 原生 CI、FS/Process/PTY/Seatbelt 测试和未签名 Host 构件已经完成；剩余 Web TLS、
  真实 Provider Live Loop、开发者签名、公证和本机安装/启动验证。

- [x] `P0-08` **Web DNS Rebinding 加固。** 每个连接绑定到已验证 Resolve Address，同时
  保留 TLS Host/SNI；Redirect 重新应用 Policy。已测试 Address Pin、IPv4-mapped IPv6、
  Reserved Range，以及 Fake-IP 仅对域名进入加密公共 DNS 验证、IP Literal 始终拒绝的边界。

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
  Envelope；通用 Durable Surface Replace 已由 `DONE-57` 完成；生产请求侧 Tool Result Pruner
  与 Web Focus Relevant 选段由 `DONE-68` 接入。剩余：原始大输出持久 Spill/Reference，以及把
  Pruner 的一次性 Edit 接入持久 Replace 事务。

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

- [x] `P0-16` **持久 User Question 交互。** 已新增 `xharness-interaction`，冻结每次 1—3 个问题、
  每题最多 3 个有限选项、可选自由文本、`context/agent_markdown` 目标、Submit/Continue、空或部分
  回答、Draft/Dismiss、Cancel 与幂等 Resolution；`ask_user_question` 复用现有 Tool Registry，使用
  `Exclusive + External Settlement + Standalone Batch`，不受普通 Tool Timeout 影响，混合副作用
  批次在执行前拒绝。规范和接口测试见
  [`specs/user-questions.md`](specs/user-questions.md)。Session 强类型事件、Flush、Pending Recovery、
  `DurableQuestionHub`、`/api/respond`、冻结 Web 组件协议、受管 AGENTS.md Memory Sink 与下一轮
  Prompt 注入均已接通；Host Restart 会复用原 Interaction/Execution ID 恢复原 Turn。已覆盖有限
  选择、自由输入、部分/空回答、取消、幂等、Registry、Web Frame、Session 投影、Host 恢复和
  AGENTS.md 原子写测试。**后续但不阻塞本项：** 冻结上游 UI 没有跨刷新 Draft RPC；问题组的
  Compact 原子安全切点、Agent Markdown 独立 Prompt Budget，以及 Requested/Resolved/Tool Result
  每个 Flush 点的外部 SIGKILL 扩展矩阵归 `P1-03/E-08`。

## P1 — Coding 质量与上下文效率

- [ ] `P1-01` **Prompt Registry。** 有序 System Section、Workspace Context、Tool Guidance、
  Variable、Provider-specific Section、确定性 Request Header Capture 和 Prompt Version ID。
  `P0-14` 只交付最小可用注入，本项完成完整注册、Scope 与组合能力。

- [ ] `P1-02` **LLM/Provider Registry。** 按 Provider/Model/Purpose 路由，把 Prepared Call
  绑定到一个注册 Adapter，暴露 Reasoning/Max-token 控制，并在不猜协议的情况下发现模型能力。
  **已完成基础切片：** 单 Host 多 Provider/Model Registry、公共路由与上游模型名分离、每路由
  Token Guard、JSON 配置、Web 模型目录和选择前 fail-closed 校验。**剩余：** Purpose 路由、
  Reasoning 原生字段、模型 Capability/Tokenizer 注册、凭据服务绑定和安全热重载。推理档位必须
  改为 Adapter 驱动的动态 Capability：优先读取 Provider 明确提供且带版本的能力元数据，其次使用
  Adapter 的 Last-known-good 缓存，最后才回退到显式静态配置；禁止 Core/UI 猜测
  `low/high/max/xhigh` 的含义。探测结果必须带 `capability_revision`、TTL/ETag、来源与更新时间，
  热更新不能让活动 Turn 的已绑定档位在请求中途变化；Provider 只返回模型列表而不返回推理档位时，
  必须明确标记 `not_advertised`，不能把 `/models` 的成功误当成完整能力发现。Web 只投影目标模型
  当时真实可用的档位，新档位可出现，撤销档位对新 Turn fail-closed，历史 Session 仍可读取。
  **已完成 Context Capability 切片：** `ModelProvider::capabilities()`、带来源/ETag/抓取时间的
  `ContextWindowCapability`、OpenAI-compatible 结构化 URL + JSON Pointer + TTL Probe、显式
  `deployment_declared_fallback`、Web Capability 投影，以及 Session 可持久化软窗口均已接线。
  Token Guard/Compact 使用软窗口，选择超过部署硬上限会在 Event/Provider I/O 前失败。**剩余：**
  Registry 热刷新与 Last-known-good、运行中能力撤销的下一 Turn 对账、其他 Capability、Purpose、
  凭据服务和安全热重载。
  Context 数据模型现已拆分模型 Ceiling、Provider、Deployment、Account 和 Fallback Evidence，
  有效上限取约束交集；模型切换会重新物化目标模型上限，不继承前一模型窗口。仍需 Capability
  Manager 在 Turn 边界完成热刷新、上限缩小时的持久自动调整和非阻塞 UI Notice。

- [ ] `P1-03` **Token Meter 与 Context Policy。** Provider-aware Token Estimate、最大输入
  Guard、确定性 Tool Output Reduce、Surface Replace，以及不修改原 Event Log 的可选 Summary。
  `P0-11/P0-12` 先封死超窗，本项补 Provider-aware 精确计量、摘要和长期压缩策略。
  **已完成 Compact 抽象切片：** 新增 `xharness-compaction`；默认参数对齐上游
  `threshold=0.8 / retain=0.16 / maxTokens=8192 / retries=1 / overflowRetries=1`；实现精确
  Model Route 覆盖、Pressure/Overflow/Manual 规划、Tool Call/Result 安全切点、Unicode Tool
  Result Pruner、Checkpoint Frame 与 `CompactionSummarizer` Trait。Chat/Responses 的 Provider
  原生完整请求 Token 计数也已接入，不支持时回退保守 Meter。
  **已完成生产接线：** Session 强类型 `compaction/start|summary|end|prune`、Checkpoint
  `surfaceReplace`、当前 Surface 投影、Start/成功批次/End/Flush 事务、未闭合 Start 恢复、摘要
  变小校验、完成后重新计量、请求前 Pressure/Hard Overflow、Provider 400 Context Overflow
  恢复、正式 Durable Host 默认启用、Web `surfaceOp={op:replace,start,end}` 投影及回归测试。
  Compact 已使用独立 `compaction_reasoning_effort`，由精确模型能力列表解析最低成本档，不继承
  主对话 high/xhigh；摘要请求固定 `tools=[]`，并已回归覆盖思考档位与 Tool Schema 隔离。
  **剩余：** 手动 `/compact`、Purpose 路由到独立摘要模型、把 `DONE-68` 的请求侧 Tool Result
  Pruner 和请求侧 `tool_arguments_pruned/v1` 接入持久 Replace/内容引用缓存、Provider 结构化
  错误码优先于兼容文本分类、真实 SIGKILL/Flush 全切点矩阵、按模型本地精确 Tokenizer，以及把
  已解决 Question/Answer/Tool Result 作为不可拆分单元选择 Compact 安全切点；未决 Question
  始终留在当前开放 Step，不参与 Compact。还需增加基于 `source_revision + surface_fingerprint` 的
  Compact 幂等门：相同输入不得重复摘要，摘要后实际 Token/Byte 降幅不足 10% 时记录
  `no_progress` 并熔断，直到安全切点推进或压力显著增加；当前开放 Turn 中不可压缩的大 Tool Call
  不能触发逐 Step 摘要循环。摘要必须把 Tool Result/文件 SHA/副作用状态放在确定性 Fact Ledger，
  LLM 只能压缩叙述，禁止把未执行计划、Reasoning 推测写成已确认文件状态。精确 Tokenizer 必须同时
  报告 Tool Schema、Assistant Tool Arguments、Reasoning 与 Provider Opaque Items，不能只计
  `message.content`。

- [ ] `P1-04` **动态 Tool Projection。** 每个 Profile/Step 只发送相关工具，同时保持 Schema
  稳定。默认 Coding Bundle 为 `read/grep/glob/write/edit/bash`；Interaction、Job、Schedule、Web
  根据最新用户意图、活动 Job/Schedule 和前一步 Tool Result 确定性启用，并提供小型 Capability
  Catalog/Enable 兜底，防止 Router 漏判后永久失去工具。与始终发送全部工具进行多 Seed A/B，
  报告 Tool Schema Token、Cache、TTFT、错误工具选择率、完成率和额外 Enable Step。

- [ ] `P1-05` **更完整且不重复的 Tool Description。** Prompt Section 只保留跨工具路由原则，
  单工具 Description 只保留输入、输出和关键限制；消除 Job/Schedule 规则在 System、`bash` 和
  控制工具中的重复，修复 System 写 `web_search` 但正式模型面只有 `web_fetch` 的不一致。目标在
  不降低选择质量的前提下把 Schema 序列化体积降低 30%—50%；继续使用固定工具选择数据集和
  DeepSeek 的 PTY/nohup 提示做评估。

- [ ] `P1-06` **扩展 FS Tool。** 增加目录创建/列表、安全 Delete/Move/Copy、Binary/Image
  Read、Unified Diff/Patch、按行读取和显式 Spill Reference；继续保持 Observation CAS 和审批。

- [ ] `P1-07` **后台 Job 后续。** 第一阶段已完成 One-shot Bash `run_in_background`、Owner-scoped
  Job Registry、三个控制工具、内存 Tail、五态、Process-tree 清理与 Lifecycle Broadcast。
  剩余：Finished Notice 自动注入 Busy Agent 或唤醒 Idle Agent、全量 Spill 文件、Host 崩溃后的
  Outcome Unknown/Orphan Reconciliation（禁止自动重放命令）、Web Job List Projection，以及
  Subagent/Workflow 等新 Producer 接入同一 Registry。

- [ ] `P1-08` **专用交互 Terminal Profile。** 默认模型面已移除旧六工具。若 TUI/REPL 确有需求，
  重新设计仅按 Profile 投影的 PTY 能力：Resize、OSC 133 Prompt Marker、Foreground-pgid、
  Read-state Observation、Active-send 互斥和明确 Settle Reason；禁止再把持久 Shell 当后台 Job。

- [ ] `P1-09` **多模态 Message 与 Attachment。** 强类型 Text/Image/File Block、内容寻址
  Blob Store、Image Metadata/Budget、Provider Encoding，用持久 Reference 替代内联大数据。

- [ ] `P1-10` **Web 质量。** `DONE-68` 已完成脚本去噪、8,000 字符 Reader 抽取摘要与 Focus
  选段。剩余：更多 Search Provider、稳定 Source/Citation Object、跨请求内容去重、完整
  Readability/Cache，以及作为独立高信任 Capability 的可选登录态 Browser。

- [ ] `P1-11` **Session Branch 与 Projection。** 从 Revision Fork、不可变 Ancestry、命名
  Branch、Inspect/Query API 和确定性 Transcript Export/Import。Compaction Surface Event 与
  Web Replace 投影已经由 `DONE-57` 完成，不再属于本项缺口。

- [ ] `P1-12` **资源 Policy。** CPU/Memory/File/Process/Output Quota、Per-tool Policy、
  条件允许时接 Linux cgroup v2，并让 Quota Failure 可观测。

## P2 — Host、API 与 UI

- [ ] `P2-01` **持久 Agent-backed Web API。** Carrier、52 方法目录、Start/Steer/Cancel/Approve、
  History Projection、Optional Capability Response 和 Export Body 已完成。正式 Host 的 Prompt
  Admission、模型历史、Agent Driver、Workspace 元数据/排序、Session 排序/归档、Settings、
  Durable Queue、权威 History Cursor 和 Pending Approval 均已由 Session/Inbox/Control Log 重建。
  **剩余：** Session Create/Fork/Cancel/Attachment、Preset Copy/Remove 等 RPC 的通用持久 Receipt，
  Credential Reference，以及 Health/Readiness；继续缩小 `BasicHost` 中仅用于兼容投影的内存缓存。

- [ ] `P2-02` **流式传输增强。** 提供带 Cursor Resume、Lag Detection、Reconnect 和
  Per-session Multiplexing 的 WebSocket/SSE 下行事件流。增加两级 Delta Coalescer：首个正文/
  Reasoning Delta 立即发送以保护 TTFT，随后按 20--50 ms 或 4--16 KiB 合并；Tool Arguments 默认只
  投影进度和最终结构，不把每个 token 作为独立 Web 卡片事件。Tool Arguments 的 Checkpoint 内相邻
  合并和真实模型验收已由 `DONE-75` 完成；剩余两级时间/字节下行合并与最终结构专用投影。Durable
  Journal 保存可恢复的合并帧
  和最终 Assistant/Tool Call，不为每个 Provider 微碎片追加一条 Event；Cancel、Finish、Tool Call
  边界必须强制 Flush。验收报告原始 Delta 数、下行 Frame 数、JSONL 增长、CPU、重放一致性和崩溃
  最多丢失的未 Flush 窗口。

- [ ] `P2-03` **Web UI 完整投影。** 继续把 DeepSeek Harness UI 作为 Client Projection：
  Session、流式 Reasoning/Text、Tool Card、Approval、Terminal、File、Web Source、Usage、
  Recovery State。模型性能字段按 [`specs/metrics-projection.md`](specs/metrics-projection.md)
  已完成 M1–M3：单次 Usage camelCase、`tokenUsage` 与 `sessionStats` 的 Live、History、
  Session List 和 Restart 等价投影均由 `DONE-61` 关闭，现有前端可以恢复 TTFT、Token/s、
  Token 总量和 Cache Hit。此项继续跟踪非模型指标的 Terminal/File/Web Source 等完整投影。
  Rust Host 已补齐上游 Bash Tool View 契约：`bash` 的运行中 Call 投影
  `callView.card="terminal"`（command/cwd/description），完成结果投影
  `resultView.card="terminal"`（stdout/stderr/exitCode/signal），成功、运行中、非零退出和截断结果均
  可沿上游 Bash 卡片展开；Live/History/Legacy/重启兼容由 `DONE-74` 关闭。**剩余：** 运行期间
  stdout 增量卡片、浏览器无鼠标键盘 E2E，以及 File/Web Source 等专用 View。`write/edit` 的大
  Content 不逐字符渲染，但完成后必须提供
  Path/Diff/Hash 和按需 Raw Inspect，不能以 Coalescing 为由永久隐藏工具详情。测试覆盖 Live、
  History、重启恢复、运行中 stdout 追加、失败退出码、输出截断与无鼠标键盘展开。

- [ ] `P2-04` **Host 认证与授权。** 默认仅本地；远程使用 Bearer/Session Auth、Workspace/
  Owner 隔离、CSRF/Origin Policy、Audit Log 和显式 Network Exposure。

- [ ] `P2-05` **可观测性。** 结构化 Tracing、Per-step Latency/TTFT/TPOT、Tool Duration、
  Retry/Cancel Reason、Token/Cache Accounting、OpenTelemetry 接口和 Secret-safe Diagnostic Bundle。
  **已完成 Debug Trace 抽象切片：** `xharness-debug` 提供默认零 I/O Noop、Full JSONL 单写者、
  全局 Sequence、64 KiB Content-addressed Blob、递归凭据脱敏、显式 `sync_data` Flush 和 Unix
  `0700/0600` 权限；Host App 已支持 `XHARNESS_DEBUG_TRACE=full`、`XHARNESS_DEBUG_DIR` 及
  Start/Restore/Listening/Exit；同一 Recorder 已贯通 Core Context/Loop、OpenAI Wire/SSE、Tool Pipeline、
  Process 原始输出、PTY、Sandbox、Web Search/Fetch 和 Server RPC/WebSocket，并补跨层测试。
  `DONE-61` 已完成 Web 兼容 `tokenUsage/sessionStats` 确定性聚合。**剩余：** Trace
  Rotation/Retention、TPOT、Diagnostic Bundle 和 OpenTelemetry Adapter。Provider 专有 Timing
  只进入诊断命名空间，不覆盖统一事件时间口径。

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

- [x] `P3-03` **Scheduler/Automation。** 已由 `DONE-71` 完成 Session-owner 持久 Timer、
  Idle-only Agent Wakeup、一次性与固定相位 Recurring Schedule、离线 latest-only Missed-run
  Policy、`schedule/change` 可观测执行历史、重启恢复和 Web 实时投影。当前产品边界是进程常驻、
  会话本地提醒；操作系统级 Wake、跨设备通知和独立 Cron Worker 属于后续产品扩展，不回退本项。

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
  Output Reserve 分项，并包含多个并行大文件结果导致单 Step 暴涨的用例。Context P0 消融必须
  至少覆盖 32 个成功 `write` Tool Call、失败/未完成调用不投影、Responses `function_call` 同步、
  投影确定性、Call/Result 拓扑不变、请求 Byte/Token 降幅、Policy CPU 和真实 Provider TTFT/
  Prefill；不能用仅减少 Payload 的结果宣称端到端一定更快。增加单次 50 KiB Tool Arguments 被
  Provider 切成 1--5 字符碎片的回归，比较 Coalescing 前后的事件数、JSONL 体积、Web 渲染负载与
  TTFT；增加大型 `write` BlindOverwrite -> Read -> Retry、Host 重启恢复 Observation、Compact
  `no_progress` 熔断以及错误摘要不得覆盖确定性 Tool Fact 的真实失败路径。
- [ ] `REL-06` Semver/API Audit：Non-exhaustive Extensible Type、Builder、Deprecation Window、
  Changelog、Reproducible Lockfile、SBOM、License、Signed Artifact。
- [ ] `REL-07` Security Regression：Symlink Race、Sandbox Escape、Process Descendant、SSRF/
  Rebinding、Credential Leak、Approval Fail-open、Log Corruption、Cross-owner Access。
- [ ] `REL-08` **DeepSeek Flash 真实 Coding 验收闭环。** 按
  [`specs/live-deepseek-evaluation.md`](specs/live-deepseek-evaluation.md) 先过确定性/Debug/协议门禁，
  再让 Flash 在隔离 Workspace 完成固定真实编程任务；Harness 独立验收构建、测试、Diff、任务约束、
  Side Effect 和恢复语义，记录 TTFT、Decode、Cache、Tool 成功率、重试、Context/Compact、事件量、
  JSONL 增长和端到端时间。每个失败必须进入可复现 Fixture/回归测试后再修复，禁止只改 Prompt 掩盖
  Runtime Bug；连续三轮无回归且满足阈值后才提升默认版本。
