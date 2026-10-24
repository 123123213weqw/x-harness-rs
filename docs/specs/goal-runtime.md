# Goal：产品运行时与现有 UI 接入

当前运行时设计以本文「2026-10-22：用户控制与轮内报告分离」为准，Goal 正文查看/编辑 UI 以「2026-10-25：目标全文与多行编辑」为准；之前的日期章节保留为历史设计记录，不表示普通模型轮仍暴露 `goal` 管理工具。源码变更不等于已发布安装包。

## 2026-10-22：用户控制与轮内报告分离

- 创建、查看、编辑、暂停、恢复、完成和清除由已有 `/goal` 命令及 GoalBar 调用原 Host RPC；CAS、操作回执、去重和持久化不变。自然语言请求不再经模型工具隐式升级为持续运行目标。
- 普通轮不注册 `goal`、`goal_report` 或新的计划工具。删除原 `goal` 多动作工具，模型不能通过该工具创建/恢复目标或维护普通清单。
- 仅自动 Goal 输入的持久 ID 与当前 pending intent 匹配时注册 `goal_report`。同一未结束 Goal 轮的审批/问答恢复也保留报告能力；仅有一个 active/pending Goal、引用 Goal 提示词或普通用户输入均不足以获得该工具。
- `goal_report` 是独立的简短报告接口，参数只有 `status`、`summary`、`remaining`、`evidence`、`blocked_reason`，没有 lifecycle action、目标 ID、预算、目标文本或清单字段。字段绑定和证据验证沿用现有实现，完成策略未改成独立评估器，不新增模型调用。
- 保留成功报告、权威正常 TurnEnd、所需依赖和旧 `UserConfirm` 策略的现有完成门禁。暂停/换目标后，旧报告仍由激活代次及目标版本拒绝。
- 旧 `goal(action=report)` 和旧 `goal_report` 的成功历史结果继续按真实 tool call/result 配对读取；不迁移或执行旧调用。旧计划事件、RPC、投影和 UI 继续可读。由于普通轮没有 `goal` 能力，依赖 `goal.get` 的工作计划快照不再注入新请求；不在本轮新增替代清单工具。
- 此步不重做 Goal 状态机、用户命令界面或自动验收器，也不把报告伪装进其他模型工具。
- 部署 allowlist 保持 fail-closed：旧配置若显式要求已退役的 `goal` 工具，不会静默删掉该要求。`goal_report` 也只能在自动 Goal 轮可用，普通轮不能用 allowlist 强行激活报告能力；默认未限制的生产模式无需调整。

验收覆盖普通轮工具列表、旧动作拒绝、真实 `/goal` 启动、三轮续跑、UserConfirm、暂停/恢复、过期和无效报告、依赖、取消/失败、冷恢复、旧清单保留及原 UI 行为。

## 2026-10-25：目标全文与多行编辑

- GoalBar 常驻区展示最多两行目标摘要；点击正文打开原位 Modal，全文可选择、复制和滚动，不再只依赖悬浮提示。长文本不会把聊天操作栏挤出屏幕。
- 详情窗口复用平台 Modal，桌面宽度最高 840px，窄屏适应窗口；完整目标、暂停/阻塞原因及已有进度/证据投影可一起查看。
- 从详情或 `⋯` 菜单进入大尺寸 textarea，保留所有正文与内部换行；Enter 只换行，Ctrl / ⌘ + Enter 或保存按钮才提交。IME 组合输入不触发保存。取消不会调用 mutation。
- 编辑草稿绑定查看时的 Goal ID 与正文；累计轮数引起的 revision 变化不阻止保存，但正文被其他来源修改或 Goal 被替换时禁止覆盖，保留草稿并提供明确的重新载入按钮。RPC 仍使用当前权威投影的 CAS ref。
- 网络错误保留草稿，pending 操作单次提交；切换 Goal 时立即关闭旧编辑器，不等异步回执或 effect 才隐藏。
- 此 UI 修复不开放模型管理工具，不改变目标编辑后执行授权失效、用户恢复、完成验收或既有生命周期语义。

## 2026-10-22：紧凑的用户操作栏

- `/goal <objective>` 仍是创建入口；后续操作主要通过输入框上方的 GoalBar 完成，不要求用户记住子命令。原生命周期命令/RPC 保留兼容；轮数预算命令明确退役。
- 目标文字可点击编辑，轮数只展示累计统计；只常驻当前状态及暂停/继续（完成后为重新开启）。低频的编辑、标记完成和清除放入 `⋯` 菜单。
- 旧 `UserConfirm` 等待确认时，明确显示确认完成及继续；其他未完成状态也可从菜单手动标记完成。清除需二次确认，不删除聊天记录和已有文件。
- 暂停只阻止后续自动轮，不替代聊天停止按钮；除移除轮数上限外，完成门禁和其他暂停原因不变。
- 菜单/对话框复用平台 Menu/Modal；错误可见并可重试，操作 pending 时锁定，切换 Goal 后旧回执不得影响新卡片。窄屏分两行，不把全部按钮挤进一行。
- `node scripts/preview-goal-controls.mjs` 在 `127.0.0.1:3198` 提供真实组件的交互预览；只使用内存示例投影和 RPC 回执，不连接真实 Host、聊天、账号或模型。

