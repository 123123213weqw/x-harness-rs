# Web Session 确定性投影规范

**涉及 Crate：** `xharness-session`、`xharness-agent`、`xharness-host`  
**状态：** 权威可游标 History、有界 Host 尾缓存、重启等价以及 Approval/Provider Retry
强类型投影已实现；完整冻结事件词汇仍在迁移。

Token、Cache、TTFT、Decode 吞吐和 LLM/Tool Duration 的完整日志投影由
[`metrics-projection.md`](metrics-projection.md) 单独规范；在该规范完成前，Usage 字段命名和
`tokenUsage/sessionStats` 均属于当前 Web 投影缺口。

## 真源与边界

正式 Durable Runtime 的 Append-only `Session` 是模型历史与浏览器 History 的共同真源。
`BasicHost.SessionRecord.events` 只是可丢弃的**连续尾缓存**，同时受 Event 数与序列化 Byte
预算限制；它不再承载完整 History。兼容 `LoopAgentRuntime` 没有 Session 真源，可以继续使用
旧的完整内存投影，但不得冒充可恢复语义。

`AgentRuntime` 通过以下能力显式声明这一边界：

- `has_authoritative_sessions()`：区分 Durable 与 Ephemeral Runtime；
- `authoritative_session(session_id)`：返回一个不可变、已校验的完整 Session Cut；
- Durable Runtime 必须直接从其 Store 加载，Host 禁止维护第二份模型历史。

## 投影算法

1. Host 以 `authoritative_seq` 保存下一个待发布的 Session Sequence。
2. 每次 History 查询、模型流事件和 Turn 终止时加载已验证的 Session Cut。
3. 对每个 Logged Event 产生且只产生一个 Web Session Event；Web `seq/time` 直接使用日志坐标。
4. History 用 `beforeSeq` 作为排他上界，向前扫描至 `maxMessages` 个
   `user/message | assistant/message | tool/result`，只投影该范围；`seq` 永远等于日志 Sequence。
5. 运行缓存每次替换为满足 `session_event_cache_capacity` 与
   `session_event_cache_bytes` 的最大连续后缀；超大单事件可以不驻留内存，但仍实时投递且可从日志
   查询。只把 `[authoritative_seq, next_seq)` 的新增事件推送到 Mux，避免查询或重连重复广播。
6. `user/message` 使用稳定 Message ID 连接之前的 `agent/inbox/spliced` 元数据，恢复原始
   Text/Image Content Block、Source、RPC ID 与 Timezone；旧日志缺元数据时才退化为纯文本。
7. Assistant、Tool、Turn、Step、Request Header 和 Inbox Event 均从同一个 Logged Event 生成；
   Host 不得再为 Durable Turn 人工追加另一份 `turn/start/user/message/assistant/message`。
8. Compact Checkpoint 的 `surfaceReplace` 投影为
   `surfaceOp={op:"replace",start,end}` 和 `sourceEventSeqs`；普通消息仍使用字符串
   `surfaceOp="append"`，浏览器不得把 Replace 当作人类原始聊天删除。
9. 启动尾缓存、运行增量和 History Page 必须调用同一 `restored_web_event()` 纯投影；Search 与
   Fork 在 Durable Runtime 下也必须读取权威 Session，而不是只看缓存尾部。

## 审批与模型重试

- Core 在调用审批 Answerer 前 Flush `approval/asked`，使用独立 `approval_id` 与内部
  `call_id` 关联；得到允许、拒绝、取消或不可用结论后，再 Flush 唯一的
  `approval/decided`。审批审计永不进入模型消息。
- 当前 Host 的实时交互 Frame 仍使用 `approval/requested` / `approval/resolved`，但 History
  使用冻结上游的 `approval/asked` / `approval/decided`；两者由同一个 `approval_id` 关联。
- 可重试 Provider 在第一次 Delta 之前失败时，先 Flush `llm/retry`，发出运行时通知，再 Flush
  `llm/retry-started`，之后才发起下一次 Provider I/O。Retry ID 在同一步的整个策略链中稳定，
  Retry Number 必须从 1 连续递增。
