# GoalController：复用现有 Runtime 的持续目标推进

- 状态：**契约、持久 Runtime、Host 控制、报告工具、必要依赖与现有 UI 已接通；待跨平台分支 CI、合并发布和安装验收**。
- 日期：2026-09-10。
- 代码核对基线：`64635a4`（含执行检查点），其上游基线为 `ee02f5d`。
- 核心决定：**外层只观察目标、判断状态、推进任务；内层继续使用现有 Agent Runtime 和 Loop。**
- 本文不授权创建真实目标、执行后台任务、修改权限或部署软件。

当前实现范围见 [`xharness-goal` 契约说明](../../crates/xharness-goal/README.md)。已落地的事件和事务边界见 [Runtime 实施说明](goal-runtime.md)，真实结果见 [实验报告](../evaluations/goal-multi-round-20260910.md)。下文保留原设计依据；当前产品协议、用户控制语义和验收结果以 Runtime 实施说明为准。

## 1. 目标与非目标

Goal 是绑定当前会话的持久目标，不是另一个 Agent，不是 TODO 列表，也不是无限次发送“继续”的脚本。

用户示例：

> 完成 Windows 后台进程清理。正常退出、取消和异常退出都不能遗留子进程，相关测试通过，其他平台不能回归。

外层需要回答的只有：

1. 目标是否仍有效、是否允许推进？
2. 上一轮之后是继续、等待，还是目标已完成？
3. 若继续，向现有 Runtime 提交哪一条有明确来源的执行请求？

不在本模块实现 Provider 调用、工具调度、上下文压缩、重试、沙箱、审批、PTY、子 Agent 或第二套消息队列。默认不配置外层评审模型。外层的“判断”主要是确定性状态判断；任务语义由正在执行的 Agent 报告，验收由既有测试证据或用户确认承担。

## 2. 当前代码基线：复用而不是推倒重写

| 已有能力 | 代码位置（仓库相对路径） | 当前范围 / 本次复用 |
| --- | --- | --- |
| Goal DTO / 事件 | `crates/xharness-session/src/event.rs` | `GoalSnapshot`、`GoalChange`、四种 phase、revision、rounds；已有 v1 全快照与 clear tombstone |
| Goal 生命周期校验 | `crates/xharness-session/src/session.rs` | 创建、编辑、暂停、恢复、完成、阻塞迁移；**尚不能直接用现有 v1 快照任意递增 rounds** |
| Goal RPC | `crates/xharness-host/src/rpc.rs` | create/edit/pause/resume/complete/clear，Admission Fence、Receipt、CAS 和 Flush |
| Goal 恢复 / UI 投影 | `crates/xharness-host/src/restore.rs`、`state.rs` | 从 Session 日志恢复并投影当前 Goal；内存不是真源 |
| 持久队列 | `crates/xharness-agent/src/inbox.rs` | `DurableInbox`、稳定输入 ID、`PreparedClaim`；claim 删除必须与 turn/start 原子提交 |
| 执行驱动 | `crates/xharness-agent/src/driver.rs` | `TurnRequestFactory`、`AgentEvent::TurnStarted/TurnFinished`、取消和关闭 |
| 激活所有权 | `crates/xharness-agent/src/activation.rs`、`lease.rs` | Agent Registry 与单写者租约 |
| Host Runtime 接口 | `crates/xharness-host/src/runtime.rs` | `AgentRuntime`、`DurableLoopAgentRuntime` |
| 执行检查点 | `crates/xharness-core/src/checkpoint.rs` | 同一轮内阶段提醒与精确重复观察；不负责 Goal 完成判断 |

`DONE-33` 表示 Goal 管理状态已持久化，**不等于自动推进功能已完成**。当前 `maxGoalRounds` 默认 256 是现有兼容配置，不是已验证最优值。

## 3. 分层与依赖

```text
Web / Tauri / API
        │ 复用 Goal RPC
        ▼
xharness-host：鉴权、控制命令、投影、组合
        │
        ├── GoalController：观察 → 判断 → 提交推进意图
        │         │
        │         └── 同一份 Session 日志、Admission Fence
        ▼
现有 Agent Runtime：持久 Inbox、单写者、Turn 生命周期
        ▼
LoopEngine：模型步骤、Context、Tools、执行检查点
        ▼
Provider / Tools / Platform
```

建议新增 `xharness-goal` crate，保存纯状态归约、决策函数和少量端口定义。它不依赖 `xharness-host`、UI、具体 Provider 或 OS；Host 实现端口并组装 Controller。现有 Goal 真源类型仍在 Session，不能复制出第二份权威 Goal 数据结构。

