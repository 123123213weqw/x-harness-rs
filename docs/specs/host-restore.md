# Host 启动恢复规范

**涉及 Crate：** `xharness-session`、`xharness-session-jsonl`、`xharness-agent`、
`xharness-host`、`xharness-host-app`  
**状态：** Agent Session 与 Host Control 双日志恢复已实现并通过真实进程重启测试。

## 目标与真源

Host 进程退出后，已经成功 Flush 的 Session、模型历史和 Pending Input 不能从 Web 中消失，
也不能为了重新附着 Web Driver 而再次 Append 同一输入。Append-only Session Log 是唯一真源；
`BasicHost.sessions/events/projected_queue` 都只是可以丢弃并重建的 Web Projection；其中 `events` 只保留
按 Event 数和序列化 Byte 双预算限制的连续尾部，完整 History 始终从 Session Store 查询。

## 固定恢复顺序

1. HTTP Listener 暴露前先加载并校验 Host Control Log，恢复 Workspace/Settings/Mutation Receipt。
2. 调用 Session `Store::list_headers()`；枚举结果必须已排序、已验证。
3. 对每个 Header 完整 `load()`，重放 `InboxProjection` 和 `derive_messages()`。
4. 从最后一个 `session/model-selected` 或 `request/header`（按日志顺序 latest-wins）恢复
   Provider/Model/Reasoning Route；两者都没有时使用当前配置。
5. 从 Header CWD 恢复 Workspace 归属；当前配置目录映射到 `workspace-default`，其他目录生成
   确定性的 recovered Workspace。
6. 再次应用 Control Workspace 顺序/Tombstone，避免 Session 归属覆盖用户定制。
7. 把所有强类型事件确定性转换为 Web Event；Durable Turn 的一基坐标转换成 Web 的零基坐标。
8. 对每个 Pending `next-turn` 输入，先创建独立 Agent Event Receiver 和 Prepared Turn。若日志
   存在未决 `approval/asked`，同时以稳定 Approval ID 创建 Recovery Receiver。
9. 所有 Receiver 就绪后才调用 `recover_open_turn()` 和 `wake()`；Activation 本身禁止自动执行
   旧输入或旧审批。
10. Runtime 返回的 Pending 数必须与 Host Projection 相同，否则启动 fail closed。
11. 最后创建进程内 Control Channel 和 Web Driver。Host 开始监听后，客户端可从
   `session.list/history` 获取恢复基线。

新 `followup()` 仍会自动 Wake；显式 Wake 只用于“输入在本进程启动前已经持久化”的恢复路径。

## 失败语义

- JSONL 损坏、Symlink、Header 不匹配、Inbox Replay 失败或 Runtime/Projection 数量不一致：
  整体恢复失败，Host 不监听端口。
- 历史 Model Route 当前不可用：Session 和 Queue 仍显示，记录 `HostRestoreIssue`，但不启动 Driver。
- 仅有 `next-step`、没有 `next-turn`：保留等待，不凭空制造 Turn；下一次 Followup 原子领取它。
- Tool Call 已记录但无 Result：下一次 Core Journal 初始化追加 `outcome_unknown`，禁止自动重放
  工具；但未决 Approval 证明工具尚未获准，必须走下一条交互恢复规则。
- `approval/asked` 已 Flush、`approval/decided` 缺失：保持原开放 Turn/Step，重新投影一个可回答的
  `approval/requested` Server RPC。Allowed-once 后首次执行，Rejected 后写 Tool Error；不新增
  User Message 或 Turn。
- 其他开放 Turn/Step：下一次 Core Journal 初始化闭合为 `Interrupted`；Provider 流不恢复。

## 数据保真

Web Prompt 的结构化 `content` 与 `source` 保存在 `InboxMessage.source` 元数据封装中，重启后可
恢复 Attachment/Text Block 的 Queue 外观。旧日志没有这段元数据时退化为一个 Text Block，并标记
`restored=true`；不得因此修改模型可见纯文本。

`session.prompt` 和 `subagent.prompt` 还要在同一元数据封装中保存 `rpcFingerprint` 与
`rpcSessionId`。Fingerprint 是带版本号的 Mode、原始 Content 和 Timezone 的规范 JSON SHA-256。
Host 启动时扫描完整 Inbox Insert 历史（包括已消费输入）重建会话内 Receipt 索引；因此响应丢失后
使用相同 RPC ID 和 Payload 重试必须直接返回原成功语义，既不重复创建 Attachment，也不调用
Runtime。相同 ID 配不同 Payload 必须返回 `SessionConflict`。每会话 Admission Gate 保证并发重试
也只有一个写入者；Fork 不继承 Receipt，因为 `rpcSessionId` 必须等于当前 Session。

Queue Edit 必须同时替换 Durable Message 和这段元数据；Queue Remove 必须先成功修改 Durable
Inbox，再改变 Web Projection。

