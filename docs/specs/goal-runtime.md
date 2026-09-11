# Goal：产品运行时与现有 UI 接入

状态：2026-09-10 的 Goal 运行时已随 0.2.16 发布；2026-09-11 的常规 `goal` 工具与单框 UI 变更见本文末节，当前尚未打包发布。

## 1. 直接使用

在已有输入框使用：

```text
/goal 实现 CSV 导入，补齐错误处理和测试，最后写使用说明
/goal
/goal pause
/goal resume
/goal edit 修改后的完整目标
/goal budget 512
/goal complete
/goal clear
```

复用上游 `dsh-client-ui-goal` 的 GoalBar、GoalDock、编辑/暂停/恢复/清除按钮和命令气泡；没有另做目标管理页面。2026-09-11 改为在同一个 GoalBar 内显示状态、轮数和操作，不再追加下方展开区。

- 新建 Goal 显式开启持续推进。旧日志只有 v1 Goal 时不自动启用，用户点击“启用自动推进”或 `/goal resume`。
- 模型报告完成后停在“等待你确认完成”。用户可“确认完成”或“尚未完成，继续”。完成状态仍可见，不再直接消失。
- 暂停只停止**后续自动轮次**，不回滚文件，也不自动取消正在执行的工具。要立即取消当前轮，使用对话原有停止按钮。
- 编辑目标/预算会使旧执行授权失效；需明确恢复，不把旧完成报告当新目标验收。轮数不会重置。
- 轮数达到上限时暂停，不伪造答案；调大预算再恢复。默认 256 轮不是性能推荐值。
- `/goal` 命令暂不接附件，明确返回错误；附件先用普通消息提交，不静默丢弃。

## 2. 分层：一套 Runtime，一套队列

```text
现有 Goal UI / goals RPC / /goal
                 ↓
Host：Admission Fence、RPC Receipt、当前 Goal revision
                 ↓
xharness-agent::GoalController
一致 Session → xharness-goal::decide → CAS 原子追加
                 ↓
原有 DurableInbox → Driver → Core Loop → Provider / ToolRegistry
                 ↓
ToolResult + TurnEnd → Goal 报告结算 → 继续 / 等待 / 暂停 / 待确认
```

`xharness-session::goal` 是共享类型与持久真源；`xharness-goal` 不做 I/O；Host 不创建第二个模型 Loop。

- 创建/恢复：现有 `goal.create` / `goal.resume` 的控制快照、显式 Enable 与 RPC 收据同一事务写入。
- `goal.edit/pause/clear`：旧 Goal 待执行意图与 Inbox 删除同一控制事务提交，不删除普通用户输入。
- 正式 UI 的完成确认复用 `goal.complete`：用户是最终裁决者，当前 Goal ref + 持久 RPC receipt 记录该决定；这是**用户控制命令**，不是模型可调用的完成工具。继续复用 `goal.resume` 创建新的激活世代。库层 `review` 仍可供独立验收程序绑定具体 report ID。
- 普通用户 next-step / next-turn 输入优先，用户轮不计入 Goal 轮数。
- enqueue 不增加轮数；claim、Inbox 删除、UserMessage、TurnStart 和轮数增长同一 CAS 提交。
- claim revision 变化必须重新准备，不能把旧目标重放到新版本。若准备期间目标被暂停/清除，发送 Parked 收尾已订阅的 Host 通道，避免假运行。普通 Schedule 保留原有规则。

## 3. 0.2.16 的报告接口：goal_report（新设计见末节）

只在已启用的 Goal 轮和它的恢复轮注册，复用 `ToolRegistry` / Standalone batch policy / 参数校验 / 原有日志。普通会话不额外注入此工具。

```json
{
  "status": "progress",
  "summary": "解析器和单元测试已完成",
  "remaining": ["CLI 集成和异常输入测试"],
  "evidence": [{"kind": "artifact", "reference": "tests/test_parser.py"}]
}
```

