# 单工具子 Agent（第一版）

## 目标与边界

只新增一个模型工具 `agent`，复用现有 Session、DurableInbox、AgentSupervisor、
Driver、LoopEngine 和 Tool Registry。不是 shell Job；不实现第二套模型循环。
生产入口为 `xharness-host-app`，Web 与 Tauri sidecar 使用相同入口。
本次未发布安装包、未替换用户当前应用，也未修改用户现有对话。

## 协议

| action | 参数 | 语义 |
| --- | --- | --- |
| start | task；可选 label；provider/model/reasoning_effort 仅传递用户明确指定的选择 | 创建独立子会话，继承设置或先获用户确认，再持久化后返回 agent_id / message_id / model |
| send | agent_id、message | 运行中安全 Steering；空闲时下一轮；暂停时只入队 |
| inspect | 可选 agent_id | 指定孩子状态、模型与最近持久结算；省略 ID 时列出自己的直接孩子和父会话设置与配置模型能力 |
| stop | agent_id | 中断当前轮，保留未领取消息，暂停后续派发 |
| revert | agent_id、checkpoint_seq、message | 主 Agent 显式选择完整前缀，建立受管纠偏分支；保留原历史，不回滚文件 |

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
- 子级默认继承创建时的模型、推理、上下文设置；仅用户明确请求且逐调用人工确认后允许覆盖。
  工作区、权限、Preset、PlanMode 继续继承；
  不复制父对话历史。任务必须自包含。API Key 不进入会话描述符。
- 不允许模型通过 start 自选更高权限、任意目录、任意父级身份。
- NativePlatform 保持同工作区/权限缓存，继续复用文件观察版本与路径锁。
  任意 shell 写入和跨权限实例的写冲突不承诺事务隔离；独立工作树属于后续。

## 用户请求＋逐调用确认的子模型选择（2026-10-09）

仍只有一个 `agent` 工具，允许用户通过聊天明确指定子模型／思考强度；模型仅传递选择。
用户没有指定时完整继承父会话设置，不按任务复杂度／成本自主选择其他模型或强度。

```json
{"action":"inspect"}
{"action":"start","task":"独立只读审查","provider":"configured-provider","model":"configured-model","reasoning_effort":"high"}
```

### 硬约束，不仅是 description

- start 覆盖值实际改变路由或强度时，Host 注册的单调 Guard 要求现有逐调用审批。
  没改变设置时不弹确认，也不把等待确认放进全局创建锁，其他会话可继续工作。
- 使用既有确认卡片：显示目标 provider/model、强度与父设置，用户允许一次后才创建孩子。
  普通 full-access 和 AI-review **都不代替这次人工确认**；不会让模型审查自己是否能换模型。
- Guard 的精确绑定进入既有 `approval/asked.reason`，Core 保留 Guard 原因而非丢弃。
  绑定只包含调用者、调用 ID、参数哈希、当前用户请求序号和父／子配置，不重复写任务正文。
- Handler 再查持久化的 ToolCall、绑定和对应 `approval/decided: allowed-once`。
  模型提供 `authorized=true`、任务文本声称用户同意、单纯问过 ask_user_question、
  临时 ApprovalProvider 返回 Approved，都不能替代这一对持久化事实。
- 确认期间父设置、目标默认强度、任务参数或已提交用户请求改变，旧确认失效并返回明确错误。
  拒绝、停止、取消、审批不可用或超时均不创建／执行孩子；迟到答复不能恢复已结束调用。
- Host 不通过自然语言关键字推测用户授权。description 引导只在用户明确指定时传参；
  最后的人工卡片是可验证边界，即使模型误解或擅自提议，仍不能静默执行。
  这是模型工具边界，不声称能阻止具有任意本机 Shell 权限的程序自行修改配置或调用本机 API。

### 路由与恢复

- provider/model 必须来自运行时注册目录；inspect.models 只返回 ID、合法 effort ID 与默认值，
  不含端点、凭据或 wire patch。目录可见不等于获准切换。
