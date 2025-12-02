# 事件溯源 Session 规范

**Crate：** `xharness-session`
**状态：** v1 事件词汇和内存 CAS Store 已实现。

## 目标

为模型可见历史和崩溃恢复提供 Provider-neutral 的唯一真源。一个 `Session` 由不可变
Header 和有序 append-only Log 组成；派生消息必须是纯投影。

## 身份与顺序

- Session 只有一个不可变 `SessionHeader` 和格式版本。
- 每个 `LoggedEvent` 的 `seq` 从 0 开始连续递增。
- 每次非空原子 Append 只能让 `Revision` 增加一次。
- `append_batch_at(expected_revision, events)` 必须全有或全无。
- Expected Revision 过期时必须返回冲突，不得产生任何修改。

## 事件词汇

当前强类型 Log 覆盖冻结目录中的 29 个事件：

- Agent/权限控制面：`agent-preset/selected`、`agent/inbox/spliced`、`permission/preset`、
  `sandbox/mode`、`approval/policy`；
- 审批和命令审计：`approval/asked`、`approval/decided`、`command/run`、`command/done`；
- Session 元数据：`session/title`（latest-wins、log-only，不进入模型历史）；
- Host 内部控制事实：`session/model-selected`（latest-wins 模型路由）与
  `xharness/mutation-committed`（Exactly-once RPC Receipt）；两者不进入模型历史，也不计入冻结的
  上游 48 Event 覆盖数；
- 长期任务：`goal/change`（version 1 全快照或递增 Revision 的 Clear Tombstone）；
- 交互模式：`plan/mode`（latest-wins、log-only，只保存 `active`，不进入模型历史）；
- Provider 生命周期：`request/header`、`llm/retry`、`llm/retry-started`、`assistant/chunk`、
  `assistant/message`；
- Context 压缩：`compaction/start`、`compaction/summary`、`compaction/end`、
  `compaction/prune`；
- Turn/Step 和工具：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、
  `tool/call`、`tool/result`、`session/end-seed`。

Tool 原始参数 JSON 必须保留。Provider 可见值只放在 Request/Message 事件中；权限、审批、命令
和重试审计事件永远不能变成模型消息。Session 创建在返回 Receipt 前原子写入 Agent Preset、
Permission Preset、Sandbox Mode 与 Approval Policy；`/permission` 使用
`command/run → policy events → command/done` 的固定顺序。

每个 `ToolCall` 同时保存 Harness Execution ID 和可选 Provider Native Call ID。Execution ID 在
Session 内全局唯一，是 `tool/result`、Approval 与审计关联键；Provider ID 只用于重建下一次
Chat/Responses 请求。旧日志没有 Provider ID 时，投影确定性回退到 Execution ID。

## 生命周期校验

Restore 和 Append 必须校验 Turn/Step 嵌套、坐标一致、消息角色、Assistant 与 Tool Call
镜像、Call 唯一、每个 Call 恰好一个 Result，以及合法终止边界。非法批次必须整体原子
拒绝，并报告违反生命周期的 Sequence。

Approval ID 与 Command ID 必须分别唯一并严格一问一答/一开一闭。成功的 `command/done` 可以用
`sourceEventSeq` 引用此前的非 Command 事件；错误结果不能伪造这个引用。Provider Retry 使用稳定
Retry ID 串联 Scheduled/Started 边界。策略枚举采用封闭词汇，Full access 在线协议中的 Sandbox
Mode 固定为 `danger-full-access`。

Goal Change 必须保持同一 ID 的 Revision 连续递增；Create 从新 ID 的 Active Revision 1 开始，
Edit 只能修改 Objective/Max Rounds，Pause/Resume/Complete/Block 必须满足 Phase 转移，Clear 保留
下一 Revision 的 Tombstone。时间不得倒退，Blocked Reason 只允许随 Blocked Phase 出现。

Plan Mode 当前只持久化已经接受的稳定状态：不存在事件等价于 `active=false`，恢复时折叠最后一条
`plan/mode`。运行中尚未到达 Pre-step 的 Pending 选择不是稳定状态，不能伪造成 `plan/mode`。

