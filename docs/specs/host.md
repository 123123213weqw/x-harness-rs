# 有状态 Web Host 规范

**Crate：** `xharness-host`（控制面库）、`xharness-host-app`（原生组合与二进制）
**状态：** 上游 52 个固定 RPC 已有内存基础实现；另接通 Typert `commands/list`、
`commands/execute` 动态端点、权限投影、真实 Rust Loop、11 个 Coding/Job/Web 工具、流式投影、审批链路
和 Session 导出。
**兼容快照：** `deepseek-harness@141eb6fef8`。

## 目标

`xharness-host` 是冻结的 Web 线协议与 Provider-neutral Rust 运行时之间的业务适配器。
它必须阻止 Web DTO 渗入 `xharness-core`，并把操作系统分支限制在
`xharness-platform` 及其下层。

Host 已从部署组合中抽离：控制面库不再依赖 OpenAI Adapter、HTTP Server、Coding Tool
Bundle、Platform、Job 或 Web Runtime。`xharness-host-app` 负责选择这些实现并生成
`xharness-host` 可执行文件。未来 CLI、Daemon 或嵌入式宿主可以直接复用控制面库，而无需
链接默认 Web Server 和原生工具组合。

当前 `BasicHost` 仍把 Session 摘要、Web Queue Projection 和 Driver Attachment 作为内存派生
缓存，但 Workspace/Settings 已进入独立 Control Log，Prompt Admission、模型历史、Web History
和 Agent Driver 已切到持久
Session/Inbox Store。`session.history` 会在读取前刷新权威 Session Cut；运行中和启动恢复共用
同一个纯投影函数，详细契约见 [Web Session 确定性投影](web-session-projection.md)。
启动时会通过 `Store::list_headers` 从强类型日志重建 Session、History、模型路由、Workspace 归属和
Pending Queue，并在订阅后续跑。它仍不是最终持久 Host Store；继续替换时禁止改变 52 个方法名、
四象限 RPC 信封和事件帧形状。详细顺序见[Host 启动恢复规范](host-restore.md)。

## 组合结构

```text
DeepSeek Harness Web dist
        | HTTP + 两条下行 WebSocket
xharness-server / xharness-api
        |
BasicHost（session/workspace/settings/approval 投影）
        |
AgentRuntime -> RunningTurn
        |
LoopAgentRuntime（兼容适配器）
        |                         |
LoopEngine + ModelProvider   SessionToolFactory
                                  |
                 host-app::NativeToolFactory
                                  |
             platform + jobs + web（11 工具）
```

`xharness-host-app` 二进制负责组合这些层，默认只绑定 loopback。Provider 协议必须显式选择
Chat Completions 或 Responses，禁止自动回退。

`BasicHost::new_with_context_policy` 显式接收 `Arc<dyn ContextPolicy>`；兼容构造器 `new` 暂时
安装 Identity 策略。Host 不得在 Turn Driver 内重新实现 Context 裁剪规则。

第二阶段进一步定义 `AgentRuntime::start_turn(AgentTurnRequest) -> RunningTurn`。BasicHost 的
队列/事件投影只依赖这个契约，不再直接创建 Loop、调用 Tool Factory 或持有 Provider/Context。
`LoopAgentRuntime` 保留给内嵌测试和兼容调用。正式 `xharness-host-app` 已使用
`DurableLoopAgentRuntime`：JSONL Session 是模型历史真源，File Lease 排除另一进程同时驱动相同
Agent，连续 Turn 由 Durable Inbox/AgentSupervisor 执行；`AgentRuntime::admit_turn`、
`remove_pending_input` 和 `replace_pending_input` 把持久准入与 Web Queue 变更置于统一边界，
52 个 RPC 和 Web 投影代码没有改变。

正式 Runtime 已组合 [`ModelRegistry`](model-registry.md)。同一个 Supervisor 可以按 Session
选择把不同 Turn 路由到 4080、V100 或云端 Adapter；Provider 公共身份、上游模型名和每路由
Token Guard 相互分离。Web 的 `llm.providers`、`llm.models`、`session.models` 直接投影该
Registry；未注册选择在写入 Session 前返回 `model-unavailable`。

持久 Agent 主链路已经完成：`session.prompt` 在返回成功前完成 Durable Inbox Append + Flush，
RPC ID 同时是稳定 Inbox ID；Queue Edit/Remove 先修改持久 Inbox，再更新内存 Projection。
`BasicHost` 的 FIFO 仅剩进程内 Driver Attachment/Projection 职责。Host 能从 Session Log 和 JSONL
目录确定性重建可推导投影；History 直接按 Cursor 查询权威日志且内存只留有界尾部，Queue 从完整
Durable Inbox 历史折叠 `next-turn + next-step`。剩余迁移工作是把通用 Mutation Receipt 扩展到
Create/Fork/Cancel/Attachment 等 RPC、补 Credential Reference，并继续减少可丢弃兼容缓存。