- 每项 `models[].start_selectors` 提供可复制的完整 `provider`／`model` 组合。
  选择模型时一起复制；只填 model 仍继承父 Provider，不能自动推测／切换其他 Provider。
  model ID 可以含 `/`，不将 `provider/model` 拼接字符串当作 model 字段。
  配置目录不是实时可用性证明；未知路由错误提示匹配候选但不自动回退。
- 未指定路由时继承父配置；改变路由但未指定强度时使用目标默认值，预算用目标 TokenGuard。
  不向小模型复制父级的大预算。不支持的路由／强度在确认与创建前拒绝，不静默回退。
- 字段只用于 start；send 不能悄悄修改已有孩子配置。既有用户模型 RPC 仍可修改配置。
- 初始路由与 `agent/delegated` 同批使用既有 `session/model-selected` 持久化，不新增日志事件。
  重试对照原始准入，不能覆盖用户后来修改的孩子配置，也不重复启动或重复要求已准入的确认。
  无显式字段的旧调用仍兼容缺少原始模型选择的旧日志。
- 未确认调用重启后仍需要确认，恢复原审批身份与绑定，不因重启而自动执行。
- provider 128、model 512、effort 128 UTF-8 bytes；拒绝空白、控制字符及跨 action 字段。

验收包括真实 ToolExecutor／Core／DurableLoop → 人工 respond RPC → Recording Provider，
覆盖三个权限预设、拒绝、取消、超时、过期确认、不阻塞其他会话、JSONL 审批重启恢复、
模型路由和强度传递、旧记录兼容及准入幂等。Recording Provider 不消耗真实 API 额度。

真实 DeepSeek 参数脚本 `scripts/eval-subagent-model-selection.py` 读取当前工具声明，
使用合成任务，检查用户明确指定／没有指定时的参数；**不执行真实子任务或人工确认**。
实际确认链路由上述真实 Host/Recording Provider 测试验证，不将模型参数实验混称为全链路验收。
另用生产 `NativeToolFactory` 与公开 mux/respond 接口做集成测试，检查 full-access 下仍显示
目标路由／强度确认卡片，未回答不创建孩子，允许一次后才向目标 Provider 传递强度。

此前开放自主选择和中间菜单-only 版本的测试只是历史基线，当前验收以人工确认版本的报告为准。

## 真实请求观察与主 Agent 决策

不增加启动前探测、每次健康请求、模型健康缓存或第二套重试循环。沿用 Core 的请求重试，
结算后由主 Agent 决定下一步；`accepted`／`running` 不是模型响应成功。

- `inspect(agent_id).last_settlement` 与自动送达父 Inbox 的结算使用同一权威终态；
  自动回执保持旧 payload／去重指纹，额外观察只通过 inspect 读取，兼容旧版投递崩溃窗口。
  尚未结算为 null；结果带 work_id、turn、settlement_seq、timestamp_ms，明确属于历史结算，
  不表示当前正在执行的轮次。事实直接来自既有日志，重启可重建，不新增事件格式。
- `outcome` 保留原始终态。失败时已有 `provider_failure` 原样保留 retryable、http_status、
  retry_after_ms；旧日志缺少分类时保持未知，不靠错误文字猜测。
- `execution` 仅显示本轮已记录的请求路由、是否观察到输出／记录到工具调用。
  `request_recorded` 只是请求日志事实，不代表网络成功；未观察到输出也不是无副作用证明。
  请求正文、凭据、工具参数和推理内容不加入这些观察字段。
  没有权威 turn/end 的准备／宿主故障标记为 `without_turn_end`，不声称没有执行工具。
- 主 Agent 可读失败回执后选择 `send` 在同一孩子继续，避免重复创建；不新增自动复活／换模型。
  认证／权限等错误先修配置，临时失败参考已记录分类。重试有副作用的工作先核对已执行结果。
  已停止／暂停的孩子仍遵守显式用户恢复门禁；send 不解锁暂停。

受控验收注入 400／401／403／404、429／503、部分输出后失败；检查首请求次数、父级回执、
同孩子重试与去重、重启恢复，以及不因观察而发起额外 Provider 请求。

## 执行与并发

