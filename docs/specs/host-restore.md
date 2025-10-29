# Host 启动恢复规范

**涉及 Crate：** `xharness-session`、`xharness-session-jsonl`、`xharness-agent`、
`xharness-host`、`xharness-host-app`  
**状态：** 第一阶段已实现并通过真实进程重启测试。

## 目标与真源

Host 进程退出后，已经成功 Flush 的 Session、模型历史和 Pending Input 不能从 Web 中消失，
也不能为了重新附着 Web Driver 而再次 Append 同一输入。Append-only Session Log 是唯一真源；
`BasicHost.sessions/events/queue` 都只是可以丢弃并重建的 Web Projection。

## 固定恢复顺序

1. HTTP Listener 暴露前调用 `Store::list_headers()`；枚举结果必须已排序、已验证。
2. 对每个 Header 完整 `load()`，重放 `InboxProjection` 和 `derive_messages()`。
3. 从最后一个 `request/header` 恢复 Provider/Model/Reasoning Route；没有 Header 时使用当前配置。
4. 从 Header CWD 恢复 Workspace 归属；当前配置目录映射到 `workspace-default`，其他目录生成
   确定性的 recovered Workspace。
5. 把所有强类型事件确定性转换为 Web Event；Durable Turn 的一基坐标转换成 Web 的零基坐标。
6. 对每个 Pending `next-turn` 输入，先创建独立 Agent Event Receiver 和 Prepared Turn。
7. 所有 Receiver 就绪后才调用 `DurableAgentHandle::wake()`；Activation 本身禁止自动执行旧输入。
8. Runtime 返回的 Pending 数必须与 Host Projection 相同，否则启动 fail closed。
9. 最后创建进程内 Control Channel 和 Web Driver。Host 开始监听后，客户端可从
   `session.list/history` 获取恢复基线。

新 `followup()` 仍会自动 Wake；显式 Wake 只用于“输入在本进程启动前已经持久化”的恢复路径。

## 失败语义

- JSONL 损坏、Symlink、Header 不匹配、Inbox Replay 失败或 Runtime/Projection 数量不一致：
  整体恢复失败，Host 不监听端口。
- 历史 Model Route 当前不可用：Session 和 Queue 仍显示，记录 `HostRestoreIssue`，但不启动 Driver。
- 仅有 `next-step`、没有 `next-turn`：保留等待，不凭空制造 Turn；下一次 Followup 原子领取它。
- Tool Call 已记录但无 Result：下一次 Core Journal 初始化追加 `outcome_unknown`，禁止自动重放工具。
- 开放 Turn/Step：下一次 Core Journal 初始化闭合为 `Interrupted`；当前阶段不会恢复中断点内的
  Provider 流或 Pending Approval。

## 数据保真

Web Prompt 的结构化 `content` 与 `source` 保存在 `InboxMessage.source` 元数据封装中，重启后可
恢复 Attachment/Text Block 的 Queue 外观。旧日志没有这段元数据时退化为一个 Text Block，并标记
`restored=true`；不得因此修改模型可见纯文本。

Queue Edit 必须同时替换 Durable Message 和这段元数据；Queue Remove 必须先成功修改 Durable
Inbox，再改变 Web Projection。

## 当前不承诺

- Workspace 用户标题、排序、归档，Settings、Credential Override、Attachment Blob、Goal、Preset
  与 Pending Approval 还没有独立持久日志。
- HTTP RPC Receipt/Consumed 索引尚未持久化；客户端在成功回执丢失后重放同一 RPC ID 的完整
  Exactly-once 语义仍需实现。
- Web Event Projection 目前在启动时整体重建，还没有按 Cursor 从持久 Store 查询。
- queued-to-steer 是 Remove + Steer 两步，不是崩溃原子 Move。

## 验收

- Memory/JSONL Store 枚举排序，忽略非 Session 文件，损坏/Symlink fail closed。
- Worker 对已存在 Pending Input 保持休眠，订阅后显式 Wake 才执行。
- Runtime 恢复 Pending Input 后只出现一次 Inbox Insert 和一次 User Message。
- Host 单元测试恢复 History、模型路由、Workspace、Web Event 与 Pending Turn。
- 真实 `xharness-host` 子进程在相同 State Dir 和端口重启后，`workspace.list`、`session.list`、
  `session.history` 与 WebSocket Carrier 均恢复。
- 所有 Rust 测试必须同步到 `WZU_Server`，远程通过 Workspace Check/Test/Clippy。