固定 RPC 目录与生成式 Remote 目录必须保持分离。`RpcMethod::ALL` 仍严格等于上游 52 个固定
方法；`/api/<namespace>/<method>` 只在 Backend 明确声明动态端点时分发，未知动态端点保持
HTTP 404。当前先实现 Web 控件依赖的 `commands/list` 和 `commands/execute`；动态目录已暴露
`permission` 与 `plan` 两个命令。

选中的 `AgentPreset.content` 已由 `xharness-prompt/v1` 与权限、Workspace、Coding Workflow、
Plan Policy 确定性组装，并作为每轮第一个 `Role::System` 进入 Provider 请求。Request Header
记录 Section/Assembly/System 与工具定义 Hash；System 不进入 Transcript。正式 Host 已组合
`xharness-token` Hard Guard；完整动态 Prompt Registry、自动 Context Compaction 和按能力裁剪
工具仍未实现。

## RPC 基础实现

`RpcMethod::ALL` 中每个方法都必须被分发，并校验基础实现所需的 payload：

- **Session（12）：** 列表、搜索、创建、事件历史、模型选择、重命名、Fork、
  Prompt/Steer 入队、附件查询、队列修改、当前 Turn 取消。
- **Subagent（4）：** 直接子 Session 的列表、历史、继续对话、中断。当前子节点是
  Fork Session；自主创建和并发策略留给后续 Agent 层。
- **Host（5）：** 描述、非交互目录选择结果、有界目录列表、创建目录、支持平台上的
  原生路径打开。
- **Workspace（7）：** 列表、创建、重命名、删除、排序、Session 排序、归档投影。
- **Skill（1）：** 确定性的内置 coding skill 目录。
- **Agent Preset（6）：** 列表、选择、读取、复制、打开文档投影、删除。
- **Goal（6）：** 带 Revision 校验的创建、编辑、暂停、恢复、完成、清除；每次成功 Mutation 先
  Flush `goal/change` version 1 全快照，Clear 保留下一 Revision Tombstone。默认 Round 上限 256。
- **Settings（5）：** 带 namespace revision 的描述、打开、更新、替换、变更。
- **Credentials（3）：** 仅返回“是否存在”，支持内存 set/unset；禁止返回值本身，
  禁止覆盖环境变量拥有的凭据引用。
- **LLM（3）：** 多 Provider/Model Registry、稳定分组目录和显式配置发现投影。

不支持的原生 UI 能力必须返回明确的业务错误或中性 Optional 结果，不能表现为路由缺失。

## Turn 驱动器

`session.prompt` 保留客户端 RPC ID 作为队列输入 ID，先通过 `AgentRuntime::admit_turn` Flush
Durable Inbox，再加入 Web Projection 并返回成功。正式 Agent 领取时通过
`AgentEvent::TurnStarted.input_ids` 将预准入消息和对应 `RunningTurn` 绑定；Host 再追加 Web
`turn/start` 和 `user/message`。运行事件按顺序投影为 `step/start`、
`assistant/chunk`、`tool/call`、`tool/result`、`assistant/message`、`step/end` 和
`turn/end`。

同一时间只能有一个 Driver 拥有一个 Session。额外 Prompt 进入由 Durable Inbox 派生的 FIFO
Projection。Steering 交给活跃 `RunningTurn`；取消只停止当前 Turn，不删除排队输入。File Lease
提供单机跨进程所有权；远程多主机仍需要 Fencing Epoch。

每个 Step 无压力时通过默认 `IdentityContextPolicy` 完整重放当前 Session Surface。Host 已按
平台能力投影工具，并从选中 Registry Route 读取真实 Context Window、输出预留和安全余量；正式
Durable Runtime 默认安装 `CompactionConfig`，在 80% Pressure、Hard Overflow 或无 Delta 的
Provider Context Overflow 时提交持久 Checkpoint Replace、重新计量后再继续。手动 `/compact`、
Provider Purpose Router、按模型精确本地 Tokenizer 和 Capability 进一步裁剪仍未实现。

## 审批与事件流

需要审批的工具产生带关联 ID 的 `approval/requested` `ServerRequest`。Pending 记录保存
Session、Approval、Execution、工具名和活跃控制通道。`/api/respond` 必须同时校验
Session ID 与 Approval ID，之后才能发送 `ApproveTool` 或 `RejectTool`。缺失或过期
关联必须 fail closed。Core 真正处理后发送 `approval/resolved`。

Session 事件、队列/投影变化和审批流量走 Mux；Host 生命周期、状态和错误走 Host 流。
新的 Mux 订阅者会收到运行中 Session 与待审批项的基线。广播 lag 以 `stream/error`
报告；目前尚无 cursor replay。

