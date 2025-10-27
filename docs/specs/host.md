# 有状态 Web Host 规范

**Crate：** `xharness-host`（控制面库）、`xharness-host-app`（原生组合与二进制）
**状态：** 上游 52 个 RPC 已有内存基础实现；真实 Rust Loop、14 个原生工具、流式投影、
审批链路和 Session 导出已经接通。
**兼容快照：** `deepseek-harness@141eb6fef8`。

## 目标

`xharness-host` 是冻结的 Web 线协议与 Provider-neutral Rust 运行时之间的业务适配器。
它必须阻止 Web DTO 渗入 `xharness-core`，并把操作系统分支限制在
`xharness-platform` 及其下层。

Host 已从部署组合中抽离：控制面库不再依赖 OpenAI Adapter、HTTP Server、Coding Tool
Bundle、Platform、Terminal 或 Web Runtime。`xharness-host-app` 负责选择这些实现并生成
`xharness-host` 可执行文件。未来 CLI、Daemon 或嵌入式宿主可以直接复用控制面库，而无需
链接默认 Web Server 和原生工具组合。

当前 `BasicHost` 有意把控制面状态放在内存中。它是可执行的兼容基线，不是最终持久
Agent Store。未来替换成持久 Agent/inbox 时，禁止改变 52 个方法名、四象限 RPC 信封
和事件帧形状。

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
               platform + terminal + web（14 工具）