## 2026-10-22：轮数只作统计，不再限制执行

- 移除纯决策器、Goal claim、Host resume、Session enqueue/claim/snapshot/resume 校验中全部「累计轮数与旧上限比较」的策略判断。不用 `u64::MAX` 冒充无限上限。
- 每次真正 claim 自动 Goal 输入时累计一次；仅排队、等待、普通用户输入不会增加统计。暂停/恢复、控制器重建和日志恢复不会重置计数。整数溢出仍返回明确错误，不允许回绕。
- UI 显示 `257 轮`，不显示 `257/256`，不提供预算按钮/菜单/编辑框；`/goal` 返回累计轮数，已退役的 budget 子命令返回明确错误且不变更目标。
- `maxGoalRounds` / `max_goal_rounds` 作为旧 journal、bootstrap 和 RPC 的兼容元数据保留（包括原字段缺省值及正整数形状校验），不参与调度、恢复或 UI。旧 RPC 元数据编辑仍遵循原 receipt/CAS，但不能施加执行上限。旧 `round_budget` 暂停原因可读；不会擅自激活已暂停目标，用户点击继续后不再受该字段限制。
- 完成报告、用户确认、依赖、用户暂停/取消、工具审批、OutcomeUnknown、连续缺报告和 Provider 有界重试保持原门禁；取消总轮数上限不等于取消错误保护。
- 新版本可读原日志，无需批量改写历史。新记录的统计可能超过旧上限，旧二进制可能因旧校验拒绝这些新增记录；不保证运行新版本后降级回旧二进制。
- 回归包含旧上限为 1 的真实 Host 三轮完成、258 轮的真实 Controller/Inbox/Session 生命周期、到达旧上限后暂停/恢复、256 轮处重建和恢复、旧预算命令不修改状态、统计与菜单的 Chromium/WebKit 验证。

## 1. 直接使用

在已有输入框使用：

```text
/goal 实现 CSV 导入，补齐错误处理和测试，最后写使用说明
/goal
/goal pause
/goal resume
/goal edit 修改后的完整目标
/goal complete
/goal clear
```

复用上游 `dsh-client-ui-goal` 的 GoalBar、GoalDock、编辑/暂停/恢复/清除按钮和命令气泡；没有另做目标管理页面。2026-09-11 改为在同一个 GoalBar 内显示状态、轮数和操作，不再追加下方展开区。

- 新建 Goal 显式开启持续推进。旧日志只有 v1 Goal 时不自动启用，用户点击“启用自动推进”或 `/goal resume`。
- 新建 Goal 沿用 `AgentReport`：有效完成报告在正常轮次结算和依赖门禁后自动完成。旧 `UserConfirm` 目标仍等待用户确认。完成状态保留在 GoalBar，可由用户重新开启，不会自行消失或恢复。
- 暂停只停止**后续自动轮次**，不回滚文件，也不自动取消正在执行的工具。要立即取消当前轮，使用对话原有停止按钮。
- 编辑目标会使旧执行授权失效；需明确恢复，不把旧完成报告当新目标验收。轮数不会重置。
- 累计轮数仅为统计，不因达到任何旧上限暂停；`/goal budget ...` 明确返回已退役，不创建新目标或更改状态。
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

### Goal 依赖故障与普通聊天隔离（2026-09-11）

- 只有明确启用且处于 active 的 Goal 才检查其自动推进依赖；暂停、禁用、完成和旧版未启用状态不重新解析旧 Job 引用。
- 依赖解析失败时持久化 Goal 暂停与具体错误，撤销尚未执行的自动续轮意图，随后继续消费普通用户消息。禁止把依赖错误作为整个 Agent 收件箱的失败返回。
- 日志/暂停持久化失败仍然 fail closed；不伪造依赖成功、不重放旧 Job、不删除对话或自动恢复 Goal。
- 回归覆盖依赖错误、依赖仍运行、暂停/禁用 Goal、过期自动续轮、两次 driver 重建后的普通聊天与无额外 Goal 轮数。

### 重启恢复顺序

先恢复 Control 配置，再解析凭据并激活模型路由，最后恢复会话与消费队列。禁止空的 bootstrap registry 提前拒绝已有消息。配置激活失败时清空旧路由并保留错误和设置入口，不使用旧配置执行排队工作。

## 报告资源引用门禁（2026-10-09）