## 权限预设

当前产品提供两个会话级权限预设：

- `workspace-write`：原生 Sandbox 限制到 Workspace，写入、终端和其他有副作用工具逐次审批。
- `danger-full-access`（UI 显示为 **Full access**）：Web 客户端在切换前显示一次风险确认；确认后
  当前 Session 使用无权限沙箱 Platform，并把工具审批策略设为 `never`，不再重复逐工具弹窗。
  Rust Platform 内部仍把它建模为绕过限制层的 Access Mode，而不是伪装成受限 Sandbox；但为与
  冻结 Web/Session 协议一致，`sandbox/mode` 的线值记录为 `danger-full-access`。命令仍由
  `ProcessRuntime` 托管，以便取消、超时和 Process Group 清理；它不承诺受限沙箱才有的硬后代
  containment。

`permissions` Session Projection 是 UI 的真源；切换通过 `/permission <preset>` 的
`commands/execute` 动态端点完成，并顺序记录 `command/run`、`permission/preset`、
`sandbox/mode`、`approval/policy`、`command/done`。运行中的 Session 禁止切换，避免一个 Turn
混用两种权限。Settings 的 `permission.defaultPreset` 只决定之后创建的新 Session，同样由 Web
Full access 风险确认保护。Durable Runtime 在 RPC 返回前 CAS Append 并 Flush 这些事件；Host
重启折叠最后一个 `permission/preset`，不会退回默认值。

Idle Plan Mode 也走同一命令审计面：`/plan` 进入、`/plan off` 退出，成功时按
`command/run → plan/mode → command/done` Flush，Session Projection 返回
`plan={active,pending:false}`，重启折叠最后一条 `plan/mode`。重复选择相同状态是幂等成功，不能
制造重复 `plan/mode`。当前运行中 Pending Pre-step、附带 Message/Image 的 Plan Steering、
Plan Prompt Section 与 `exit_plan_mode` 工具尚未实现；这些输入必须明确失败，禁止静默丢弃。

`session.rename` 与 `agentPreset.select` 也进入同一 Per-session Admission Fence：前者追加
`session/title`，后者追加 `agent-preset/selected`。只有 Flush 成功才更新 Host 投影并返回；运行中
允许 Rename，但禁止切换 Agent Preset。

Host 在 Turn 启动时把权限快照放入 `AgentTurnRequest`；`NativeToolFactory` 按
`(canonical workspace, permission preset)` 缓存 Platform。Full access 下，Shell/Terminal
绕过 Seatbelt/Bubblewrap，结构化 Read/Write/Edit 以 `/` 为能力根，但相对路径仍从 Session
Workspace 解析。

在 Durable Workspace Store 完成前，Host 启动时先注册配置的 canonical cwd 为
`workspace-default`，再把 Session Header 中的其他 cwd 确定性映射成 recovered Workspace。
这样重启后 `workspace.list`、`session.list` 和 `session.history` 都能恢复；Workspace 的用户标题、
排序和归档仍没有独立持久真源。

进程级验收测试必须启动真实 `xharness-host` 二进制、连接 HTTP 与 Host WebSocket、杀死进程并
在原地址重新启动。第二个进程的 `workspace.list` 必须立即包含 canonical `workspace-default`，
`session.list/history` 必须包含预置 JSONL Session 和 Assistant Message，新的 WebSocket 必须完成
握手；测试禁止只调用 `BasicHost::new()` 来假装覆盖部署重启。

浏览器发布门禁位于 `tests/web-e2e`。它必须使用真实 Chromium、真实 Host 和已组装 Web dist：
取消 Full access 风险对话框不得改变权限；确认框未勾选时启用按钮必须禁用；确认后当前 Session
投影必须显示 Full access。连接恢复测试必须保持 Host 进程存活，只切断 TCP Carrier，连续制造
至少 8 次失败后恢复，并证明 Web 重新请求 Host、Workspace、Session、History、Settings 基线，
而不是仅把“正在重连”提示隐藏。

## 原生工具

`xharness-host-app::NativeToolFactory` 为每个 canonical Workspace 与 Permission Preset 组合缓存一个
`NativePlatform`，并共享按 Owner 隔离的 Job Registry 和 Web runtime。每个 Session 通过
`CodingToolBundle::specs()` 得到稳定的 11 工具，Readiness 投影后注册为正式 `ToolExecutor`：

```text
bash job_output job_list job_kill
read write edit glob grep
web_search web_fetch
```

缓存的 Platform 让文件观察记录跨 Turn 保留。Job Owner 是 Session ID。注入真实
Search Provider 前，搜索明确不可用；网页抓取仍可使用。