Session 级状态变更若需要 Exactly-once 语义，必须把状态事件与
`xharness/mutation-committed` 放在同一 CAS Revision；Receipt 必须是该 Revision 最后一条事件，
RPC ID 和 Receipt Revision 在 Session 内唯一，Fingerprint 为 64 位小写十六进制，Response 递归
禁止 Secret。相同 ID/Method/Fingerprint 返回已保存响应，不得再次写状态；同 ID 不同 Payload
必须冲突。`session.rename` 的动态 Sequence 由回执引用前一状态事件补回；Web History 仅保留隐藏、
脱敏的内部占位以维持连续 Cursor，不能输出 Fingerprint 或 Response。

## 投影与恢复

`derive_messages()` 必须确定、无副作用，并返回**当前模型 Surface**。普通日志没有 Replace 时
它逐字保留 User、Assistant 和 Tool Message；Checkpoint `user/message` 的 `surfaceReplace`
只遮蔽当前 Surface 中列出的源 Sequence，原事件仍完整留在 Log。`derive_surface_messages()`
额外返回每个可见消息的源 Sequence，供下一次压缩安全规划。Tool Result 投影会通过对应 `tool/call` 把内部
Execution ID 还原为 Provider Native Call ID，确保无状态协议重放关联正确。
同一 Assistant Tool Batch 的 Result 即使因崩溃恢复分多个 Append 写入，投影仍按 Assistant
中的原始 Call Index 排序，不能按恢复写盘时序改变 Provider Transcript。

完整人类 Transcript 必须从 append-origin 原事件读取，不能错误使用已经遮蔽旧节点的
`derive_messages()`；下一次模型可见 Surface 则使用后者。Compact 成功事务先 Flush Start，再把
Summary、Checkpoint Replace 和成功 End 放进同一 CAS Batch；错误 End 不改变 Surface，未闭合
Start 在恢复时补 interrupted End。任何路径都禁止覆盖/删除原始 Tool Result。
Request Header 必须记录本次实际使用的消息 Revision、压缩 Policy Version 和预算分项，确保
诊断时能解释为何模型看到的是某个子集。

已经持久化但没有权威 Result 的 Tool Call 属于未完成。恢复可以追加标准化
`outcome_unknown` Tool Result，但禁止执行该 Call。非幂等操作再次尝试前，Host 应先
检查外部状态。

唯一例外是存在同 Call ID 的未决 `approval/asked`：Asked 已 Flush、Decided 缺失证明旧进程
尚未越过审批门，`pending_tool_approvals()` 将其投影为可交互恢复项，并从普通
`outcome_unknown_recovery()` 中排除。恢复必须复用原 Approval/Execution/Provider Call ID；
Allowed-once 之后才能首次执行。已经 Decided Allowed 但 Result 缺失时仍属于 Outcome Unknown，
不得因为曾获批而重放副作用。

## Store Trait

`Store::{create, load, append, flush, inspect}` 定义隔离值和 CAS Append 语义。`flush`
是由具体 Backend 定义的持久化屏障。`MemorySessionStore` 仅提供进程内测试/嵌入语义，
不是持久存储。

## 当前限制

- Durable Inbox Event、Claim Batch、本机 Lease 和 Pending Approval 恢复已由 `xharness-agent`
  接入 Host；Workspace、Settings 和首批通用 Mutation Receipt 已由独立 `xharness-control` 持久化。
  Rename、Model Select、Preset Select 和 Goal 使用 Session 内原子 Receipt；其余 Host Mutation 与
  Credential Reference 仍待迁移。
- Plan Mode 已有 Idle 状态日志，但运行中 Pending Pre-step、带 Message/Image 的 Steering、
  Plan Prompt Section 和 `exit_plan_mode` 工具尚未实现。
- 尚无 Branch、Compaction Surface、Attachment Store 或远程 Multi-writer Fencing。
- Message Content 仍以文本为主，尚无强类型多模态 Block。
- Query Index 和二级投影不属于本 Crate。

## 验收标准

测试必须覆盖每种事件的序列化、连续 Seq/Revision、过期 CAS 原子性、生命周期拒绝、
消息投影、Tool/Approval/Command/Retry 配对、Outcome-unknown 恢复、Store 值隔离和并发 Writer。
Host 还必须证明并发同 ID `session.create` 不能越过初始事件的 Flush Barrier。
未来 Compaction 测试必须证明原始导出逐字不变、Surface 可确定性重建、Tool Call/Result 配对
不丢失，并能从压缩前 Revision 分叉。
