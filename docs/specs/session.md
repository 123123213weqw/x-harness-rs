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

当前强类型 Log 覆盖冻结目录中的 22 个事件：

- Agent/权限控制面：`agent-preset/selected`、`agent/inbox/spliced`、`permission/preset`、
  `sandbox/mode`、`approval/policy`；
- 审批和命令审计：`approval/asked`、`approval/decided`、`command/run`、`command/done`；
- Provider 生命周期：`request/header`、`llm/retry`、`llm/retry-started`、`assistant/chunk`、
  `assistant/message`；
- Turn/Step 和工具：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、
  `tool/call`、`tool/result`、`session/end-seed`。

Tool 原始参数 JSON 必须保留。Provider 可见值只放在 Request/Message 事件中；权限、审批、命令
和重试审计事件永远不能变成模型消息。Session 创建在返回 Receipt 前原子写入 Agent Preset、
Permission Preset、Sandbox Mode 与 Approval Policy；`/permission` 使用
`command/run → policy events → command/done` 的固定顺序。

## 生命周期校验

Restore 和 Append 必须校验 Turn/Step 嵌套、坐标一致、消息角色、Assistant 与 Tool Call
镜像、Call 唯一、每个 Call 恰好一个 Result，以及合法终止边界。非法批次必须整体原子
拒绝，并报告违反生命周期的 Sequence。

Approval ID 与 Command ID 必须分别唯一并严格一问一答/一开一闭。成功的 `command/done` 可以用
`sourceEventSeq` 引用此前的非 Command 事件；错误结果不能伪造这个引用。Provider Retry 使用稳定
Retry ID 串联 Scheduled/Started 边界。策略枚举采用封闭词汇，Full access 在线协议中的 Sandbox
Mode 固定为 `danger-full-access`。

## 投影与恢复

`derive_messages()` 必须确定、无副作用。它忽略只用于审计的 Chunk 和边界，同时逐字节
保留完整 User、Assistant 和 Tool Message。

完整 Transcript 与“下一次模型可见 Surface”必须分离。Context Policy 可以引用原始消息、
追加 Summary/Spill Metadata 或选择 Surface Replace，但禁止覆盖/删除原始 Tool Result。
Request Header 必须记录本次实际使用的消息 Revision、压缩 Policy Version 和预算分项，确保
诊断时能解释为何模型看到的是某个子集。

已经持久化但没有权威 Result 的 Tool Call 属于未完成。恢复可以追加标准化
`outcome_unknown` Tool Result，但禁止执行该 Call。非幂等操作再次尝试前，Host 应先
检查外部状态。

## Store Trait

`Store::{create, load, append, flush, inspect}` 定义隔离值和 CAS Append 语义。`flush`
是由具体 Backend 定义的持久化屏障。`MemorySessionStore` 仅提供进程内测试/嵌入语义，
不是持久存储。

## 当前限制

- Durable Inbox Event、Claim Batch 和本机 Lease 已由 `xharness-agent` 接入 Host；但 Workspace、
  Settings、Pending Approval、通用 Mutation Receipt 仍没有统一持久控制面。
- 尚无 Branch、Compaction Surface、Attachment Store 或远程 Multi-writer Fencing。
- Message Content 仍以文本为主，尚无强类型多模态 Block。
- Query Index 和二级投影不属于本 Crate。

## 验收标准

测试必须覆盖每种事件的序列化、连续 Seq/Revision、过期 CAS 原子性、生命周期拒绝、
消息投影、Tool/Approval/Command/Retry 配对、Outcome-unknown 恢复、Store 值隔离和并发 Writer。
Host 还必须证明并发同 ID `session.create` 不能越过初始事件的 Flush Barrier。
未来 Compaction 测试必须证明原始导出逐字不变、Surface 可确定性重建、Tool Call/Result 配对
不丢失，并能从压缩前 Revision 分叉。