默认与 Host 同进程、同仓库维护。以后服务器常驻部署复用同一模块；独立进程只替换通信适配，不另造执行系统。跨机器所有权不是本机文件锁能够解决的，分布式服务属于独立部署设计。

## 4. 数据模型：目标定义、状态、执行记录分开

### 4.1 目标定义

保留现有 `id / objective / phase / revision / blockedReason / maxGoalRounds`，设计增加：

- `definition_revision`：目标内容、约束或验收条件修改时递增；进展更新和轮次记账不改变它。
- `acceptance_criteria`：用户可填写的验收条件；没有独立填写时，以 objective 中的条件为准，不凭空追加要求。
- `verification_mode`：`agent_report` 或 `user_confirm`，默认 `agent_report`；自动检查器作为可选适配，不增加评审模型。
- `execution_enabled`：是否授权跨轮自动推进。旧版本迁移默认为 false；用户明确启用后才能产生后台续轮。

`revision` 继续承担整份状态 CAS；`definition_revision` 用于拒绝过期目标的完成声明。两者不能混用，否则每次轮次计数都可能令合法报告过期。

### 4.2 运行投影

- 最新报告：进展摘要、未完成事项、阻塞原因、证据引用。
- 最新关联轮次 / 输入 ID / 报告来源工具调用 ID。
- 一个待执行推进意图（最多一个）和是否正在执行。
- `rounds_started`、预算使用、暂停原因。
- 可选待确认完成声明。

运行投影从 Session 事件折叠，可缓存，不引入另一份 JSON 真源。不要把 AGENT.md 当锁或状态数据库；需要文件说明时可导出只读摘要。

### 4.3 轮次与步骤

- Step：一次模型步骤，归 Loop 管。
- Turn：一次现有 Runtime 执行。
- Goal Round：由 Controller 提交并成功开始的、带 Goal 关联的 Turn。

仅 Goal-owned Turn 计入 `rounds_started`；普通用户 Turn 不偷占自动续轮次数。入队未开始不计数，网络重试不另计一次，开始后失败也不能退回计数。若未来增加 token / 时间预算，必须单独明确归属，不能用 steps 或字符数代替。

## 5. 外层状态与纯决策

继续沿用 `active / paused / blocked / complete`。`waiting` 和 `verifying` 是运行投影，不必都升级为持久 Goal phase。

```text
观察当前 Goal + Session cut + Runtime 状态
    ├─ Goal 不存在 / 未启用 / paused / complete → Idle
    ├─ 当前 Turn 运行中 → Wait(runtime_busy)
    ├─ 有用户输入 / Steering 待处理 → Wait(user_priority)
    ├─ 等待审批 / 必要问题 / 必要依赖 → Wait(reason)
    ├─ 达到硬预算 → Pause(budget_exhausted)
    ├─ 有有效完成声明 → 验收 → Complete 或 Wait/Continue
    ├─ 确实需要外部输入 → Block(reason)
    └─ active 且可推进 → Continue(intent)
```

概念接口（不是现有 Rust API）：

```rust
fn decide(observation: &GoalObservation) -> GoalDecision;

// GoalDecision:
// Idle | Wait(reason) | Continue(intent)
//      | Pause(reason) | Block(reason) | Complete(evidence)
```

`decide` 不调用模型、不执行工具、不读取实时文件。Observation 是一致性 Session cut 上的事实。提交前仍需重新校验；一次决策不是永久执行许可。

## 6. 推进机制：事件唤醒 + 幂等核对

### 6.1 唤醒来源

创建/恢复目标、TurnFinished、必要依赖完成、审批/问题已解决、Goal 编辑、Host 重启、租约重新获得时触发 reconcile。

事件回调是及时唤醒渠道，**Session 日志是事实渠道**。允许有低频状态核对用于修复丢失通知，但它只核对元数据，不能定时无条件发起模型请求。

### 6.2 稳定推进 ID

示意：

```text
(goal_id, definition_revision, activation_epoch, cause)
cause = Initial | AfterTurn(turn_id) | DependencyResolved(event_seq)
```

`activation_epoch` 在用户显式重新激活时变更，避免暂停后恢复无法重新排队。以上字段经过固定编码派生稳定 `intent_id`；不能每次 reconcile 都生成随机输入 ID。

同一激活下最多一个未领取的 Goal 推进意图。重复回调、服务重启、RPC 重试只能返回同一份收据。

### 6.3 入队与领取的两个原子边界

