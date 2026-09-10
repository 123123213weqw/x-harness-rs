# Goal：产品运行时与现有 UI 接入

状态：2026-09-10 源码已接通，Linux 远程回归、Chromium/WebKit 和正式 Host 真实 DeepSeek 实验通过。**本分支尚未合并发布，也未替换用户已安装软件**。

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

复用上游 `dsh-client-ui-goal` 的 GoalBar、GoalDock、编辑/暂停/恢复/清除按钮和命令气泡；没有另做目标管理页面。补充的展开区显示轮数、执行状态、报告、剩余事项、证据、错误详情和轮数预算编辑。

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

## 3. 唯一新增模型工具：goal_report

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