关键修正：`admit_turn` 只持久化 Inbox 并订阅事件，不立即调用 followup 唤醒；
`start_turn` 明确唤醒。保留每条准入消息的事件订阅，避免 TTFT 前的队列投影回归。

TurnRequestFactory 提供默认空的容量租约接口。DurableTurnFactory 对孩子申请共享
Semaphore，默认至多 4 个真实子模型轮次；租约覆盖工具和模型执行直至本轮结束。
等待容量时仍处理取消，不领取待执行消息；通过 Parked 事件结束宿主等待，不能挂死。

全局至多接收 16 个 running/待运行子会话；每个父级目录至多 128 个孩子；
目标 Inbox 至多 32 个待处理项。超限返回明确错误。首版这些是实现默认值，
尚未提供 UI 可调配置。主 Agent 的模型请求不占子 Agent 的这四个名额。

子轮次并发支持启动时选择 2 / 4 / 8（不是每个聊天各自的额度）：

- 默认 4；设置环境变量 `XHARNESS_DELEGATION_CONCURRENCY=8` 可选择 8。
- Host 参数 `--delegation-concurrency 2` 可选择 2，命令行优先于环境变量。
- 其他值（包括 0、空字符串、负数）明确报错，不会启动后挂起队列或静默回退。
- Web 和 Tauri sidecar 使用相同 Host 入口；桌面启动的进程需要继承该环境变量。
- 仅下次启动生效，不提供运行中调整，也不修改正在进行的会话或持久化默认值。
- 嵌入库使用 `DelegationConcurrency` 和
  `DurableLoopAgentRuntime::from_registry_with_delegation_concurrency` 显式选择容量。
  原有 `new` / `from_registry` 签名不变，默认使用 4；库内部不读取进程环境变量。

模型工具 `agent.start` 不能自行修改并发、权限或队列上限。这里限制的是完整子轮次，
不代表模型服务商请求配额或工具子进程数；真实服务商限流和重工具预算仍需分别考虑。

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
父级活跃时通知排入下一轮；父级健康空闲时唤醒；父级暂停或最近 Turn 不可重试失败时只落盘。
失败门禁来自权威 `turn/end`，Host 与 Actor 共用同一投影；内部回执不算用户恢复，
不自动重启压缩或模型请求。人类明确重试后才能继续处理，旧回执与原历史仍保留。
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
- 6 个子任务默认实际模型并发峰值为 4；显式 2/4/8 共用相同调度路径；
- 第 5 个排队任务取消不领取输入；不同父会话共享容量；主会话不占子任务名额；
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

- 子 Agent 独立 Profile/工具白名单选择、外部后端和多层谱系。
- 配置化容量/队列限额；细分 queued/model/tool/waiting 的可观测状态。
- 父级等待孩子的 UI 聚合状态；立即/下一轮通知策略可配置。
- stop 的用户/Agent 来源区分；整棵子树停止和独立后台托管语义。
- 跨权限/外部进程写冲突与 worktree 隔离，审批聚合 UI。
- 大规模目录和超长历史压测；投递故障退避/日志限流。
- 故障注入覆盖每一个持久化写入断点，扩大真实模型任务集。
- CI 打包、Web/Tauri 端到端交互验收与发布。新事件不应直接拿旧二进制读；
  升级/回退需要保留状态备份，不能宣称任意旧版本无损降级。

## 父子会话导航契约（2026-09-07 修复）

上游面包屑仅沿 `origin: "subagent"` 的 `parentId` 向上遍历。
Host 必须在子会话的 `session.list` 摘要和 `host/session-added` 推送中同时提供
`origin: "subagent"` 与 `parentSessionId`；重启后从持久化 `agent/delegated`
恢复这些字段。普通会话和普通 fork 不能仅因有 parent 就被标记为子 Agent。
之前缺失 origin 会导致面包屑只剩不可点击的当前子会话，无法由此返回主会话。

继续复用上游导航，不新增工具、不取消父子任务、不复制会话。点击父面包屑后选择
父会话，根会话不携带子会话 transport address。