- `status`：`progress | blocked | complete`。
- `summary` 最大 8192 字符；remaining/evidence 最多 32 项，每项引用/文本最多 2048 字符。
- blocked 必须给 `blocked_reason: {code,message}`；非 blocked 不允许携带阻塞原因。
- complete 必须无剩余事项且有证据引用。引用是可检查线索，**不代表 Host 已证明测试通过**；默认等待用户确认。
- 目标 ID、定义版本、激活世代、Turn 与 report ID 均由 Host/Controller 绑定，禁止模型伪造。
- 与别的工具混批时复用 Standalone 规则拒绝，不并行确认尚未执行的修改。
- 成功工具结果的 metadata 保存结构化报告；只接受当前轮真实 `goal_report` 调用对应的成功结果。正文不解析成完成声明。
- TurnEnd 后才结算。崩溃发生在工具报告持久化后、Controller 结算前，可从同一日志恢复报告。
- 晚到、暂停后、旧版本报告不会重新激活目标。

## 4. 必要后台依赖

复用同一个报告的证据引用，无新 job 工具、无独立依赖队列：

```json
{"status":"progress","summary":"等待必要检查","evidence":[
  {"kind":"job","reference":"process-1"},
  {"kind":"agent","reference":"agent-..."}
]}
```

只有明确列出的 job/agent 是必要依赖，普通 artifact 不阻塞，不扫描并等待会话里的所有 daemon。

- Native JobRegistry 检查 owner、运行/停止中/成功/失败状态；未知、被清理、失败、被杀 job 不当作成功。
- 子 Agent 必须属于当前父会话；忙/有队列则等待，已停止、失败或历史不可用返回诊断。
- 必要依赖运行时不增加 Goal 轮数、不空转调用模型。Goal 会话使用 Host 的轻量唤醒适配检查状态；恢复依赖后重用同一个 Driver。
- 依赖失败暂停并持久保存原因，UI 可展开看详情。用户修正后明确恢复。
- 完成报告提交时也检查必要依赖，不允许“后台仍在跑”被直接标记待确认完成。
- **不重建已消失的 OS 进程**。重启后丢失的必要 job 视为需要用户处理，不运行第二遍未知副作用。

## 5. 实时状态和恢复

- Goal 后台轮在 TurnStart 前订阅原 Agent 事件流，再发后台运行通知；复用 Schedule 的 Host 运行通道协议，不把 Goal 变成 Schedule。
- 同一续轮通知去重；用户队列不展示内部 Goal 控制消息，重启也不让两种驱动重复接管。
- 实时与历史共同使用 `restored_goal` / `execution_projection`。执行事件不是另一份前端真源。
- 投影包括 enabled/state、roundsStarted/maxGoalRounds、pauseReason/pauseDetail、report 和 acceptanceCriteria。
- 覆盖 running、queued、waiting、awaiting_approval、awaiting_answer、awaiting_confirmation、paused、blocked、complete、disabled。
- 投影通知丢失时重读持久 Session；通知通道落后不会静默退出监听。
- 没有 Provider 的待确认 Goal 仍可恢复和确认，不发新的模型请求。
- 开放审批/问题复用既有恢复器；其他未结束的 Goal Turn 复用 Session 的未知结果恢复，关闭为 Interrupted 并暂停，绝不直接重放工具。
- UI 网络失败释放操作锁；换目标时旧请求不能覆盖新目标的编辑/等待状态；完成后不会因刷新消失。

## 6. 格式与发布边界

`goal/execution.change.version=2`。v2 Goal 快照必须有同事务执行事件；状态机验证 scope、revision、消费消息 ID 和轮数增长。JSONL 外层文件版本未改变。

旧二进制不认识新的执行事件；**不支持读过新 Goal 历史后直接降级写入同一数据目录**。完整未知记录/格式错误必须失败关闭，不能当残尾删除；CI 有文件不变性回归。

发布前需要：

1. 本分支跨平台 CI 通过，并确认 UI 重建包含 `patch-goal-runtime.mjs`。
2. 安装前备份整个旧数据目录，再更新后端和 UI 配套包。
3. 已安装实例验证旧 v1 Goal 不自启动、新 Goal 能恢复、待确认仍显示。
4. 若必须降级，使用升级前完整备份或独立数据目录，不能自动删除 goal/execution 事件。

这些发布/安装动作不由本次源码修改自动执行，见 GOAL-08。

## 7. 验收