Queue Baseline 必须从同一 Session Cut 折叠完整 `next-turn + next-step`，顺序和 Placement 分别为
`queued`、User Source 的 `steering`、非 User Source 的 `context`。Mux 重连必须为所有 Session 发送
Subscribed/Projection，并为非空 Inbox 发送完整 Queue Snapshot；空列表通过最近一次实时 `[]`
收敛。Host Driver FIFO 不得作为重连基线或 Queue Item 存在性的证据。

## 当前不承诺

- Workspace 用户标题、顺序、Session 顺序、归档与 Settings 已有独立 Control Log；Credential
  Reference 与 Attachment Blob 尚未持久化。Pending Approval 已由 Session Log 恢复；Agent/
  Permission Preset、Goal 和展开的 Sandbox/Approval Policy 已进入 Session Log。
- Prompt RPC Receipt、Permission Command Receipt、Workspace/Settings 共 9 个变更 RPC，以及
  Session Rename/Model Select、Preset Select 和 6 个 Goal RPC 的 Session 原子 Receipt 已可恢复；
  Session Create/Fork、Queue/Cancel/Attachment、Preset Copy/Remove 等仍未统一接入。
- Web History 已按权威 Session Cursor 分页查询、使用有界尾缓存并增量广播；Queue 已按权威
  Durable Inbox 发送实时完整快照和重连 Baseline；Workspace/Settings
  等非 Session 投影仍没有统一持久查询接口。
- Idle Plan Mode 的最终 `active` 状态已由最后一条 `plan/mode` 恢复；运行中尚未接受的 Pending
  Pre-step 选择不是可恢复状态，当前重启后一律投影为 `pending=false`。
- queued-to-steer 是 Remove + Steer 两步，不是崩溃原子 Move。

## 验收

- Memory/JSONL Store 枚举排序，忽略非 Session 文件，损坏/Symlink fail closed。
- Worker 对已存在 Pending Input 保持休眠，订阅后显式 Wake 才执行。
- Runtime 恢复 Pending Input 后只出现一次 Inbox Insert 和一次 User Message。
- 同 RPC ID + Prompt Payload 的并发/重启重试只出现一次 Inbox Insert；Payload 不同则冲突。
- 七点通用日志前缀覆盖 Admission/Claim/Request/Tool Call/Tool Result/Step End/Turn End；真实
  子进程 SIGKILL 矩阵另覆盖 Approval Asked，共八点，验证 Interrupted、OutcomeUnknown、未批准
  工具不执行、权威结果保留和同目录重启。
- Host 单元测试恢复 History、模型路由、Workspace、Web Event 与 Pending Turn。
- Host 重启测试恢复同一 Approval/Execution/Provider Call ID；响应前执行计数和 Provider Attempt
  均为零，Allowed-once 后恰好执行一次并从下一 Step 继续。
- Session 创建与 `/permission` 切换在返回前 Flush 强类型事件；Full access 重启后仍为
  `danger-full-access + never`，Command Run/Done 顺序不变。
- `session.rename` 和 `agentPreset.select` 在返回前 Flush，重启后保留 Title/Preset；显式用户标题
  使用空 `messageSeqs` 与 `source={kind:"user"}`，不进入模型消息。
- `session.selectModel` 在返回前把 Route 与 Receipt 原子 Flush；恢复时最后一个显式
  `session/model-selected` 优先于其后所有执行态 `request/header`，只有旧日志完全没有显式选择时
  才回退最后一个 Request Header。这样即使 Provider 未在 Header 回写 Effort，刷新或重启仍恢复
  Provider/Model/Reasoning Effort。上述 Session/Goal/Preset RPC 的相同 ID
  重试逐字返回原响应，不同 Payload 冲突且不追加第二个状态事件。
- Goal Mutation 使用全快照或 Clear Tombstone；Host 重启恢复 Revision、Phase、Objective、Round
  Budget、时间和 History/Projection，不依赖旧进程的 `goals` Map。
- `/plan` 与 `/plan off` 的成功状态在返回前 Flush；Host 重启恢复最后的 Active 状态且不重放命令。
- 真实 `xharness-host` 子进程在相同 State Dir 和端口重启后，`workspace.list`、`session.list`、
  `session.history` 与 WebSocket Carrier 均恢复。
- 所有 Rust 测试必须同步到 `WZU_Server`，远程通过 Workspace Check/Test/Clippy。

## 运行中观察器恢复（2026-09-14）

实现集中于 `runtime/observer.rs`，复用现有 Agent 广播、Inbox 与 Session Store，不增加调度器、工具或模型调用。

