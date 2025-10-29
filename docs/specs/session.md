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

v1 Log 覆盖 Durable Agent Inbox Splice、Turn Start/End、Step Start/End、User Message、Request
Header、Assistant Chunk、完整 Assistant Message、Tool Call、Tool Result 和 End-seed Metadata。Tool 原始参数 JSON
必须保留。Provider 可见值放在 Request/Message 事件中；审批 UI 事件不能变成模型消息。

## 生命周期校验

Restore 和 Append 必须校验 Turn/Step 嵌套、坐标一致、消息角色、Assistant 与 Tool Call
镜像、Call 唯一、每个 Call 恰好一个 Result，以及合法终止边界。非法批次必须整体原子
拒绝，并报告违反生命周期的 Sequence。

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

- Durable Inbox Event、Claim Batch 和本机 Lease 位于 `xharness-agent`；Host 尚未完成迁移。
- 尚无 Branch、Compaction Surface、Attachment Store 或远程 Multi-writer Fencing。
- Message Content 仍以文本为主，尚无强类型多模态 Block。
- Query Index 和二级投影不属于本 Crate。

## 验收标准

测试必须覆盖每种事件的序列化、连续 Seq/Revision、过期 CAS 原子性、生命周期拒绝、
消息投影、Tool 配对、Outcome-unknown 恢复、Store 值隔离和并发内存 Writer。
未来 Compaction 测试必须证明原始导出逐字不变、Surface 可确定性重建、Tool Call/Result 配对
不丢失，并能从压缩前 Revision 分叉。