- 纯决策矩阵：忙/审批/回答/依赖/确认/过期报告/预算/停止。
- Runtime：CAS、用户优先、丢回执、排队删除、未知结果、晚到报告、取消、输出/步骤限制。
- 产品 Host：三轮真实注册工具、确认/清除、阻塞恢复、引用冲突、原子暂停、后台依赖唤醒、重启队列不重复接管。
- 原生 job：owner 隔离、未知/失败不可视为完成、无关任务不阻塞。
- UI：使用实际分发的 React、GoalBar/GoalDock，Chromium/WebKit 验证确认、继续、错误重试、换目标、完成可见和窄屏布局。
- 实际 DeepSeek 正式 Host 链路：3 轮、46 次工具调用、115 个生成代码测试、12 个独立验收，见 [产品实验](../evaluations/goal-product-20260910.md)。

## 2026-09-11：常规 Goal 工具与单框 UI（本地开发，尚未发布）

### 一个与 Bash 同层的工具

正式 Durable Host 每个普通模型轮次都通过现有 `ToolRegistry` 注册 `goal`，无需先输入 `/goal`。同一张模型工具列表里包含 Bash/Read 等原有工具与 Goal。不是新建外层 Loop，也不把长期任务放进 Bash 子命令。

- `create`：`objective`，可选 `max_goal_rounds`（默认 256）。只有用户明确要求持久目标或持续推进时创建，不把普通问题隐式升级为 Goal。
- `get`：返回当前目标、执行状态、预算和 `ref`；没有目标时返回 `goal:null`。
- `update`：携带最新 `ref:{id,revision}`，修改目标或预算，禁用后续自动推进；不会清零历史轮数。
- `pause` / `resume`：携带最新 `ref`，复用原 Host CAS 和状态校验。暂停不杀当前工具。
- `report`：`report:{status,summary,remaining,evidence,blocked_reason}`。只接受自动 Goal 轮次的进展报告。`status=complete` 仍进入待用户确认，不等于验收完成。

模型不拥有 `sessionId`、执行 epoch、完成确认或删除接口。用户并发修改后旧 ref 会失败，模型应重新 `get`，不能覆盖用户更改。`goal` 为独立工具批次：防止同批创建/暂停与报告互相竞争；并非绕开原 Scheduler。

普通轮执行中创建目标只写入授权，原 Controller 的 open-turn 屏障会等待本轮结束，不会重启当前轮或同时生成第二个回答；已有正在执行/排队的 Goal 仍不能重新 Enable。绑定活动会话时不把活跃审批/问答误当崩溃恢复。

`create/update/pause/resume` 调用现有 Goal RPC，使用工具 execution ID 生成持久收据，复用幂等与取消后的已接纳操作语义。开始接纳前取消不写入；接纳后完成原子持久化，取消不撤销已确认写入。

原 `goal_report` 不再作为新请求工具暴露。历史回放仍识别老日志里的真实 `goal_report` 成功记录；新日志只识别 `goal(action=report)` 的成功记录，其他 Goal 操作不能伪造成进度报告。

### UI：只有输入框上方原有 GoalBar

删除 GoalBar 下方额外的 `details/summary` 展开区域，不创建新页面。运行状态、轮数、预算入口、暂停/恢复、完成确认均位于原目标框。预算编辑也留在同一框内；窄窗口允许框内控件换行，不生成第二块展开面板。进展、证据和错误说明保存在原投影，完整说明可在目标框提示中查看。

沿用原有编辑/清除和 mutation 锁；网络失败可重试，切换目标不接受旧操作的异步结果。没有目标时不渲染 GoalBar、不预留空行、不显示“设定目标”。用户以自然语言明确要求设立目标或持续推进，模型通过每轮注册的 `goal(action=create)` 创建；成功后的权威投影驱动状态框出现。仅打开页面、刷新或普通提问不会创建目标。清除目标或切换到无目标会话时隐藏状态框。静默指空状态 UI，不隐藏创建行为、状态或错误。

### 回归与发布边界

- 普通 Provider 轮次发现 `goal` → 工具创建目标 → 原轮完成 → 自动目标轮报告；验证没有额外 `goal_report` 定义。
- 创建重试收据不重复建目标；新旧 ref 冲突；编辑暂停自动推进；恢复后用户确认。
- 参数混用、未知操作、跨会话字段、缺失字段、零预算、无 Goal 报告、取消均失败且不误写。
- 保留多轮推进、依赖、崩溃恢复、未知结果不重放等既有回归。
- Chromium/WebKit：仅一个目标框、无 details、移动宽度、完成/恢复、异常重试、异步过期操作、预算编辑。
- 安装包必须通过 CI 重新构建发布后才更新用户桌面。禁止单独改已签名 App 内部资源并假装升级成功。
