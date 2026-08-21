# 长生命周期 Agent 规范

**Crate：** `xharness-agent`
**状态：** Durable Inbox、原子 Claim、AgentSupervisor、多 Turn Driver、运行时 Steering、进程内
Registry、macOS/Linux 文件 Lease 与生命周期状态机已实现；正式 Host 已完成持久 Prompt Admission，
Web Projection 与重启枚举仍在迁移。
**语义参考：** DeepSeek Harness `packages/core/agent`、`packages/core/agent-loop`、
`packages/session/session-checkpoint-policy`。

## 目标

`LoopRun` 只代表一个有限 Turn；`Agent` 代表可休眠、唤醒、取消、恢复并连续处理多个 Turn 的
长期身份。Agent 不维护第二份聊天历史，Session Log 是历史和待处理输入的唯一持久真源。

Rust 实现复刻上游语义，不复刻 Cordis 插件加载器：上游 Event/Waterfall 扩展点在 Rust 中由
Trait、强类型 Registry 和显式组合承担。

## Durable Inbox

每个 Agent 拥有两个有序列表：

- `next-turn`：普通 Follow-up；每条消息独占一个后续 Turn。
- `next-step`：Steering 或动态上下文；当前 Turn 在最近的安全 Step 边界一次性领取全部消息。

每条 `InboxMessage` 必须有稳定非空 ID、User Role 内容和可选 Source。所有插入、替换、删除与
领取都记录为 `agent/inbox/spliced`。Projection 只能按 Sequence 重放这些事件产生，禁止把 Web
内存队列当作另一真源。两个列表之间也禁止重复 Message ID。

Pending Inbox 事件不进入 Provider Transcript。只有 Claim 和对应 `user/message` 一起提交后，
消息才进入 `derive_messages()`。

## 原子领取

领取必须把以下事实放入同一 CAS Append：

```text
turn/start
agent/inbox/spliced（删除 next-step，再删除至多一个 next-turn）
user/message...
```

`LoopRequest.journal_prelude` 是迁移期间的原子组合边界：Core 把 Claim Splice、`turn/start` 和新
用户输入作为一个 Revision 提交并 Flush。禁止先永久删除 Inbox，再异步启动 Turn；进程在两者
之间崩溃会丢输入。

领取顺序固定为全部 `next-step`，然后至多一个 `next-turn`。过期 Prepared Claim 必须因 Store
Revision Conflict 整体失败，不能删除更新后的队列元素。

## 生命周期

公开状态只有 `idle | running`。Maintenance 独占 Agent，但对外保持 Idle；它结束后，期间进入
Inbox 的唤醒输入才可以启动 Driver。

```text
Idle -> Running(turn, step) -> Idle
Idle -> Maintenance         -> Idle
```

同一 Agent 同时只能有一个 Driver 或 Maintenance。Turn 和 Step 从 Session 中最后持久坐标继续，
禁止重启后归零。

## 所有权与 Lease

`AgentRegistry` 对同一进程中的重复 Activate 返回同一个 `Arc<AgentActivation>`。发布新 Activation
前必须获得 `LeaseManager` 的独占 Lease。

- `MemoryLeaseManager` 只提供进程内测试语义。
- `FileLeaseManager` 使用独立锁文件和 OS Advisory Lock，适用于本机 macOS/Linux；进程退出后
  内核自动释放。

Lease 的生命周期覆盖整个 Activation。失去最后一个 `Arc` 会取消 Activation 并释放 Lease。
网络文件系统和远程多主机执行未来必须增加带 Epoch 的 Fencing Token；当前 File Lease 只承诺
单机文件系统。

## Checkpoint 与恢复

正式 Driver 必须遵守以下顺序：

1. 接受输入前，把 Inbox Insert Flush；成功返回表示已持久排队，不只是进入 Channel。
2. Provider I/O 前，Flush 完整 Request Prefix。
3. 顶层 Tool Body 前，Flush Tool Call。
4. Tool Result 完成后 Flush，再允许下一次 Provider Request。
5. 只有 Call、没有 Result 时追加 `outcome_unknown`，禁止自动重跑。
6. Cancel 当前 Turn 默认不删除 `next-turn`；显式 Clear 才记录 Cancelled Splice。

