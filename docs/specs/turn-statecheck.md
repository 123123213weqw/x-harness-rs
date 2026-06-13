# 轮次交互状态检查（#152，阶段 0–2）

## 目的与边界

这是开发期的可执行决策表，不接管生产调度、不增加持久化事件，也不修改 Web 协议。真实 Session JSONL、Agent worker 和 Host driver 仍是执行与恢复的权威来源。枚举器仅用于发现组合语义缺口；`Undefined` 表示尚未决定，不可被生产代码当作默认允许。

当前只覆盖 turn/queue/tool/question/compact/recovery 的少量真实剖面。Goal 验证、fork、队列编辑、overflow、审批及所有竞态尚未建模；**不能将本检查器的有限探索称作形式化证明**。

## 阶段 0：当前行为基线

| 行为 | 权威事件或投影 | 对照测试 |
| --- | --- | --- |
| 工具运行中排队后续消息，第一轮必须先完成 | `tool/call → tool/result → turn/end(1) → turn/start(2)`；不得生成 `OutcomeUnknown` | `queued_prompt_waits_for_in_flight_tool_to_finish`（#73 回归） |
| 模型请求中排队后续消息 | `turn/end(1) → turn/start(2)` | `queued_prompt_waits_for_in_flight_model_to_finish`（三组隔离参数） |
| 用户停止时，已排队的用户消息仍可启动下一轮 | `turn/end(UserInterrupted,1) → turn/start(2)` | `user_stop_lets_the_already_queued_prompt_start_the_next_turn` |
| 活动问题回答继续原轮 | 同一 question/tool identity、原轮继续 | `restore_reattaches_pending_question_and_reuses_the_web_composer_protocol` |
| 崩溃后未完成的工具按原生 Host 默认策略暂停、不重放 | `dispatch_paused=true`、没有新 `tool/result` | `pause_policy_does_not_resume_an_incomplete_tool_call` |
| Core 嵌入式兼容恢复可把真正遗留的工具调用标成未知 | `tool/result(OutcomeUnknown)`、`turn/end(Interrupted)` | `event_journal_recovers_incomplete_tool_as_outcome_unknown_without_replay`（Core 测试） |

**恢复策略不能混淆**：上表最后两行分别验证 Native Host 的 `PauseIncompleteTools` 与 Core 兼容模式的重新进入；正常排队不属于任何崩溃恢复场景。

## 阶段 1：只读枚举器

`crates/xharness-host/src/statecheck.rs` 只在 `#[cfg(test)]` 下编译。状态先用 `Phase × Activity × queued × Gate` 表示；事件是用户输入、工具结束、问题回答、轮次结束、停止、压缩和重启/恢复。每条已定义规则返回稳定的 `rule_id`、决策类型和下一状态。未审定的组合返回 `Undefined`，不推测生产行为。

从八个经人工挑选的真实剖面出发，按状态筛出候选事件，在有限深度内只展开已定义的下一状态。循环按状态去重、深度限制为 3，输出可审查的状态/决策数；这避免整个笛卡尔积被不可达状态淹没。每个 `Undefined` 都带独立 `unhandled/<state>/<event>` 标识；远程运行测试时设置 `XHARNESS_STATECHECK_LIST=1` 可列出全部缺口供人工审核。现阶段允许 `Undefined` 存在，**尚未启用“所有组合零未定义”门禁**。不能以 `Undefined` 的数量评价产品完成度；它也包括有意未纳入当前范围的事件组合。

V100 上当前枚举结果为 **18 个可达状态、65 个决策、34 个显式未定义组合**。未定义主要落在运行中 compact、停止/恢复期间又输入、正在等待工具或问题时收到过于粗略的 `TurnFinished` 等区域。后者提示下一阶段须把完成原因带入事件，而非一律视为真实产品 bug。

这些组合已逐项列入 [`turn-statecheck-gaps.txt`](turn-statecheck-gaps.txt)：清单分组说明哪些需要观察真实 Host 顺序，哪些需要更精确的事件。测试要求**实际未定义集合与该清单完全一致**；新增或消失一个都必须审核并更新清单，而不是悄悄扩展或强行裁决成 `Allow`。这是“未知集合不漂移”的门禁，**不是要求零未知**。规则 ID 用状态字段和事件构成稳定路径，便于跨运行对比。

下表由测试内的八个 Profile 确定性生成；测试会核对文档与代码完全一致。

<!-- statecheck:begin -->
| Profile | Event | Rule ID | Decision |
| --- | --- | --- | --- |
| idle prompt | UserPrompt | `idle_user_starts_turn` | StartTurn |
| running model prompt | UserPrompt | `busy_user_joins_next_turn` | Enqueue |
| running tool prompt | UserPrompt | `busy_user_joins_next_turn` | Enqueue |
| running tool settles | ToolFinished | `tool_result_keeps_current_turn` | ContinueTurn |
| question answered | QuestionAnswered | `answer_resumes_current_turn` | ContinueTurn |
| stopped queued turn | TurnFinished | `stopped_turn_preserves_queued_user` | FinishTurn |
| completed turn drains queue | TurnFinished | `completed_turn_drains_next_turn` | FinishTurn |
| crashed tool restored | RestoreIncompleteTool | `host_restore_pauses_incomplete_tool` | PauseUnresolvedTool |
<!-- statecheck:end -->

模型将 `running/tool + queue` 直接收到普通 `TurnFinished` 留为 `Undefined`：没有工具终态或明确取消，就不能假设轮次可结束。实际执行仍由 Host/Agent 决定；对应回归测试断言此异常序列不会在正常排队中产生。

## 阶段 2：与实现对照

测试不只验证决策表自身：#73 测试在真实 Host + durable Agent + 可暂停工具下检查事件顺序；模型在飞测试用 fake provider 做三组隔离参数；停止、问题恢复和崩溃工具恢复沿用现有真实路径，并在测试开始处核对对应规则 ID。枚举器自身还检查排队输入不得改写在飞工作的归属，工具/问题未解决时普通 `TurnFinished` 不得伪装为完成。这样规则变更不能绕过已有行为验收，实际行为偏移也不能只靠决策表“自证正确”。

跨平台文档表格比较先统一 CRLF/LF：Windows checkout 的换行格式不应改变规则含义。该检查只存在于测试构建，既不注入模型提示词，也不增加每轮运行时开销。

**尚未覆盖**：压缩完成且队列非空的端到端对照、Goal/fork 交互、所有可达 `Undefined` 的产品裁决，以及自动从案例生成所有集成测试。进入阶段 3 前，应先逐项裁决这些缺口，而不是把当前模型直接搬进生产链路。

Rust 检查和测试按仓库规则在 V100 远程同步构建，不在本机编译。
