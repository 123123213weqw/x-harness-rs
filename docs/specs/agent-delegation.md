# 单工具子 Agent（第一版）

## 目标与边界

只新增一个模型工具 `agent`，复用现有 Session、DurableInbox、AgentSupervisor、
Driver、LoopEngine 和 Tool Registry。不是 shell Job；不实现第二套模型循环。
生产入口为 `xharness-host-app`，Web 与 Tauri sidecar 使用相同入口。
本次未发布安装包、未替换用户当前应用，也未修改用户现有对话。

## 协议

| action | 参数 | 语义 |
| --- | --- | --- |
| start | task；可选 label | 创建独立子会话，持久化任务后返回 agent_id / message_id |
| send | agent_id、message | 运行中安全 Steering；空闲时下一轮；暂停时只入队 |
| inspect | 可选 agent_id | 指定孩子状态，或列出自己的直接孩子 |
| stop | agent_id | 中断当前轮，保留未领取消息，暂停后续派发 |

工具根 Schema 使用便携 object + action enum；Rust tagged enum 严格验证分支字段，
拒绝跨 action 字段、缺参、空文本和未知操作。不把 parent/sender 身份交给模型填写。
任务/消息最大 32 KiB UTF-8；label 最大 160 bytes；ID 最大 256 bytes。

- `accepted` 只是准入／中断受理，不表示任务完成或进程已经退出。
- `inspect.status`：running、stopping、paused、idle。running 包含等待执行容量，
  首版不向模型宣称该状态代表已经开始生成或正在执行某条命令。
- 停止后已经领取的 Steering 不重新入队，避免重复上下文和副作用。
- 首版所有停止都暂停派发；模型 send 不擅自解锁暂停。用户在子会话发消息可恢复。
  后续可区分“用户暂停”与“父 Agent 中断”，但不能悄悄改变停止语义。
- 父子只允许直接父级控制直接孩子；首版禁止孩子继续创建孙级。

## 分层与复用

- `xharness-agent::AgentOperation / DelegationRuntime`：无 UI、OS、Provider 依赖的委派契约。
- `xharness-host::AgentTool`：现有 ToolSpec / ToolExecutor 的薄适配。
- Host 委派协调层：绑定调用者、创建关系、复用消息准入/控制/状态投影。
- NativeToolFactory 用 Weak<BasicHost> 绑定，避免 Host→Runtime→Factory→Host 强引用环。
- 子级复制创建时的模型、推理、上下文设置、工作区、权限、Preset、PlanMode；
  不复制父对话历史。任务必须自包含。API Key 不进入会话描述符。
- 不允许模型通过 start 自选更高权限、任意目录、任意父级身份。
- NativePlatform 保持同工作区/权限缓存，继续复用文件观察版本与路径锁。
  任意 shell 写入和跨权限实例的写冲突不承诺事务隔离；独立工作树属于后续。

## 执行与并发

关键修正：`admit_turn` 只持久化 Inbox 并订阅事件，不立即调用 followup 唤醒；
`start_turn` 明确唤醒。保留每条准入消息的事件订阅，避免 TTFT 前的队列投影回归。

TurnRequestFactory 提供默认空的容量租约接口。DurableTurnFactory 对孩子申请共享
Semaphore，默认至多 2 个真实子模型轮次；租约覆盖工具和模型执行直至本轮结束。
等待容量时仍处理取消，不领取待执行消息；通过 Parked 事件结束宿主等待，不能挂死。

全局至多接收 16 个 running/待运行子会话；每个父级目录至多 128 个孩子；
目标 Inbox 至多 32 个待处理项。超限返回明确错误。首版这些是实现默认值，
尚未提供 UI 可调配置。主 Agent 的模型请求不占子 Agent 的这两个名额。

## 持久化与通知

- `agent/delegated`：父级、调用幂等 ID、初始任务。
- `agent/dispatch-paused`：持久化派发暂停。
- `turn/end`：正常完成、失败、取消、达到限制的通知源。
- `agent/settlement-delivered`：通知已持久化进入父 Inbox。
- `agent/delegation-failure` / `agent/failure-delivered`：准备阶段无法写正常 TurnEnd
  的故障兜底；暂停工作，防止重启后自动重复失败或副作用。

子结果通知固定 ID，以父 Inbox 准入回执去重。先持久化父消息再记录投递完成；
中间崩溃允许重试，不要求两个 Session 跨文件事务。创建在描述符落盘后、首消息
准入前中断时，恢复扫描可补投同一初始消息。