1. 在现有单会话 Admission Fence 内读取最新 cut，校验 active、版本、租约、无同 ID / 其他待执行 Goal intent。
2. **同一次 Session CAS append** 写入推进意图事件与现有 Inbox 插入事件，Flush 后再发布 UI。
3. Runtime 领取前再次检查：用户消息优先、目标仍有效、未暂停、未耗尽预算、版本未过期。
4. **同一次 CAS append** 写入 Inbox 删除/claim、turn/start、Goal round-start 关联及 rounds 增量。
5. CAS 冲突从新 cut 重算；不能“队列先插入、Goal 状态后补记”。

这要求在现有 DurableInbox / Agent Driver 上补一个有限的事务扩展点。不要让 GoalController 直接拼接队列内部索引，也不能把下一轮作为普通用户输入混入同一个批量 claim。

若 claim 遇到普通用户输入，先执行用户输入；待处理 Goal intent 延后或作废重算。Goal source 必须带类型，不靠消息文字识别。

## 7. 内层报告：最多一个模型工具

复用 Tool Registry，设计一个 `goal` 工具，仅在会话有有效 Goal 且允许报告时暴露。它不创建新 Goal、不改目标、不给自己加预算，也不决定何时启动新 Loop。

示意参数：

```json
{
  "action": "report",
  "definition_revision": 2,
  "status": "progress",
  "summary": "已修复正常退出清理，异常退出测试仍失败",
  "remaining": ["排查异常退出残留进程"],
  "evidence": [{"kind": "tool_result", "ref": "execution-id"}]
}
```

`status` 为 `progress | blocked | complete`。blocked 需要明确缺失信息/依赖；complete 需要完成说明。证据可以来自工具结果、测试报告或产物，但引用存在不代表证明充分。

Host 绑定 goal_id、session_id、turn_id、tool execution_id；这些身份不能由模型任意指定。报告按工具执行 ID 幂等持久化，ACK 只表示“已记录”，**不表示 Goal 已完成**。

模型在工作自然节点报告即可，不要求每个工具结果都调用一次。普通最终文本不做字符串关键词解析；没有报告时，第一次续轮提示内层明确确认目标状态。

为防止不支持该报告协议的模型反复空答：协议兜底阈值暂定为连续 3 个 Goal-owned Turn（可配置，需真实模型测试校准）；这些轮次既无有效报告，也无工具执行的终态事实时，暂停为 `report_protocol_stalled`，向用户说明可换模型/恢复；这是控制协议兜底，不声称可以判断所有语义上的无进展。错误/成功重复调用仍由现有精确重复提醒处理，不增加外层语义裁判。

## 8. 完成、阻塞和依赖

### 8.1 Turn 完成不等于 Goal 完成

模型给出最终回答，只触发下一次 reconcile。模型工具报告 complete 也不能在当前 Turn 还没收尾时停止/杀死正在执行的工具。

Controller 等待 Runtime 正常结算后，检查：

- 报告来自当前目标定义和有效轮次。
- 报告之后没有目标修改或使其失效的新事实。
- 没有未收尾的 Goal 关联审批、必要问题、必要 Job / 子 Agent。
- agent_report 模式：接受有说明的模型完成声明并保留证据，UI 明确它不是独立形式化证明。
- user_confirm 模式：进入待确认投影，由用户通过现有完成接口确认。
- 若配置确定性检查器：执行必须走现有 Runtime/Tools 和权限边界，不能让外层直接 shell 执行模型给的命令。失败作为事实交给内层继续处理。

不要求全会话所有 Job 都结束才能完成 Goal；只跟踪与该目标有关且明确必要的依赖。无关后台服务不能永久卡住目标。Goal 终态前，对其创建的活动依赖必须明确完成、取消或经用户授权转交管理，不能遗留无人负责的任务。

### 8.2 等待不等于阻塞

- 工具仍运行、正在正常重试、审批待答：等待已有事件，不新增模型轮次。
- 需要用户提供地址、凭据配置、产品决定：可以进入 blocked，显示明确解阻动作。
- 网络失败：优先使用现有 Provider 恢复机制；恢复预算耗尽后暂停为 execution_error，不能外层立刻新开一轮绕过截止时间。
- `limit_reached` / `max_tokens`：显示执行限额并暂停，不当作普通 Completed 自动重启以规避内层硬限制。
- 自发结束但没有完成声明、且无上述硬错误：可以继续目标下一轮。

依赖完成事件只唤醒核对；用户已经暂停的 Goal 不会因此被自动恢复。

## 9. 上下文注入

每个 Provider 请求包含一份当前 Goal 的短快照：目标、验收条件、最新有效进展、必要阻塞/依赖。它来自持久状态，不是每步向历史追加一条 user/message。

