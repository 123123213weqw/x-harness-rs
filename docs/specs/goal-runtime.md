# Goal Runtime 持久化与队列适配

状态：2026-09-10 已实现库与 Driver 链路并在 V100 跑通真实三轮；未部署产品入口。

## 分层

- `xharness-session::goal`：共享类型、`GoalExecutionState` 和日志投影；Session 校验转换合法性与同事务配套事实。
- `xharness-goal::decide`：纯决策，API 兼容之前的 re-export，不接触存储/模型。
- `xharness-agent::GoalController`：一致快照 → 纯决策 → 现有 Store CAS + Inbox Splice。
- 现有 `DriverWorker`：只在显式启用的 Goal 下调度续轮；现有 Registry/Lease 仍拥有执行权，Loop 仍是唯一模型/工具执行器。
- `TurnRequestFactory::goal_report`：可选宿主报告适配，默认 None，不从普通正文推断完成。没有新注册工具。

## 数据格式与旧历史

新增 `goal/execution` 事件，载荷 `version=2`，包含：目标执行定义、激活世代、轮次、待执行意图、正在运行的 claim、已结算报告、去重收据、空报告计数、确认与暂停原因。载荷使用 Box，避免扩大所有 SessionEvent 的内存尺寸。

`goal/change` 保留 v1 读取；控制器提交的配套快照使用 v2：

- 入队不增加轮数。
- claim 在同一 append 内写 `turn/start + inbox 删除 + v2 Goal 快照 + goal/execution + user/message`，增加一轮。
- v2 快照必须有同 revision 的执行事件；不允许单独伪造轮数增长。
- 校验配套消费的消息 ID，不能拿“删了另一个用户消息”充当 Goal claim。
- v1 目标只有 CRUD 不代表启用了自动推进。必须显式调用 `enable`。
- 后续 v1 Pause/Edit/Resume 会使旧执行授权失效，保留轮数；重新启用时激活世代增加，旧报告不作为新完成依据。
- Clear 后残留的内部 Goal 队列项不能按普通用户消息执行；reconcile 会移除它。

旧二进制不认识新事件，因此**未提供无损降级保证**。本次不向用户安装实例写入 v2；正式升级/降级门禁仍在 TODO。

## 对外库操作

- `enable(expected_revision, criteria, verification, empty_report_limit)`：目标已 active、没有旧 pending/running claim 时显式启用；不重置已用预算。
- `reconcile()`：观察并提交一项决策；CAS 冲突必须重新加载，Driver 的冲突重试有上限。
- `claim_events(session, claimed, turn)`：给现有 Loop journal prelude 增加 Goal 记账，不能单独提交。
- `settle(report_body)`：要求已经有 durable TurnEnd；绑定目标/版本/Turn/报告 ID。并发控制写入时重新加载，不因一次 CAS 冲突丢掉有效报告。
- `pause()`：停止未来推进；当前执行的取消仍走原 LoopCommand::Cancel。
- `review(expected_revision, review)`：确认必须匹配具体完成声明；重复同一确认不再写事件。

所有提案最终由 Session CAS 验证。Goal 启动额外将 claim revision 传至 `LoopRequest.journal_expected_revision`：启动前有变更则重新准备，**不允许把旧 Goal claim 直接重放到新 revision**。此严格策略只用于 Goal claim，普通定时任务继续使用原有控制事件并发规则。

## 等待与取消

- 用户 next-step 与普通 next-turn 输入优先于内部 Goal continuation。
- 取消、Failed、MaxTokens、LimitReached、Interrupted 不产生绕过原限制的新轮次。
- 旧 claim 仍有 open Turn 时，只等待恢复，不自动重放未知副作用。
- TurnEnd 已写但通知丢失：从日志结算；缺失报告不伪造完成。
- 排队项被外部删除：暂停为取消，不永久等待不存在的队列消息。
- 用户暂停后晚到的完成报告可以归档，但不会恢复/完成该暂停目标。

这里只能处理当前已注册的同步执行链路。**必要后台依赖、子 Agent 依赖图尚未投影到 Controller**，不能宣称 Goal 已支持“提交后台工作后自动等待全部完成”。真实实验只启用六个同步 Coding Tools，并禁止后台工作；依赖生产接入留在 GOAL-05。

## 验证范围

- 专项测试包含：v1 不自启动、并发 reconcile、稳定收据、claim CAS、用户优先、Pause/Clear 与队列、未知结果恢复、取消/输出/步数限制、异常 claim 拒绝、真实 Driver 三轮、报告确认、缺报告兜底、准备期间暂停、提交成功但回执丢失、队列删除、暂停恢复预算、晚到报告。
- 真实实验用 JSONL Store、现有 Driver/Loop、原生 Coding Tools、当前 DeepSeek；独立验收通过后才确认完成。见 [真实实验报告](../evaluations/goal-multi-round-20260910.md)。
- 没有新增 UI、后台定时唤醒器、第二套持久队列或新的 Provider 实现。
- 待完成：产品 RPC/实时通知、必要依赖、完整进程级故障注入、Mac/Windows CI 和发布门禁。
