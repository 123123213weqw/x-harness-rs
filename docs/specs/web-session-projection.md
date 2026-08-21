# Web Session 确定性投影规范

**涉及 Crate：** `xharness-session`、`xharness-agent`、`xharness-host`  
**状态：** 权威 History/重启等价阶段已实现；完整冻结事件词汇仍在迁移。

## 真源与边界

正式 Durable Runtime 的 Append-only `Session` 是模型历史与浏览器 History 的共同真源。
`BasicHost.SessionRecord.events` 只是可丢弃缓存，禁止继续把 Loop Event 临时转换结果当成正式
History。兼容 `LoopAgentRuntime` 没有 Session 真源，可以继续使用旧的内存投影，但不得冒充
可恢复语义。

`AgentRuntime` 通过以下能力显式声明这一边界：

- `has_authoritative_sessions()`：区分 Durable 与 Ephemeral Runtime；
- `authoritative_session(session_id)`：返回一个不可变、已校验的完整 Session Cut；
- Durable Runtime 必须直接从其 Store 加载，Host 禁止维护第二份模型历史。

## 投影算法

1. Host 以 `authoritative_seq` 保存下一个待发布的 Session Sequence。
2. 每次 History 查询、模型流事件和 Turn 终止时加载完整 Session Cut。
3. 对每个 Logged Event 产生且只产生一个 Web Session Event；Web `seq/time` 直接使用日志坐标。
4. 缓存整体替换为纯投影结果，只把 `[authoritative_seq, next_seq)` 的新增事件推送到 Mux，避免
   History 查询或重连造成重复广播。
5. `user/message` 使用稳定 Message ID 连接之前的 `agent/inbox/spliced` 元数据，恢复原始
   Text/Image Content Block、Source、RPC ID 与 Timezone；旧日志缺元数据时才退化为纯文本。
6. Assistant、Tool、Turn、Step、Request Header 和 Inbox Event 均从同一个 Logged Event 生成；
   Host 不得再为 Durable Turn 人工追加另一份 `turn/start/user/message/assistant/message`。
7. 启动恢复与运行中 History 必须调用同一 `project_session_events()` 纯函数。

## 当前控制事件

Tool Approval Request/Resolved 和 Host Agent Error 仍由当前 RunningTurn 控制面即时推送，尚未成为
可恢复 Session Event。Provider Retry 也缺少强类型持久事件。这些缺口意味着冻结上游的完整事件
词汇还未全部迁移，`A-08` 在补齐前不能标记完成。

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
- Ephemeral Runtime 的既有 Loop 投影测试继续通过。
- Rust Check/Test/Clippy 必须在 `WZU_Server` 执行。