```

`xharness-host-app` 二进制负责组合这些层，默认只绑定 loopback。Provider 协议必须显式选择
Chat Completions 或 Responses，禁止自动回退。

`BasicHost::new_with_context_policy` 显式接收 `Arc<dyn ContextPolicy>`；兼容构造器 `new` 暂时
安装 Identity 策略。Host 不得在 Turn Driver 内重新实现 Context 裁剪规则。

第二阶段进一步定义 `AgentRuntime::start_turn(AgentTurnRequest) -> RunningTurn`。BasicHost 的
队列/事件投影只依赖这个契约，不再直接创建 Loop、调用 Tool Factory 或持有 Provider/Context。
`LoopAgentRuntime` 负责把当前 LoopEngine 适配进来，并校验 Session 选择的 ModelRoute。以后替换
为 Durable Agent/Inbox Runtime 时，不需要修改 52 个 RPC 和 Web 投影代码。

当前 `AgentPreset.content` 只存在于 Host 状态/RPC 投影，`run_turn` 没有把它转换成
`Role::System`。因此“UI 选中了 coding preset”和“模型收到 Coding System Prompt”不是一回事。
当前只有工具 `name/description/Schema` 被 Provider 请求注入。

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
- **Goal（6）：** 带 revision 校验的创建、编辑、暂停、恢复、完成、清除。
- **Settings（5）：** 带 namespace revision 的描述、打开、更新、替换、变更。
- **Credentials（3）：** 仅返回“是否存在”，支持内存 set/unset；禁止返回值本身，
  禁止覆盖环境变量拥有的凭据引用。
- **LLM（3）：** 已配置 Provider、模型和基础发现投影。

不支持的原生 UI 能力必须返回明确的业务错误或中性 Optional 结果，不能表现为路由缺失。

## Turn 驱动器

`session.prompt` 保留客户端 RPC ID 作为队列输入 ID，追加 Web `turn/start` 和
`user/message`，然后通过 `AgentRuntime` 启动 `RunningTurn`。运行事件按顺序投影为 `step/start`、
`assistant/chunk`、`tool/call`、`tool/result`、`assistant/message`、`step/end` 和
`turn/end`。

同一时间只能有一个 Driver 拥有一个 Session。额外 Prompt 进入 FIFO 队列。Steering
交给活跃 `RunningTurn`；取消只停止当前 Turn，不删除排队输入。当前所有权只在进程内成立；
在声明崩溃恢复能力前，必须升级为持久 Lease/Inbox。

每个 Step 当前通过默认 `IdentityContextPolicy` 完整重放 `session.messages`，并固定注入完整
14 工具。Host 没有读取目标模型 Context Window、预留输出或在 Provider I/O 前计量请求。
正式 Driver 必须改成：Preset/System 组装 → Capability Tool Projection → Context Surface →
Token Guard → Prepared Call，并把实际输入版本写入 Request Header。

## 审批与事件流

需要审批的工具产生带关联 ID 的 `approval/requested` `ServerRequest`。Pending 记录保存
Session、Approval、Execution、工具名和活跃控制通道。`/api/respond` 必须同时校验
Session ID 与 Approval ID，之后才能发送 `ApproveTool` 或 `RejectTool`。缺失或过期
关联必须 fail closed。Core 真正处理后发送 `approval/resolved`。

Session 事件、队列/投影变化和审批流量走 Mux；Host 生命周期、状态和错误走 Host 流。
新的 Mux 订阅者会收到运行中 Session 与待审批项的基线。广播 lag 以 `stream/error`
报告；目前尚无 cursor replay。

## 原生工具

`xharness-host-app::NativeToolFactory` 为每个 canonical Workspace 缓存一个
`NativePlatform`，并共享按
Owner 隔离的 Terminal 和 Web runtime。每个 Session 通过
`CodingToolBundle::core_specs()` 得到稳定的 14 工具：

```text
bash read write edit glob grep
terminal_open terminal_send terminal_read
terminal_signal terminal_close terminal_list
web_search web_fetch
```

缓存的 Platform 让文件观察记录跨 Turn 保留。Terminal Owner 是 Session ID。注入真实
Search Provider 前，搜索明确不可用；网页抓取仍可使用。

Platform 初始化还必须暴露 Readiness。当前 Bubblewrap Probe 错误只会在调用 Process Tool
时作为工具结果出现，下一 Step 仍保留同一批工具；目标行为是将 Probe 失败投影给 UI，并从
后续工具集合移除 `bash/glob/grep/terminal_open`；已有 Terminal 的管理工具按 Session 状态
保留，同时保持受限模式 fail closed。

## Session 导出

Backend 生成确定性的 JSON，包含内存 Session 记录和事件历史。`xharness-server` 添加
Content-Type 和下载文件名，并把 Session 不存在映射为 HTTP 404。未来持久导出器可以
增加格式，但必须保留现有 JSON 选项。

## 当前限制

- 进程退出后会丢失 Host 状态、Credential Override、Attachment、Settings、Preset、
  Goal、Queue 和 Pending Approval。
- 持久 `xharness-session`/JSONL 尚未成为 Host 状态源，因此不能承诺重启续跑或跨进程
  Lease。
- Subagent 方法目前只有血缘和继续对话，没有自主 Spawn。
- Attachment 是有界 metadata/data-URL 桥，不是计划中的内容寻址多模态 Blob Store。
- 事件广播有界，但 lag 后没有 replay cursor。
- 尚无 Host 认证、Origin Policy、健康/就绪检查和远程暴露控制；二进制默认必须只监听
  loopback。
- Credential 更新只是进程内配置，不能重建已经运行中的 Provider。
- Agent Preset 尚未成为真实 System Prompt；缺少 Prompt Version 与请求体级验证。
- 没有整体 Token Budget/Compaction；完整文件结果可能在下一 Step 触发 Context 400。
- 固定 14 工具投影不会随 Sandbox/Search 能力变化。

## 验收标准

测试必须调用全部 52 个方法并证明目录完全覆盖；完成真实文本 Loop Turn；覆盖
Workspace/Session/Fork/Settings/Goal/Export 状态变化；通过 ClientResponse 恢复一个
真实的审批工具。发布门禁还必须在 Linux 上启动 Host 二进制做 HTTP 烟测，并对 macOS
目标做交叉检查。新增门禁必须解析实际 Provider Request，断言 System Prompt/工具子集，
并重放 `64,196 > 53,248` 上下文样本和 Sandbox Probe 不可用后的动态工具投影。