- Session Validator 会检查审批成对关系、Tool Call 引用、Retry 路由与 Request Header 一致、
  Normal/Always Policy 字段、Retry ID 所有权以及 Started 一一对应。
- 当前 Core 只生产 `normal + delayMs=0` 的网络重试；类型和投影已能表达 `always`，但带退避的
  Provider Policy Registry 尚未实现。崩溃后存在 `approval/asked` 而没有 Decision 时，Host 会
  在订阅恢复 Turn 后生成新的相关 Server RPC；History 仍保留同一 Asked，回答写入唯一 Decided，
  因而刷新或重启后可以继续点击且不会复制审计事件。

Session 创建还会在返回前 Flush `agent-preset/selected`、`permission/preset`、`sandbox/mode` 与
`approval/policy`。`/permission` 命令按 `command/run → policy triplet → command/done` 持久化；
Full access 的冻结线值为 `danger-full-access`，不是内部实现细节 `disabled`。Host 重启只折叠日志
最后一个 Preset，不从进程内旧值猜测。

`session.rename` 与 `agentPreset.select` 同样先 Flush `session/title` / `agent-preset/selected`，再更新
浏览器投影；Host 重启按日志最后值恢复，不依赖旧进程内存。

Goal 的每个 Mutation 先 Flush `goal/change` 全快照或 Clear Tombstone；History、尾页 `goal`
Projection 与重启恢复均折叠同一事件流。

Idle `/plan` 与 `/plan off` 按 `command/run → plan/mode → command/done` 持久化。Session
Projection 暴露 `plan={active,pending}`；当前稳定日志只恢复 `active`，因此进程重启后
`pending=false`。运行中的 Pending Pre-step、带 Message/Image 的 Plan Steering 和
`exit_plan_mode` 工具仍未实现，Host 必须明确报错而不是丢弃输入。

冻结 48 个 Session Event 中目前已有 29 个强类型事件；Compaction 四事件已完成基础事务和投影，
其余完整 Plan、Feedback、Subagent/Team/Workflow 等仍在兼容矩阵中逐项迁移，因此 `A-08` 不能
提前标记完成。

## 失败语义

- Durable Session Load/Validation 失败：History 和 Driver fail closed，不回退到内存旧历史。
- 日志 `next_seq` 小于已发布 Cursor：视为真源回退，返回内部错误，不重新编号或静默覆盖。
- Store 暂无该 Session：Durable Runtime 身份仍然成立；Host 等待第一次 Admission 创建它，禁止
  因文件暂不存在切换到 Ephemeral 投影。
- 只有新 Sequence 可以广播；完整 Cut 重读不能重复发送旧 Event。

## 验收

- 同一个 Durable Turn 在进程运行中查询与新 Host 从同一 Store 恢复后查询，`events` 和
  `projections` 必须逐字相等。
- 结构化 User Content 和 Timezone 在 Claim 消费 Inbox 后仍可从完整历史恢复。
- History 查询可以吸收尚未由 Driver 推送的日志尾部，但不能制造第二条 User/Assistant Message。
- 尾缓存驱逐后，`beforeSeq` 连续翻页仍必须返回完整历史；Host 重启不能改变页边界、事件内容或
  `projections.asOfSeq`。
- Ephemeral Runtime 的既有 Loop 投影测试继续通过。
- Approval Asked 必须先于 UI Request 和 Tool Side Effect 持久化；Decided 必须先于 Tool Start。
- 重启恢复的 Approval 必须复用原 Approval/Execution ID，回答前 Provider Attempt 和工具执行均为
  零；允许后恰好执行一次，拒绝后永不执行。
- 每个 Retry 必须按 `retry → retry-started → 下一 Provider Attempt` 排序，运行与重启投影一致。
- Idle Plan 切换必须在 RPC 成功前 Flush；重启后 History 与 Projection 的 `active` 必须相同，
  不支持的运行中或多模态输入必须失败且不得改变当前状态。
- Rust Check/Test/Clippy 必须在 `WZU_Server` 执行。