后台监听器只扫描发生变化的已停稳子会话，每秒一轮，复用既有日志；
结果最长 8 KiB，按 UTF-8 边界截断并标记。不会把子 Agent 全部工具日志注入父上下文。
父级活跃时通知排入下一轮；父级空闲时唤醒；父级暂停时只落盘。
父级等待孩子期间不轮询模型，但 UI 目前仍可能把父级显示为 idle；
聚合 waiting 状态属于后续 UI 工作，不伪称已完成独立 Waiting 状态机。

**并发写日志约束**：暂停和投递确认是允许并发追加的控制事件。Core 的 journal
冲突重试白名单必须包含它们，否则中断会表面 accepted、内部以 journal conflict 失败。
真实 DeepSeek 控制测试发现并修复了该问题，回归必须检查持久化 cancelled 终态。

多轮真实任务还发现历史刷新竞态：较早取得的 Session 快照可能在较新快照之后应用，
误报 moved behind cursor。现在以独立、会话级投影锁覆盖读取→投影→广播；不同会话
仍并行。回归用 8 个并发刷新者和 32 次控制写入验证游标不倒退。

## 测试与真实模型验收

Rust 编译、单测、Clippy 均在 WZU_Server 的 `~/codex-build/x-harness-rs/` 执行。
本机仅 fmt、源码编辑及 Python 驱动，不编译 Rust。

最终远程 workspace 回归全量通过（4 项环境/人工集成项 ignored）；
`cargo clippy --workspace --all-targets -- -D warnings` 通过，Host Linux 二进制构建通过。

回归覆盖：
- 单工具注册、严格参数、空白/Unicode/长度边界；
- 重复 start/send、不同 payload 重用调用 ID、越权、递归深度；
- 6 个子任务实际模型并发峰值为 2；
- 活跃/等待容量时取消；持久化 cancelled；不丢未领取消息；
- 暂停父级收到通知不唤醒；重启恢复父子关系与待处理通知；
- 取消前不创建孩子；准备失败的持久化通知和暂停兜底。

真实模型脚本：`scripts/agent-live-eval.py`，复用 compaction-ablation 的 RPC/进程
管理辅助函数。凭据从 stdin 传入子进程环境，不写参数列表、不提交、不打印。
每次使用全新临时工作区、独立 Host 和状态目录；绝不使用用户现有会话。

2026-09-06 DeepSeek V4 Flash 实测：

| 实验 | 结果 |
| --- | --- |
| 两子 Agent 独立实现 mean/suffix，父级收通知后运行 unittest | 37.87 s；2 次 start；独立验收通过；无工具错误 |
| 初次控制链路 | 模型参数合法，但 Debug 发现暂停控制事件引发 journal conflict；不算底层通过 |
| 修复后控制链路 | 26.61 s；start→send→inspect→stop；子级持久化 cancelled；Debug 无 failed run |
| 修复后重复编程任务 | 37.31 s；2 次 start；两个孩子 completed；独立验收通过；Debug 无 failed run |
| 多轮追加 Windows 路径需求 | 71.22 s；start→start→send；复用原子 Agent，无第三个孩子；3 个验收测试通过；Debug 无 failed run |

首轮编程测试驱动曾误读 session.list 的 items 字段导致过早停止；已修正，
该次结果不计入模型正确率。多轮实测首轮还因历史投影竞态被中止，修复后重跑通过。
有限样例只能证明这些场景可用，不代表普遍成功率。

## 后续 TODO（不混入本次完成项）

- 子 Agent 独立 Provider/Profile/工具白名单选择、外部后端和多层谱系。
- 配置化容量/队列限额；细分 queued/model/tool/waiting 的可观测状态。
- 父级等待孩子的 UI 聚合状态；立即/下一轮通知策略可配置。
- stop 的用户/Agent 来源区分；整棵子树停止和独立后台托管语义。
- 跨权限/外部进程写冲突与 worktree 隔离，审批聚合 UI。
- 大规模目录和超长历史压测；投递故障退避/日志限流。
- 故障注入覆盖每一个持久化写入断点，扩大真实模型任务集。
- CI 打包、Web/Tauri 端到端交互验收与发布。新事件不应直接拿旧二进制读；
  升级/回退需要保留状态备份，不能宣称任意旧版本无损降级。