- `goal` 的 `action=report` 对 `progress`、`blocked`、`complete` 都执行引用准入检查；Agent/Job 的 `reference` 必须是精确资源 ID，不得夹带空白、括号说明或不可见字符，也不自动裁剪/猜测 ID。说明放在 `summary`。
- Host 在返回成功报告 metadata 前检查资源存在性及当前会话归属。无效引用返回 `invalid_goal_reference` 工具错误，模型可以在同一轮修正并重新报告；无效报告不写入 Goal 状态、不因此暂停 Goal。
- `SessionToolFactory::validate_goal_references` 只验证身份/归属，`goal_dependencies` 仍负责运行状态与完成门禁。运行中或失败资源可以作为进度/阻塞证据，不能凭“引用有效”宣称已经成功完成。
- 未提供资源验证服务的 factory 对 Agent/Job 引用失败关闭；无资源引用及 Artifact 路径/URL 沿用原规则，Artifact 不新增文件读取或真实性背书。
- 本次不修改历史日志解码、RPC 格式、轮数预算、自动恢复或用户暂停语义；已暂停的旧 Goal 不会被自动修复引用或重新启动。

## 持久化 Provider 恢复与问题范围（2026-10-09）

- Core 在 durable `turn/end` 的 `failed` 原因里附带可选 `provider_failure` 分类。仅明确的可重试传输诊断、408/429/5xx 进入恢复；不通过错误文本关键词推断。鉴权、参数、协议、本地持久化失败以及旧日志缺少分类的失败仍暂停。
- Goal 持久化 `retry`（失败轮次、连续失败次数、UTC 毫秒截止时间），5 秒起指数退避，遵守更长的 Provider Retry-After，最多自动续试 5 次。等待期间不消费轮数、不排队新模型请求；真正开始的新轮次沿用原轮数预算。成功轮次重置计数，连续耗尽后暂停并保留错误详情。
- 重启重放沿用已记录截止时间与去重键；现有 Host watcher 唤醒到期的活动 Goal。用户输入优先；暂停、编辑、取消及结果未知不自动恢复。当前失败轮次存在未结工具调用或 `outcome_unknown` 时不创建恢复计划；恢复是新模型轮次，保留历史工具结果，不重新执行旧工具调用。
- `ask_user_question.questions[].blocksGoal` 可选，默认 `true`（旧记录行为不变）；设置 `false` 表示问题超时 deferred 后独立工作仍可继续。问题仍保留在 UI，迟到回答照原来的持久化投递机制送达；不伪造答案，不改变工具权限或审批。需要答案才能继续时使用 `true`，或报告明确的 blocker。
- Goal 投影展示 `network_backoff`，已失败轮次中的 complete 报告不视作等待完成确认。公共 `turn/end` UI DTO 与现有 RPC 方法保持不变；日志新增字段向后读取兼容，但不承诺旧版严格解码器能读取新版含 retry 的 Goal 状态。

## 2026-10-09：由模型报告完成（本 PR，尚未发布）

- 新建 Goal 默认采用既有 `AgentReport` 模式：模型判断目标与验收条件已满足后调用 `goal(action=report)`，报告 `status=complete`、空 remaining 和证据，再结束当前轮。Runtime 在权威正常 TurnEnd 后自动持久化 Complete，不需要再点用户确认。普通正文“完成了”不算结构化报告，失败／取消轮也不能完成。
- 保留引用存在性、归属、必要后台依赖就绪与当前目标版本／激活世代校验；不引入第二个 LLM 评判器。接受模型完成声明不是独立证明任务已通过所有验收。
- 已持久化的 v2 Goal 保留原 `verification`：旧 `UserConfirm` 仍显示等待确认，恢复／重启不会偷偷变为自动完成。没有批量改写正在运行的目标或历史文件。新执行／新 Goal 才默认 AgentReport。
- 冷启动与 watcher 使用一致的等待确认口径：只有 UserConfirm 的正常结束轮次才等待确认；带完成报告的失败轮次仍恢复已持久化退避，AgentReport 的未结算完成轮次仍进入恢复。
- 投影增加可选 `verificationMode`，调度 watcher 与 UI 的等待确认状态仅用于 UserConfirm。自动完成后保留原目标框、报告与历史，显示“已完成”，不继续轮询调用模型。用户点击“重新开启”才通过已有 Resume RPC 建立新激活世代，沿用已有轮数预算和 CAS；旧完成报告不会完成新世代。
- 本轮没有取消总轮数预算，也没有更改网络退避次数、工具审批或 OutcomeUnknown 保护；这些与完成判断独立。
- 验收覆盖实际 Host/Core 自动三轮完成且不再续轮、普通轮创建 Goal 后自动完成、旧确认模式及恢复兼容、显式重新开启、网络恢复后自动完成、引用纠正后自动完成、前端完成可见／无确认／仅点击后恢复。Windows 测试夹具使用平台合法的临时目录，不放宽生产绝对路径校验。