Platform 初始化暴露可缓存 Readiness。正式 Host 已在后续模型 Step 从工具集合移除已确认不可用的
`bash/glob/grep`；Job 控制工具仍保留以收敛历史任务，同时保持受限模式 fail closed。
尚未完成的是把同一结构化原因投影给 Web Workspace Readiness/工具目录，而不是模型
请求侧裁剪。

## Host 结构化关闭

`xharness-host-app` 在 HTTP Server 停止接受新连接后，必须调用
`AgentRuntime::shutdown(10s)`，而不是直接退出 Tokio Runtime。Durable Runtime 使用
同一 Deadline 依次收敛 Agent Supervisor 和 `SessionToolFactory`：前者取消/等待活动
Loop，后者取消并等待共享 Job Registry 中的活跃任务。

关闭结果通过 `AgentShutdownReport { workers, graceful, forced_cleanup,
cleanup_errors }` 返回，并记录 `host/shutdown.completed` Debug Event 后 Flush。只有
`forced_cleanup == 0 && cleanup_errors.is_empty()` 时二进制才能以成功状态退出；
超时 Abort、Job Cancel/Wait 错误和 Tool Factory 清理超时必须成为显式失败。
二进制收到 SIGINT 或 SIGTERM 时先解决 Axum Shutdown Future 关闭 Accept Loop，再收敛
Backend。由于 Hyper Graceful Shutdown 不会主动关闭已升级 WebSocket，Backend 完全静默后
只再给 Transport 1 秒 Drain；仍未退出时 Abort 纯 Carrier Task，并在 Debug Event 中记录
`transportForcedClose=true`。该 Abort 发生在 Provider/Tool/Job/Process 全部收敛之后，不能用来
代替 Backend Cleanup。

## Session 导出

Backend 生成确定性的 JSON，包含内存 Session 记录和事件历史。`xharness-server` 添加
Content-Type 和下载文件名，并把 Session 不存在映射为 HTTP 404。未来持久导出器可以
增加格式，但必须保留现有 JSON 选项。

## 当前限制

- Workspace 用户标题/排序/归档和 Settings 已进入 Host Control Log；Session/History/Queue、选中
  Preset、Title、Model、Permission 和 Goal 从 Session Log 恢复并重新附着 Driver。Credential
  Override、Attachment Blob 与用户自定义 Preset 文档仍未完整持久化；Web Projection 本身仍是
  可丢弃的进程内缓存。
- 持久 `xharness-session`/JSONL 已是模型历史和 Pending Input 真源，File Lease 已用于 Agent；
  审批恢复与八点硬崩溃矩阵已完成，但其他 Mutation RPC 仍缺少通用持久 Receipt，因此不能对外
  承诺整个 Web API 的 Exactly-once 语义。
- Subagent 方法目前只有血缘和继续对话，没有自主 Spawn。
- Attachment 是有界 metadata/data-URL 桥，不是计划中的内容寻址多模态 Blob Store。
- 事件广播有界，但 lag 后没有 replay cursor。
- 尚无 Host 认证、Origin Policy、健康/就绪检查和远程暴露控制；二进制默认必须只监听
  loopback。
- Credential 更新只是进程内配置，不能重建已经运行中的 Provider。
- 最小 Prompt 和 Hard Token Guard 已真实注入；完整 Section Registry 与用户 Preset 持久化尚未完成。
- Plan Mode 目前只完成 Idle 状态持久化；完整 Pre-step Steering、Prompt Section 和退出工具待补。
- 正式 Durable Host 已安装自动 Compaction，可处理 80% Pressure、请求前 Hard Overflow
  和 Provider 无 Delta Context 400；手动 `/compact`、生产 Tool-result Pruner/Spill 和独立
  Summary Purpose 路由仍待完成。
- Full access 会关闭逐工具审批；正式 Host 已按 Sandbox/Search Readiness 动态裁剪
  模型工具，但 Web UI 尚未显示同一能力报告。

## 验收标准

测试必须调用全部 52 个方法并证明目录完全覆盖；完成真实文本 Loop Turn；覆盖
Workspace/Session/Fork/Settings/Goal/Export 状态变化；通过 ClientResponse 恢复一个
真实的审批工具。发布门禁还必须在 Linux 上启动 Host 二进制做 HTTP 烟测，并对 macOS
目标做交叉检查。新增门禁必须解析实际 Provider Request，断言 System Prompt/工具子集，
并重放 `64,196 > 53,248` 上下文样本和 Sandbox Probe 不可用后的动态工具投影。
结构化关闭门禁还必须证明：活动 Turn 取消并持久闭合后才停 Worker，所有
活跃 Job/Process 已退出，关闭后新 Admission 被拒绝，Forced Cleanup 导致二进制非零退出。