- 广播仅是通知，不是完成状态的唯一来源。`Lagged` 不再被映射为模型失败；读取持久日志，按稳定 input ID 定位实际所属 turn，再通知 Host 同步已有历史。
- 输入既可以在 TurnStart 时被领取，也可以由 Steering 在当前 turn 内产生 UserMessage；不能要求每条输入都有独立 TurnStarted。恢复审批/提问使用其持久 interaction 对应的恢复 ID 定位。
- 终态按输入所属 turn 的 TurnEnd 恢复；结果仅使用该结束位置及之前的消息，禁止混入已经开始的后续 turn。能恢复的 Usage/Finish 信息保留，旧日志缺失字段不伪造。
- 删除、Parked、Idle 和广播关闭均触发身份/终态检查。静默时最多每秒检查一次 Agent 是否 Idle；模型/工具忙碌期间不轮询完整日志。Idle 的遗留观察器可以收敛，不依赖下一条模型输出唤醒。
- 正常结束后仍走原有 Host Driver 收尾：同步事件、清除 running/control、发布状态。用户停止的 dispatch-paused 门禁不变；内部 settlement 到达只排队，不恢复运行。
- 例外是用户自己排队的 Prompt：恢复时若仍有 `source.kind=user` 的 next-turn 输入，即使门禁为 paused 也恢复该会话，并由 Driver 打开门禁开始下一 Turn；内部回执（`placement=context`）在两种路径下都不能解冻已停止的会话。
- 恢复只重建观察状态，不重放输入、不重新执行工具、不伪造新的 TurnEnd，也不通过扩大缓冲区掩盖丢事件。

回归覆盖：默认 2048 容量下 2200 片流式输出；订阅滞后后 Steer/删除再停止；旧观察器晚于后续四轮恢复；完整 Host RPC 的队列 Steering、用户停止、running/control 清理及后续内部回执不得唤醒。

## 内部回执与用户草稿队列隔离（2026-09-14）

- `role=user` 是模型输入协议，不代表用户手写消息。只有 `source.kind=user` 可以通过 `session.updateQueue` 编辑、删除或 Steer。
- `queue_view()` 为所有非用户来源复用现有 `placement=context` 投影，包含 `agent-settlement`、`agent-message`、工具上下文及未来内部来源；不改变持久 Inbox 的 NextTurn/NextStep 或执行顺序。
- Web/Tauri 已有 QueueDock、批量 Steer、输入框 Steer 快捷入口只选择 `placement=queued`。因此内部回执不再出现在可编辑用户草稿区，不新增插件/组件；完整来源、内容仍保留在队列协议及持久日志，供上下文/Agent 界面消费。
- 旧客户端即使仍缓存原 queued 卡片，调用三个变更操作均得到 `bad-request`，`details.reason=QUEUE_ITEM_READ_ONLY`；检查在任何 Inbox 删除/替换之前，不能导致回执丢失或唤醒已暂停会话。
- 恢复元数据逐字段解码，缺少 UI content 不得把显式内部 source 回退为 user；无来源的旧日志保持历史用户消息兼容。实时和重启共用 queue_view 判定。
- 不改变 Agent 内部合法的消息递送/Steer，不丢弃回执、不新增模型调用。停止门禁、去重与用户手写队列操作保持原有行为。
- 回归覆盖真实 Runtime 子 Agent 回执递送、六条去重、三种 RPC 拒绝且日志不变、暂停不被唤醒、重启投影一致，以及已打包前端筛选/批量 Steer/旧编辑器关闭契约。

## 输出截断通知的历史语义（2026-09-14）

`turn/end.reason.kind=max-tokens` 表示该历史轮次耗尽输出续写额度，不等同于当前会话空闲或需要用户继续。前端通知只能描述“该轮达到输出上限、已有内容保留”，不能无条件附加发送 continue 的指令，也不能把处理下一条队列消息称为续写原回答。中英文文案共用产品 override，Web/Tauri 产物及构建路径一致。历史节点保留，不改预算和任务调度。

## Compact 既有组件协议适配（2026-09-14）

- Durable `CompactionSummary.summary` 继续保存字符串；仅 Host Web 投影转换为 `[{type:"text",text:summary}]`。保留 compactionId/sourceCommandId、shadowedSeqs/Range/TokenCount 与用量证据；生命周期 turn 统一转换为 Web 的零基坐标。
- 压缩 replacement user/message 的 source 固定为 `{kind:"plugin",plugin:"compact",compactionId,...sourceCommandId}`。普通用户消息不变，来源索引按 compactionId 构建，历史页即使从 replacement 开始也保留手动命令关联。
- 自动压缩复用 CompactionItem；手动压缩复用 ManualCompactionNodeView/CompactionCommandCard，不额外添加卡片。同一转换函数服务实时范围、分页历史、启动尾部和恢复重放。
- Context Inspector 同时兼容旧字符串及新内容块数组，只拼接 text 块。源码、打包产物及 boot manifest 一起更新，Web/Tauri 复用。
- 这些都是展示投影：不写回模型消息，不增加摘要副本，不修改压缩预算、事务或算法。失败/取消保留原 surface，无 replacement，不伪造成功卡片。
- 既有自动压缩组件仍只在 checkpoint 成功落地后显示完成标记；本修复不新增自动压缩运行中/失败卡片。手动命令继续复用既有命令状态显示。