接在 ContextPolicy 之后、Token Guard 之前；固定 system prompt 不修改，使用明确标记的 Harness 控制上下文，沿用执行检查点的兼容思路。

- 完整目标和验收条件不得静默摘要；超预算走现有 compact / budget guard，失败可见。
- 过程报告在 durable log 保留完整记录，模型快照只保留最新有效报告，旧报告仍可通过历史获得。
- 目标没有变化时保持序列化稳定，不插入每步变化的时钟、计数和随机 ID。
- Goal 快照、阶段提醒、重复提醒由统一的控制上下文组装位置合并/排序，避免创建另一条绕开计量的注入路径。
- 当前请求启动后收到的目标修改，只能在下一安全边界生效；不假装修改已经发出的请求。

## 10. 用户控制与竞态语义

| 操作 | 语义 |
| --- | --- |
| 创建并启动 | 明确授权后启用 Goal，现有会话空闲时提交首次 Goal round |
| 暂停目标 | 持久化 paused，禁止新自动轮次；当前已启动 Turn 允许收尾。UI 必须写明“当前轮仍在执行” |
| 停止当前执行 | 复用 Runtime Cancel；若为 Goal-owned Turn，同时暂停 Goal，避免刚停止又被拉起 |
| 恢复目标 | 用户显式授权，增加激活 epoch，核对预算和事实后决定继续；不重放旧的未知结果工具 |
| 编辑目标 | 增加定义版本，作废未领取的旧 intent；已发生副作用不回滚，旧完成报告不能完成新目标 |
| 清除目标 | 保存 tombstone，清除待执行 Goal intent；不等于删除聊天记录，也不隐式回滚/杀死当前 Turn |
| 普通用户消息 | 优先进入现有队列，保留其用户来源；处理完后再核对 Goal |

暂停、编辑、恢复、清除和 enqueue/claim 共用 Admission Fence。租约/修订号检查必须在提交边界发生。工具已启动的副作用不能靠改 Goal phase“撤销”。

## 11. 预算与执行检查点

保留现有 `maxGoalRounds` 兼容语义，不在本次顺手换成另一个隐式默认。每次 Goal-owned Turn 成功开始后递增；耗尽后 phase=paused，并显示 pause reason，而非 complete 或 blockedReason。

用户可显式调整额度后恢复；模型和阶段检查点都不能增加 Goal 硬额度。

执行检查点只管同一 Turn 内的长步骤提醒。GoalController 只在 Turn 边界安排任务。两者共用提醒投影，但不能互相改限额、互相启动 Loop。

## 12. 持久事件和兼容方案

采用显式 version 2 的 Goal 生命周期记录扩展，保留 v1 读取：

- v2 `goal/change` 扩展目标定义、执行授权、暂停原因，并增加明确的 round-start 操作。
- round-start 全快照携带新的 rounds_started；必须与对应 turn/start 和 Inbox claim 同批提交，恰好 +1，不能跳号。
- 新 `goal/continuation` 记录 intent 的入队、作废及其来源；与 Inbox 事务配对校验。
- 新 `goal/report` 保存内层报告及身份、证据引用；不修改用户目标定义。
- Goal Round 的结束结果引用现有 turn/end，不复制第二套可矛盾的执行终态。

实现前必须同时更新 Event DTO、Session 生命周期校验、restore、实时投影、历史投影、RPC schema 和契约测试，不能仅添加枚举分支就称完成。

迁移规则：

1. v1 历史原样读取，不重写整份会话。
2. 旧 active Goal 恢复成“已保存、尚未启用自动推进”，不能升级后突然执行。
3. 用户启用时写入合法 v2 转换事件，保留 rounds_started 与目标 ID；不能伪造一次 Create 清零预算。
4. 降级旧二进制前必须恢复升级前备份或经过显式迁移；旧 reader 未识别 v2 时明确报错，不静默跳过控制事件。

## 13. 最小端口与恢复

概念边界，不强行另起 Runtime 类：

```text
GoalStoreView.read_cut(session_id) -> GoalObservation
GoalController.decide(observation) -> GoalDecision
GoalRuntimePort.submit(decision, expected_revision) -> Receipt | Conflict
```

`submit` 由 Host/Agent 适配层实现，复用 Session Store、Admission Fence、DurableInbox 和 Runtime 激活。

恢复核对：

