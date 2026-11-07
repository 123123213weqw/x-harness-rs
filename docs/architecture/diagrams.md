# XHarness 架构详图

本文是[总体架构](../architecture.md)的配套图解，把该文档中分散描述的分层、边界、管线与
恢复顺序画成可以逐条对照的图。图**不引入新的契约**：每条边和每个阶段都来自
`../architecture.md`、`docs/specs/` 的既有规范、当前 workspace manifest、
`config/architecture-host-modules.json` 或对应源码。图与规范或源码冲突时以后者为真，
并修正图。

阅读约定：

- 全部图是最小依赖的 `text` 代码块，沿用仓库既有惯例，在 GitHub、终端和 IM 中同样可读。
- `──>` 表示编译期依赖或运行时调用方向；`┄>` 表示投影/事件通知，不反向驱动状态。
- “已实现 / 计划中”的判定沿用[总体架构](../architecture.md#交付顺序)，本文不重新评估交付状态。
- 图只列关键边。完整依赖以各 crate 的 `Cargo.toml`（normal 依赖）为准。

## 图 1：Workspace 分层与 crate 依赖方向

46 个 workspace crate 按当前 manifest 的实际依赖方向分层。这是对现状的描述，不是新增的强制
规则：跨层新依赖仍必须按 `docs/specs/` 与架构检查审查。唯一选择具体实现的位置是最顶端的
`xharness-host-app`。

```text
 L5 组合根
    xharness-host-app ──> 37 个 crate（normal 依赖，含平台条件）：选择 Provider /
                          Server / 原生工具，产出二进制

 L4 控制面与长生命周期运行时
    xharness-host ──> agent, core, session, projection, schedule, attachments,
                      compaction, session-import, tools, token, prompt,
                      interaction, jobs, fs, control, api, debug, diagnostics, win32
    xharness-agent ──> core, goal, session
    xharness-schedule ──> agent, session, tools
    xharness-projection ──> core, session
    xharness-goal ──> session

 L3 模型循环与上下文
    xharness-core ──> context, compaction, prompt, token, tools, session, debug
    xharness-context ──> compaction, session
    xharness-compaction ──> session
    xharness-provider-openai ──> core, attachments, token, debug

 L2 能力与原生执行
    xharness-tools ──> debug ──> diagnostics, win32
    xharness-interaction ──> tools        (session ──> interaction)
    xharness-platform ──> fs, process, sandbox ──> debug, win32
    xharness-coding-tools ──> platform, process, jobs, fs, web, tools, debug
    xharness-terminal ──> process, debug, win32     web-terminal ──> terminal, process
    xharness-computer ──> tools      computer-macos / computer-windows ──> computer

 L1 传输与接入（normal 依赖只到 api 与叶子层；xharness-remote 的 host 依赖仅用于测试）
    xharness-server ──> api, debug          xharness-remote ──> api
    xharness-mobile ──> api, remote         xharness-relay ──> mobile
    xharness-channel-telegram / channel-weixin ──> remote
    xharness-cloud-app ──> cloud

 L0 叶子层（无内部依赖）
    api, win32, diagnostics, control, jobs, token, prompt, plugins, mcp,
    installation, cloud
```

约束要点：

- `xharness-core` 不依赖任何平台、进程或 HTTP 实现，操作系统分支只允许出现在
  `xharness-platform` 及其下层（[全局不变量 5](../architecture.md#全局不变量)）。
- `xharness-host` 不依赖任何原生平台、具体 Provider 或 Server；这些只在
  `xharness-host-app` 组合，见 [Host 规范](../specs/host.md)。它对
  `xharness-process` / `xharness-session-jsonl` 只有 dev 依赖，因此不出现在 L4 的
  normal 依赖列表中。
- `xharness-api` 是叶子：它冻结线协议类型，不允许反向引用 Host、Core 或 Session 类型。
- 依赖方向不是靠约定维持：`scripts/regression/check-architecture.py` 以
  `config/architecture-dependencies.json` 为冻结基线，拒绝新增内部 crate 依赖；
  有意新增的边必须先做架构基线审查。

## 图 2：部署与进程视图

同一份 `xharness-host` 服务两种入口；Tauri 不是第二套后端。

```text
      浏览器（任意平台）                      桌面（Tauri 壳）
      ui/ 构建产物                            apps/desktop（src-tauri）
            |                               |
            | 反向代理认证边界              | 签名壳 + Sidecar 生命周期
            | （浏览器部署不经 Tauri）      | Token 只经 Sidecar 环境变量
            +---------------+---------------+
                            |
                            v
                     xharness-server
                     - 静态 UI、HTTP、WS 承载
                     - 127.0.0.1:0 原子绑定；Ready File 只写地址
                            |
                            v
                   xharness-api（线协议）
                   - 56 个 unary RPC + 四象限信封
                   - 上行请求 / 下行两条 WebSocket
                            |
                            v
                   xharness-host（控制面适配）
                   - DTO ↔ Rust Domain；不持有 Provider / 平台实现
                            |
                            v
                   xharness-host-app（原生组合根）
                   - DurableLoopAgentRuntime + JSONL Store + File Lease
                   - Provider、Platform、Jobs、Web、Server 的选择处
```

## 图 3：Web 线协议到 Host 的分发

`RpcMethod::ALL` 恰好 56 个 unary RPC（上游兼容 52 加本仓库 4 个扩展），未知方法字符串
不可分发；命名空间与 Host 处理模块一一对应。

```text
 xharness-api::RpcMethod（56）        xharness-host::rpc.rs 分发目标
 ──────────────────────────────       ─────────────────────────────────────────
 session.*            14 ──> rpc/session.rs             读：list/search/history/models
                              rpc/session_lifecycle.rs  写：create/selectModel/rename/fork
                              rpc/turn.rs               prompt/attachment/queue/cancel
                              rpc/session_import.rs     session.import（自有扩展）
                              rpc/session_delete.rs     session.delete（自有扩展）
 subagent.*            4 ──> rpc/subagent.rs
 host.*                5 ──> rpc/host.rs                describe/目录/打开路径
 workspace.*           8 ──> rpc/workspace.rs           含 unarchiveSession 自有扩展
 skill.*               1 ──> rpc/host.rs::skill_list
 agentPreset.*         6 ──> rpc/preset.rs
 goal.*                7 ──> rpc/goal.rs                含 updatePlan 自有扩展
 settings.*            5 ──> rpc/settings.rs
 credentials.*         3 ──> rpc/credentials.rs
 llm.*                 3 ──> rpc/model.rs
```

动态端点不在 56 个 unary 目录内，走同一信封但不参与方法名冻结：

```text
 commands/list、commands/execute、goals/*、automation/manage、job/manage
        ──> rpc/dynamic.rs（显式兼容边界）
 swarm/tasks、swarm/manage、workspace/memory、display/inspect、display/read、
 github/review-*、github/*
        ──> rpc.rs 内联分发；github/* 读路径经 GithubBackend，
            github/chat-* 已退役并 fail closed
```

`rpc/<namespace>.rs` 之后进入两类状态所有者，边界由架构检查强制执行：

```text
 rpc/<namespace>.rs ──> 受管纯决策模块（9 个，见 图 10）
                   ──> 其余 Host 状态：state.rs、driver.rs、restore.rs、
                       projection publication、session_recovery.rs
```

## 图 4：一次 Turn 的生命周期

Web Turn 的完整链路。用户输入在被领取前不是模型历史；`turn/start` 与 `user/message` 必须
与领取在同一 CAS Revision 提交，进程在两者之间崩溃不得丢输入。

```text
 浏览器 RPC（session.prompt / updateQueue / cancel）
        |
        v
 xharness-server -> xharness-host::rpc::turn
        |
        v
 Admission（driver.rs）：admission gate / Admission Fence
   - 已关闭的自动执行门禁只允许用户输入或显式维护通过；维护不解除门禁
   - 绑定 AdmissionReceipt(fingerprint) 做重复抑制
        |
        v
 AgentRuntime::admit_turn / admit_steering（xharness-host）
        |
        v
 xharness-agent Durable Inbox：next-step 全部 + 至多一个 next-turn
        |
        v
 原子 Claim（同一 CAS Append）：turn/start + agent/inbox/spliced + user/message
        |
        v
 每个 Step：Context 投影 -> Token Guard -> Provider 请求（见 图 5）
        |
        +-- 无 Tool Call --> step/end -> turn/end
        |
        +-- 有 Tool Call --> tool/call 先落账 -> 工具管线（见 图 6）
                                -> tool/result 按原调用顺序持久化 -> 下一 Step
        |
        v
 结算：turn/end 写入 Session 真源
        |
        +-- 投影 -> xharness-host 事件网关 -> 两条下行 WebSocket
        +-- 触发 Dispatch：Goal 续轮 / 自动派发门禁 / Durable Followup（见 图 9）
```

取消方向与执行方向相反（[关闭链路](../architecture.md#原生执行层)）：Host 先关闭新
Admission，Agent Supervisor 向活动 Loop 发 Cancel，Loop 向正式 Tool Batch 广播 Signal 并
Join，最后等待共享 Job Registry；超过共享 Deadline 只能记为 Forced Cleanup。

## 图 5：模型 Step 的上下文与 Token 预检

任何 Provider 请求都必须先通过预算，超窗时不得发起 HTTP。

```text
 Session 原始事件（append-only，唯一真源）
        |
        v
 Transcript 投影（derive_messages；被领取的输入才可见）
        |
        v
 Context Policy（xharness-context）：ContextRequest -> 一次性 ContextSurface
   - 正式策略 context-history-pruning/v4：旧 Tool Result 头部/尾部封套
   - 产出 SurfaceEdit 与源/可见消息计数，不改写原始事件
        |
        v
 Prompt 组装（xharness-prompt/v1）：Preset、权限、Workspace、Workflow、Plan
   - Section 与 Assembly Hash 写入 request/header
        |
        v
 Token Guard（xharness-token）：System + Messages + Tool Schema + 模板 + 输出预留
   - 成功：request/header.options.tokenBudget
   - 超预算：本地结构化失败或转压缩，不发网络请求
        |
        v
 Prepared Provider Call（Provider、协议、Generation Ceiling 已固定）
        |
        v
 SSE：assistant/chunk -> assistant/message -> Usage
        |
        v
 Assistant 事件持久化（之后才可被下一次投影读取）
```

压力路径：达到阈值或 Provider Overflow 时，Core 通过 Durable Session 事务写入摘要头部、
重新计量并重试；重启后压缩结果仍是权威 Surface，原始事件不删除。

## 图 6：工具执行管线

每次 `ToolExecutor::execute` 绑定一个 `execution_id`；持久 Tool Call 已落账时调用方必须传入该
Durable ID，它原样进入 Middleware、Approval、Handler、Observer 和最终 Result。

```text
 模型 Tool Call（tool/call 已落账，outcome 未定）
        |
        v
 查找 -> 解析 JSON Object -> 旧历史投影兼容检查（write/edit）-> Schema 校验
        |
        v
 pre middleware
        |
        v
 单调 guard：allow -> ask -> deny（只能收紧，禁止放宽）
        |
        v
 fail-closed approval（缺失/出错/Panic/超时/取消一律拒绝；按 Execution ID 关联）
        |
        v
 并发 gate（Parallel / Keyed / Exclusive，默认 Exclusive）
        |
        v
 host lifecycle started ack（失败或 Panic 必须阻止 Handler）
        |
        v
 around middleware -> handler -> post middleware -> finalize middleware
        |
        v
 observer -> ToolResult（失败也是值，不允许 Loop Panic）
        |
        v
 持久 Tool Result 与模型重放保持原调用顺序（与完成顺序解耦）
```

`ToolBatchRun` 是多调用唯一正式调度器：按模型原始顺序解释 Barrier、限制总并发、按真实完成
顺序发布事件、按原始 `order` 返回结果。Core/Agent 不得复制这些调度规则。

模型可见工具面按 Step 裁剪，稳定名称不等于每轮全量发送：

```text
 Coding Bundle（11）：bash job_output job_list job_kill read write edit glob grep
                         web_search web_fetch
 交互层（+1）：ask_user_question（Exclusive + External Settlement + Standalone Batch）
 Host 只读：history（绑定当前 session，只读证据）
 父会话委托：agent（子会话禁止再次委托）
 Goal 轮次：goal（create/get/update/pause/resume/report）
 可选能力：computer、plugin_mcp、plugin_skill（按平台、权限与部署注册）
 实际工具集以当前 Step 的 registry/schema 为准，不声明固定最大数量
```

生产模型注册表已移除 `automation`，系统与 Shell 提示也不再引导调用它。已有计划及原生
UI/RPC 控制仍保留，不等于模型可以创建未来调度。Process 不可用时仍保留 Job 控制器。

## 图 7：原生执行与沙箱分层

操作系统分支被限制在平台层；权限默认拒绝。

```text
 模型工具：bash / read / write / edit / glob / grep
        |
        v
 xharness-coding-tools（工具语义：超时、输出上限、后台 Job 交接）
        |
        v
 xharness-fs（工作区文件系统） + xharness-process（进程运行时）
        |
        v
 xharness-platform（权限门面：编译期选择后端，OS 分支到此为止）
        |
        +-- sandboxed（read-only / workspace-write）
        |     +--> macOS Seatbelt
        |     +--> Linux Bubblewrap
        |     （受限 Backend Probe 失败必须 fail closed）
        |
        +-- FullAccess（无 Sandbox Adapter，必须由操作者显式选择；
                        仍经 ProcessRuntime 托管进程生命周期）

 独立服务（不是“一次性 Bash 的长时间版本”）：
 - Process Group：生命周期机制，硬后代隔离属于原生 Sandbox
 - xharness-jobs：后台 Job 五态注册表，Owner 隔离、增量输出、Shutdown
 - xharness-terminal / xharness-web-terminal：owner-scoped 持久 PTY，不在默认模型工具面
```

## 图 8：持久化真源、恢复与投影

Session 事件日志是唯一真源；Snapshot 只能是缓存。

```text
 写入侧（唯一真源）
   Core / Agent 提交 SessionEvent
        |
        v
   xharness-session：CAS Revision + 单调 Sequence + Transcript 投影
        |
        v
   xharness-session-jsonl：JSONL Store（首个持久 Backend）
        |
        v
   崩溃恢复：Call 无 Result => outcome_unknown，禁止自动重放

 读取侧（投影，不是真源）
   Store::list_headers（启动枚举）
        |
        v
   重建 Session / History / 模型路由 / Workspace 归属 / Pending Queue
        |
        v
   纯投影函数（实时与恢复共用）──> Web 投影 / 事件帧

 所有权：xharness-agent LeaseManager
 - MemoryLeaseManager：仅进程内测试语义
 - FileLeaseManager：独立锁文件 + OS Advisory Lock（当前只承诺单机文件系统）
```

## 图 9：Durable Inbox、Steering 与调度

长期身份与单轮执行分开：`LoopRun` 是一个有限 Turn，`Agent` 是可休眠、唤醒、取消、恢复的
身份。Agent 不保存第二份聊天历史。

```text
 Inbox（每 Agent 两个有序列表，全部变更记为 agent/inbox/spliced）
   next-turn：普通 Follow-up，每条独占一个后续 Turn
   next-step：Steering / 动态上下文，在最近安全 Step 边界一次性领取
        |
        v
 DispatchState（xharness-agent）：从 Session + 收件箱 + 维护请求推导，不额外持久化
   - 用户主动输入可被调度
   - 被动 next-step Context 不自行启动任务
   - 关闭的自动执行门禁只允许用户输入或显式维护通过

 生命周期：Idle -> Running(turn, step) -> Idle
           Idle -> Maintenance         -> Idle
   - Turn/Step 从 Session 最后持久坐标继续，重启后禁止归零
   - 终态失败（不可重试）本身即关闭自动派发，不靠错误文本匹配

 Steering 观察器（正式 Durable Runtime）：
   投递前订阅事件 -> 以原输入 ID 保存观察器 -> Host FIFO 只追踪观察器
   - 旧轮已消费：观察器通过日志结算旧轮
   - 旧轮已关闭：跟踪新轮
   - 两条路径都不得重新追加或重放输入
```

## 图 10：Host 受管纯决策模块

`config/architecture-host-modules.json` 中每个受管模块声明唯一状态责任、集成入口、允许的
直接消费者和内部 crate 依赖；`scripts/regression/check-architecture.py` 做增量边界检查。
同一检查器另维护 30 条 source-level seam（`SOURCE_BOUNDARIES`），覆盖已完成分段抽取、
不得再获得传输/Host 耦合的 processor。

```text
 id            源文件                    RPC 入口               允许的直接消费者
 ───────────────────────────────────────────────────────────────────────────────
 credentials   credential_processor.rs rpc/credentials.rs      -
 goals         goal_processor.rs       rpc/goal.rs             bootstrap.rs
 models        model_processor.rs      rpc/model.rs            -
 presets       preset_processor.rs     rpc/preset.rs           -
 sessions      session_processor.rs    rpc/session.rs          -
 settings      settings_processor.rs   rpc/settings.rs         control.rs
 subagents     subagent_processor.rs   rpc/subagent.rs         -
 workspaces    workspace_processor.rs  rpc/workspace.rs        -
 swarms        swarm_processor.rs      rpc/swarm.rs            swarm_tasks.rs,
                                                              swarm_tasks/access.rs,
                                                              swarm_tasks/service.rs
```

新跨界引用必须先审查责任和策略，而不是在 `rpc.rs` 或 `BasicHost` 里平行复制状态逻辑。
每个受管模块还必须无条件声明 `#![forbid(unsafe_code)]`，并继承模块级 `deny` 与测试外
`forbid` 的可恢复错误约束（见 `AGENTS.md`）。

## 图与规范的对应

| 图 | 主要依据 |
|---|---|
| 图 1 Workspace 分层 | 各 crate 的 `Cargo.toml`、[全局不变量](../architecture.md#全局不变量) |
| 图 2 部署与进程 | [总体架构](../architecture.md#分层结构)、[Host 规范](../specs/host.md) |
| 图 3 线协议分发 | [Web 线协议](../specs/api.md)、`crates/xharness-host/src/rpc.rs` |
| 图 4 Turn 生命周期 | [核心 Agent Loop](../specs/core-loop.md)、[长生命周期 Agent](../specs/agent.md) |
| 图 5 上下文与预算 | [上下文预算](../specs/context.md)、[压缩](../specs/compaction.md) |
| 图 6 工具管线 | [工具注册与执行管线](../specs/tools.md)、[标准 11 工具包](../specs/coding-tools.md) |
| 图 7 原生执行 | [平台门面](../specs/platform.md)、[原生沙箱](../specs/sandbox.md)、[子进程运行时](../specs/process.md) |
| 图 8 持久化与恢复 | [事件溯源 Session](../specs/session.md)、[JSONL 存储](../specs/session-jsonl.md) |
| 图 9 Inbox 与调度 | [长生命周期 Agent](../specs/agent.md)、[GoalController](../specs/goal-controller.md) |
| 图 10 受管 Host 模块 | `config/architecture-host-modules.json`、[稳定化冻结](../specs/stabilization-freeze.md) |
