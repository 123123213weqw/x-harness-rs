# xharness-goal：目标推进契约与纯决策

## 本阶段交付

只提供 `decide(&GoalObservation) -> Result<GoalDecision, GoalContractError>`。
**没有启动后台任务，没有模型调用，没有注册新工具，没有接入 Host，也没有修改 v1 Goal 事件。**

- `GoalDefinition` 复用 Session 的 `GoalSnapshot`，增加执行观察需要的定义版本、验收条件、显式启用和确认方式。不是另一个持久化真源，也不是已实现的 v2 迁移。
- `GoalReport` 表达 `progress / blocked / complete`，报告绑定目标、定义版本、Turn 和报告 ID。
- `GoalObservation` 是未来 Host 从同一个一致快照投影出的运行状态、用户输入、必要依赖、已用轮数、最新报告和续轮收据。
- `GoalDecision` 输出不操作、等待、丢弃旧意图、继续、暂停、阻塞或完成的**提案**。

## 判断顺序

1. 无目标、停用、暂停、阻塞、完成：不自动执行。
2. Runtime 忙、等待审批/回答、恢复未完成：等待。用户待处理输入优先。
3. 已有待领取意图：不重复提交；不同目标/定义/激活的旧意图提议先删除。
4. 仅处理当前目标、定义、激活下的已结算 Goal Turn，不把普通用户 Turn 算作 Goal 轮次。
5. 取消、失败、明确的 Step/Output 上限、结果未知：暂停，不能通过新一轮绕过。
6. 必要依赖未结束：等待，完成声明也不越过它。
7. 有效报告决定进展/阻塞/完成；无报告不等于完成。
8. 继续之前检查目标轮次预算、报告协议空转阈值和已有续轮收据。

轮数预算只约束**新增工作**；最后一轮有效完成仍可提议完成。`empty_report_rounds` 是 Host 提供的“既无有效报告、也无已结算工具行为”的连续计数，按定义/激活重置，不做文字相似度判定。等待状态不增加轮数。

`AgentReport` 接受模型的有效完成声明，不代表独立验证。`UserConfirm` 必须有绑定该报告的确认；旧报告的确认无效。证据只有引用，本模块不读文件、不运行测试。JSON 反序列化不等于语义验证；外部输入应调用 `validate`，`decide` 会校验当前生效的契约。

## 幂等与并发边界

- `ContinuationKey = 目标 + 定义版本 + 激活世代 + 起因（首次/上一 Turn）`。同一事实重复判断得到同一个 Key，不因无关 Session revision 更新产生新任务。
- `GoalFence` 同时携带 Session revision、Goal revision、定义版本和激活世代；后续 Host 必须在现有 Admission Fence 下重新核对全部字段，再原子写入状态、收据和 Inbox。
- **纯函数不能保证事务幂等或副作用 exactly-once。** 收据、原子 claim、轮数记账和 CAS 冲突重算仍未接入。
- `Pause/Edit/Clear` 取消旧排队意图由未来生命周期事务负责；`DiscardPending` 不是全局队列清理器。运行中和非 active 目标不会在本函数中清队列。
- 模型不得自行指定可信身份字段；未来报告入口必须从宿主执行上下文绑定报告 ID、目标/Turn/版本。
- 旧 v1 active Goal 不得在适配时隐式设置 `execution_enabled=true`；需显式启用。这里只定义契约，没有执行迁移。

## 回归

18 个测试函数包含多状态组合：运行/审批/回答/恢复、用户优先、依赖等待、完成确认、旧版本/世代/报告、预算末轮、错误与取消、重复意图、稳定 Key 与变化 Fence、协议空转、无效契约及序列化。

Rust 编译和测试仅在 `WZU_Server` 执行，当前源码 rsync 到 `~/codex-build/x-harness-rs/` 后运行：

```sh
cargo test --offline --locked -p xharness-goal
cargo test --offline --locked --workspace --all-targets
cargo clippy --offline --locked --workspace --all-targets -- -D warnings
```

2026-09-10 V100 验证：Goal 专项 18/18；全仓 513 通过、0 失败、5 忽略；全仓 Clippy（`-D warnings`）通过。完整本机日志：`/tmp/xh-goal-unit.log`、`/tmp/xh-goal-regression.log`。此结果是 Linux 回归，不等价于已通过 Mac/Windows CI。

本阶段没有调用 DeepSeek：被测对象是纯状态函数，尚无模型报告入口或自动续轮可测。真实多轮模型、故障恢复和跨平台 UI 验收仍在 TODO。

下一步：先实现 v2 Goal 事件/归约与旧历史迁移，再实现 Host 一致观察、事务提交及恢复；不要直接把 `Continue` 接成循环调用模型。