回归：Rust 覆盖实时推送、摘要、重启恢复及普通会话无 origin；
`scripts/test-subagent-navigation.mjs` 从已交付 bundle 提取真实面包屑和选择函数，
在 Chromium/WebKit 验证鼠标、键盘及恢复后的 child → parent 导航。
其中输入框为隔离夹具，不能替代完整原生 App 的 RPC/发送消息端到端验收。
本修复尚未替换本机安装包；安装新 Host 并重连后，既有持久化孩子可恢复该标记。

## 主 Agent 显式小步纠偏（context branch，不是文件回滚）

新增同一 `agent` 工具的 `revert` action。不是自动 retry、自动换模型、第二套模型循环，
也不修改普通 `send`。仅直接父 Agent 可以选择回推位置与纠偏指令：

```json
{"action":"inspect","agent_id":"source-child"}
{"action":"revert","agent_id":"source-child","checkpoint_seq":26,"message":"回到授权范围问题；先核对当前文件，不继续错误登录计划。"}
```

- `inspect.revert_checkpoints` 提供最近最多 8 个完整 StepEnd／TurnEnd 候选（seq、turn、step、工具名及轮次终态）。
  提供事实定位点帮助主 Agent 选择，不暴露工具参数／结果正文／隐藏推理。
  不定时探测、没有检查点 TTL，也不以模型输出耗时判断过期。准入再核对权威日志。
- **回推前缀上下文，不擦除原历史**：原孩子完整对话仍保存；新分支保留检查点之前的
  正文、真实推理、工具调用／结果及观察。不是伪造 CoT，不用新摘要代替完整前缀。
- **新分支仍是当前主 Agent 的直接孩子**，返回新的 `agent_id`，后续 send／inspect／stop
  使用这个 ID。不是普通 session.fork，也不是孩子创建孙级。原孩子不会被自动重发任务。
  同工作区的两条轨迹不具备文件事务隔离；主 Agent 不应同时恢复原孩子做依赖性编辑。
- **不回滚文件、Git、远端操作、外部服务**。即使新上下文不含后续写操作，真实效果仍存在；
  Host 在纠偏消息中明确要求核对当前状态，再决定是否重复有副作用的工作。
- 源孩子必须空闲且未暂停，无待派发 Inbox／未决审批／未答问题／未知工具结果，
  无未闭合轮次／压缩，无 Goal／Schedule。不能通过回推绕过人工暂停或未决操作保护；
  运行中不会偷偷取消。停止后的人工恢复规则与原版一致。
- 必须是权威日志里的完整 StepEnd／TurnEnd；不接受半个工具、流式块或不存在的 seq。
  检查点的模型／权限／Preset／Plan 配置必须与当前孩子一致，不借回推改路由或扩大权限。
  StepEnd 位于已结束源轮次的内部时，在新分支以既有 Interrupted 事实闭合该前缀轮次；
  不伪造 Completed 或成功工具结果。
- 创建确定性分支 ID，前缀＋新的 `SessionForkOrigin`／`AgentDelegated` 一批持久化，
  原委派行政元数据不复制；已消费 Inbox 事实仍保留。新的主归属是出入队／结算命名空间。
  同 invocation、同操作重试返回同一回执；改变指令或检查点冲突。创建后、首次 Inbox
  投递前崩溃，现有 listener 只恢复纠偏消息；历史轮次不重新通知主 Agent。
- `accepted` 仍只证明纠偏消息入队，不代表模型已纠正；UI 展示原孩子、检查点、新孩子与
  “仅回推上下文，不回滚文件”，严格核对双方 ID 和检查点回执。

验收分层：受控 Host／DurableLoop 测试验证前缀、工具配对、源历史不变、真实文件标记不变、
无工具重放、所有权、幂等、停止和冷恢复；真实模型入口为
`crates/xharness-host-app/examples/subagent_revert_acceptance.rs` 与
`scripts/experiments/live-subagent-revert.py`，只在 V100 一次性合成目录验收，上游 API Key 留在本机，远端只持有受请求次数限制的临时 relay nonce。
真实验收是方向变更链路，不把合成故障／模型参数实验当作生产任务质量全面通过。