重启时从 Session 事件重建 Inbox、最后 Turn 和 Transcript。未开始领取的输入继续 Pending；已原子
领取的输入已经属于持久 Turn。开放 Turn/Step 由 Session Recovery 闭合为 Interrupted。

`DurableAgentHandle` 提供 Followup、Steer、Inject、Pause/Resume、Cancel 和工具审批控制。
Followup 在活动 Turn 期间只进入 `next-turn`；Steer 先持久插入 `next-step`，再中断模型；Inject
同样持久插入但不唤醒 Idle Agent。Core 遇到并发 Inbox Revision 时只允许吸收纯
`agent/inbox/spliced` 事件，任何其他外部 Session Writer 都会使当前 Run fail closed。

Steer 进入 `user/message` 后如果进程在删除 Pending 项之前崩溃，恢复阶段按稳定 Message ID 执行
`reconcile_consumed()`，因此不会重复交给模型。`AgentSupervisor` 保证同一进程每个 Agent 只有
一个 Worker；Worker 在没有 Pending Wake 时不持有 Provider 或 Tool Task。

正式 `xharness-host-app` 现在默认组合 `DurableLoopAgentRuntime`、`JsonlSessionStore` 和
`FileLeaseManager`。Host 启动 Turn 时，最后一条带稳定 ID 的用户消息进入 Durable Inbox；Loop
从 Session Log 派生旧历史，并把 Claim 删除、`turn/start` 和 `user/message` 写入同一 Revision。
第二个 Turn 不再依赖 Host 兼容 DTO 中携带的旧历史。

`AgentRuntime::admit_turn` 是 Web 成功回执之前的持久化屏障。`session.prompt` 把 RPC ID 写入
`AgentMessage.id`，Durable Runtime 在 `followup()` 已 Append 并 Flush 后才返回；失败时 Host
不得把消息加入成功队列或返回成功。每个预准入 Turn 在订阅 Agent 广播后再写 Inbox，并保留独立
Receiver；`AgentEvent::TurnStarted.input_ids` 公布本轮原子领取的稳定 ID，使多个已经完成或正在
排队的 Turn 仍能与各自 Web Driver 确定性关联，不以订阅时序猜测归属。

Web Queue 的 Edit/Remove 在修改内存 Projection 前先调用 Durable Inbox Replace/Remove；如果输入
已经被领取，操作结构化失败，禁止只修改 UI 造成真源分叉。当前 queued-to-steer 仍经过删除后再
发送到活动控制面，不承诺跨两次操作的崩溃原子性；后续应增加 Inbox Target 原子 Move。

## 当前限制

- Durable Inbox、Lease、Supervisor、多 Turn Driver、Active Turn Steering 和持久 HTTP
  Admission 已实现，正式 Host 的实际 Turn 已走持久 Runtime；但 `BasicHost` 仍用内存 FIFO
  附着 Web Driver、记录 Queue Projection，进程重启后还不会从 Session 目录自动恢复这些投影。
- 同一进程内重复 Admission 在 Prepared Turn 存活时按稳定 ID 幂等；重启后的重复 RPC ID 尚未
  建立持久 Receipt/Consumed 索引，不能宣称完整 Exactly-once HTTP 语义。
- Pause、Approval 与 Event Subscription 仍属于当前 `LoopRun` 控制面；尚未成为可恢复 Agent
  Activation 状态。
- 没有远程 Fencing Epoch、Scheduler、Subagent 或 Workflow。

## 验收标准

测试必须覆盖 Inbox Replay、跨列表重复 ID、Replace/Remove/Clear、领取顺序、Claim 与 Turn 同一
Revision、过期 Claim CAS 失败、Registry 身份复用、文件 Lease 互斥与释放、多 Turn FIFO、Idle
Inject、Active Steer、恢复去重和重启继续 Turn 编号。
Host 替换阶段还必须硬杀进程并覆盖：Enqueue 后未领取、Request 前、Tool Call Flush 后、Tool
Result Flush 后和 Turn End 后五个故障点，证明输入不丢且工具副作用不重复。