| 崩溃位置 | 恢复结果 |
| --- | --- |
| intent 尚未提交 | 可以重新判断、提交 |
| intent 与 Inbox 已提交、尚未领取 | 恢复同一输入，不重复插入 |
| claim 已提交、运行尚未完成 | 遵循现有 Turn 恢复；未知副作用不可自动重放 |
| turn/end 已提交、通知未发出 | 从日志重新 reconcile，不依赖丢失回调 |
| complete 已提交、UI 未收到 | 投影恢复为 complete，不再启动 |
| 等待用户、用户关了弹窗 | 保留待答/取消事实，不将关闭视为回答 |

外层不承诺副作用 exactly-once。可以保证意图和开始记账的幂等；实际工具中断仍必须保留 outcome_unknown。

## 14. UI 与观测

复用现有 Goal 卡片/投影，不建立与事件历史分离的前端状态机。卡片展示：目标、验收条件、phase、运行/等待原因、最新进展、额度及暂停/恢复/停止当前执行/完成确认。

需要区分：

- 目标 active，但正在等待依赖。
- 目标 paused，但当前 Turn 尚在收尾。
- 已记录完成声明，尚未验收。
- Goal complete 与普通 Turn completed。

审计事件记录 intent_id、goal/definition revision、cause、turn_id、提交结果和等待原因。Debug 沿用现有 recorder；普通模式只记录状态变化，不在每次无变化核对时刷日志。

## 15. 测试与验收门禁

### 状态与纯决策

- 各 phase、未授权旧 Goal、预算、用户优先、忙碌、审批、问题、依赖、完成声明的决策矩阵。
- 有效进展继续；最终文本不等于完成；报告缺失协议兜底；显式 hard limit 不被自动续轮绕过。
- 无关 Job 不阻塞完成；同目标必要依赖不能被忽略。

### 并发与事务

- 重复 TurnFinished / reconcile / RPC 重试只产生一个 intent。
- Pause/Edit/Clear 与 enqueue/claim 竞争，不会启动旧版本或暂停后的新轮次。
- CAS 冲突重算、租约竞争、两个 Host 争夺同会话、用户输入与 Goal claim 竞争。
- round 计数只随成功 start 恰好 +1；排队取消、重试、恢复不偷增/清零。

### 崩溃与历史

- 在每个 append/flush/claim/turn-end 边界注入失败；重启后队列、Goal 和历史一致。
- 有副作用但缺结果的工具不会自动重放；收据存在但响应丢失可以恢复。
- v1/v2 混合读取、旧 active 不自启动、tombstone、防止旧报告复活清除目标。

### 模型与 UI

- Fake Provider：多轮推进、progress/blocked/complete、无报告、旧版本报告、重复报告、坏参数、失败/取消。
- Token Guard 覆盖 Goal 快照；Compact/切模型后目标仍在且仅一份；固定 system 不变。
- Chromium/WebKit：实时/刷新/分页/重启一致；暂停当前仍执行的文案、完成确认及错误恢复。
- 真实 DeepSeek：临时工作区中的跨轮编程任务，独立测试验收；必须观察至少一次自动 Goal 续轮，而非仅跨执行检查点。注入失败、缺依赖及目标修改场景，不触碰用户现有任务。
- Rust 全量测试/Clippy 在 WZU_Server，Mac/Windows/Linux CI；不得本机编译 Rust。

## 16. 实施拆分与完成条件

1. `GOAL-01`：本设计与 TODO，确认外层职责和 API 契约。
2. `GOAL-02`：v2 状态、事件 reducer、旧历史迁移与校验。
3. `GOAL-03`：纯 Controller 与 Runtime 事务适配，入队/claim 去重和用户优先。
4. `GOAL-04`：模型报告、临时上下文快照、完成/阻塞决策。
5. `GOAL-05`：用户控制竞态、依赖唤醒与崩溃恢复。
6. `GOAL-06`：UI 共享投影、观测、文案与浏览器测试。
7. `GOAL-07`：远程回归、故障注入、真实模型验收和跨平台 CI。
8. `GOAL-08`：评审合并、发布与已安装实例升级/数据保留验收。

文档完成不等于功能已上线；每项只有实现、测试、规范和用户可见行为一致后才勾选。

## 17. 参考边界

Codex 官方文档确认 Goal 是对话中的持久目标，可跨轮次工作并暂停/恢复，强调可验证停止条件；没有据此断言其内部采用本文的类名、独立评审模型或事务算法。

- [Follow a goal](https://learn.chatgpt.com/use-cases/follow-goals)
- [Developer commands：/goal](https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- 本仓库 [执行检查点](execution-checkpoints.md)、[总体架构](../architecture.md)、[总任务清单](../TODO.md)。
