# XHarness Rust 总体架构

XHarness 不把 Provider、工具、权限、持久化和 Web 状态继续堆进一个特权 `while` 循环，
而是拆成有类型的能力边界。DeepSeek Harness 上游用于参考生命周期和持久性语义；Cordis 与
JavaScript 插件加载器不进入 Rust Runtime。

## 全局不变量

1. **Session 事件日志是唯一真源。** 模型可见历史必须可由 append-only 事件推导；Snapshot
   只能是缓存。
2. **有副作用的工具先记账再执行。** 只有 Call、没有 Result 的恢复状态是
   `outcome_unknown`，禁止自动重放。
3. **控制面与历史分离。** Pause、Approval 和 Live Status 属于控制面；被接受的用户/上下文
   输入必须在下一请求前成为持久事件。
4. **权限默认拒绝。** 缺少审批、策略或受限沙箱 Backend 时，禁止暗中提升为允许。
5. **核心与平台分离。** Provider/Store 使用 trait；文件、进程和沙箱由
   `xharness-platform` 在编译期选择，Loop 禁止按操作系统分支。
6. **取消必须达到静止。** Cancel 完成意味着 Provider 流和受管 Tool/Process 已停止，不只是
   Future 被 drop。
7. **任何 Provider 请求都必须先通过上下文预算。** System、历史、工具 Schema、模板开销和
   输出预留共享同一个模型窗口；超过预算不得发起网络请求。
8. **模型只看到实际可用能力。** 平台 Probe 失败后，Host 必须投影能力变化；不能继续把确定
   不可用的工具交给模型反复尝试。

## 分层结构

```text
DeepSeek Web UI / future CLI
               |
      xharness-api + server
               |
     xharness-host（控制面）
               |
  xharness-host-app（原生组合）
               |
  +------------+-------------+
  |                          |
xharness-agent（正式运行时） prompt/context/token/compaction
  |                          |
  +--------- xharness-core --+
              |          |
       provider adapter  xharness-tools
              |          |
       xharness-session   xharness-platform
              |                 |
          jsonl/sqlite     process + fs + sandbox
                                   /          \
                           macOS Seatbelt  Linux Bubblewrap
```

## 一次模型 Step 的数据流

```text
Session 原始事件
  -> Transcript 投影
  -> Prompt Registry 组装 System Section
  -> Platform Capability 选择工具子集
  -> Context Policy 对大结果做 Surface Replace
  -> Token Meter 计量 System + Messages + Tools + Template
  -> 预留 Output + Safety Margin
       | 超预算 -> 本地结构化失败/继续压缩（不发 HTTP）
       | 合法   -> Prepared Provider Call
  -> SSE Delta / Finish / Usage
  -> Assistant 持久化
       | 无 Tool Call -> Turn 结束
       | 有 Tool Call -> 先落账 -> 审批/执行 -> 有序结果 -> 下一 Step
```

当前已经把 Context 从 Core 拆成独立 `xharness-context`，并建立一次性 Surface、替换来源范围
和 Request Header 审计边界。`xharness-prompt/v1` 已把 Preset/权限/Workspace/Workflow/Plan
按稳定顺序真实注入并记录 Hash。`xharness-token` 在 Surface 完成后执行统一 Hard Guard；正式
Host 配置模型时必须声明真实窗口，并使用保守 Byte Meter、输出预留和安全余量。无压力时仍由
`IdentityContextPolicy` 逐字投影；达到 80% 或 Hard/Provider Overflow 时，Core 通过 Durable
Session 事务摘要安全头部、重计量并重试，压缩结果在重启后仍是权威 Surface。

Host 控制面也已完成两层解耦：原生部署组合移动到 `xharness-host-app`；BasicHost 只通过
`AgentRuntime -> RunningTurn` 驱动 Turn。正式二进制已经使用
`DurableLoopAgentRuntime + JSONL Store + File Lease`；`LoopAgentRuntime` 只保留给内嵌测试和
兼容调用，不再是生产 Host 路径。

`xharness-agent` 已交付 `agent/inbox/spliced` 可重放事件、Next-turn/Next-step 投影、Claim 与
Turn 输入同 Revision 提交、进程内 Registry、AgentSupervisor、多 Turn Driver、持久 Steering，
以及 macOS/Linux 文件 Lease。Web Queue 已从完整 Durable Inbox 历史折叠；BasicHost 的 FIFO
只保存运行 Turn 的 Attachment/投影关系，不再是输入真源。

## 模块职责

### `xharness-session`

拥有 Provider-neutral Message、append-only `SessionEvent`、单调 Sequence、CAS Revision、
Transcript 投影和崩溃恢复。JSONL 是首个持久 Backend；后续 SQLite 实现同一 Store Trait。
压缩只能新增/选择 Surface，不能删除原始事件。

### `xharness-core`

拥有流归一化、有上限的模型/工具 Step 和 `LoopRun` 控制。它不包含文件系统、Shell、Web
或 UI 实现。v0 的 Snapshot Store 与 `ToolSpec` 仍是迁移桥。Core 只消费 Context Trait，不再
拥有具体上下文策略。

### `xharness-context`

拥有 `ContextRequest -> ContextSurface` 投影、Policy 身份、Surface Edit 结构验证和请求审计
元数据。它不依赖任何推理后端，也不修改 Session 原始事件。当前已有 Identity 策略，以及独立
`xharness-compaction` 的确定性压力规划、Tool Pair 安全切点、Pruner 和 Summary 接口。Session
Surface Replace 事务、正式 Host 自动 Pressure/Overflow 触发、摘要重计量和中断 Start 恢复已
接线；手动命令与生产 Pruner 仍待完成。

### `xharness-prompt` / `xharness-token`

当前最小 Assembler 已将 Preset、权限、Workspace、Coding Workflow 和 Plan Policy 按稳定版本
组装，并把 System 与 Section/Assembly Hash 写入 Request Header。完整 Registry 后续增加动态
Scope、Variable、Skill 和 Provider Section。Context 层负责 Token 预算、工具结果 Reduce、
Spill Reference 与 Surface Replace。`xharness-token` 提供可替换 `TokenMeter`、保守 Byte 后备、
强类型 Budget/Report/Error；Core 优先调用 Provider 原生完整请求 Token 计数端点，不支持时再用
保守 Meter，并在 Provider I/O 前将预算报告落入 Request Header，同时把输出预留映射为 Provider
Generation Ceiling。三者共同产生可审计的 Prepared Call。

### `xharness-tools`

拥有唯一名称 Registry 和正式执行管线：

```text
解析 + Schema 校验
  -> pre policy
  -> 单调 guard（allow -> ask -> deny）
  -> fail-closed approval
  -> concurrency gate
  -> around -> handler -> post -> finalize -> observer
```

即使安全调用并发完成，持久 Tool Result 和模型重放仍保持原调用顺序。旧的
`xharness-core::ToolSpec` 只是兼容适配器，策略禁止在工具内部复制一份。

### 原生执行层

```text
bash/read/write/edit/glob/grep
  -> shell + filesystem service
  -> xharness-platform（sandboxed(read-only/workspace-write) | full-access）
  -> 受限时 macOS Seatbelt / Linux Bubblewrap；Full access 时无 Sandbox Adapter
  -> process runtime（process group + bounded output）
```

PTY 是独立的 owner-scoped 持久服务，不是“一次性 Bash 的长时间版本”。Process Group 只是
生命周期机制，硬后代隔离属于原生 Sandbox。受限 Backend Probe 失败必须 fail closed；
`FullAccess` 必须由操作者显式选择。它位于 Platform 权限层而不是 Sandbox Mode 内：关闭
Seatbelt/Bubblewrap 权限隔离，但仍通过 Process Runtime 托管进程生命周期。

关闭链路与调用链路方向相反：Host 先关闭新 Admission，Agent Supervisor 向活动
Loop 发送 Cancel，Loop 向正式 Tool Batch 广播 Signal 并 Join，工具等待 Process Group
或返回显式 Cleanup Failure，最后 Host 取消并等待共享 Job Registry。超过共享 Deadline
只能记为 Forced Cleanup，不能对外报告为安全 Cancelled。

标准 Coding Bundle 的 11 个稳定名称为：

```text
bash job_output job_list job_kill
read write edit glob grep
web_search web_fetch
```

交互层另通过同一个正式 Tool Registry 注册第 12 个模型可见工具 `ask_user_question`。它使用
`Exclusive + External Settlement + Standalone Batch`，由 Session/Host/Web 持久链路结算，不属于
Platform Coding Bundle，也不会绕过统一 Schema、Guard、Lifecycle 和审计。

Schedule 层同样复用正式 Registry，额外注册 `schedule_create/schedule_list/schedule_delete`。
它不属于 Process/Job：规则写入 Session 的 `schedule/change`，可丢弃 Timer 只负责唤醒，实际
投递通过 Idle-only Durable Agent Followup 进入普通 Loop/Web 投影。生产默认最多可见 15 个工具，
但仍按平台、Profile 和 Step 动态裁剪。

“稳定名称”不表示每一轮都应该发送全部工具。Host 已按平台与 Search Provider 状态裁剪模型
可见子集；Process 不可用时仍保留 Job 控制器以收敛历史任务。最终工具投影还要加入 Profile/
当前 Step 规则并完整写入 Request Header。底层 PTY Crate 保留，但旧六个 Terminal 工具不再进入
默认模型 Schema。

## Web 组合边界

Web UI 是 Session/Agent 状态的 Projection，不拥有模型历史。`xharness-api` 冻结上游兼容线
协议，`xharness-server` 只负责 HTTP/WS/静态资源，`xharness-host` 负责 DTO 与 Rust Domain
之间的适配。`xharness-host` 不依赖任何原生平台、具体 Provider 或 Server；这些只在
`xharness-host-app` 组合。未来用持久 Agent/Inbox 替换 `BasicHost` 内存状态时，不能破坏
52 个 RPC 名称和事件帧形状。

## 交付顺序

1. 事件溯源 Session、Memory/JSONL Store。**已实现。**
2. Core 契约强化、Tool Registry、原生 11 个 Coding/Job/Web 工具与 3 个 Schedule 工具。**已实现基础版。**
3. Web 兼容 API/Server/Host 和真实 Loop 投影。**已实现基础版。**
4. 上下文预检、分页 Read、工具结果 Reduce、能力投影、真实 Prompt 与自动 Compact。
   **已实现基础版；手动 Compact/生产 Pruner/Spill 待完成。**
5. 长生命周期 Agent、Durable Inbox、Lease、正式 Host 接管与结构化 Shutdown。**已实现。**
6. 认证、游标恢复、Attachment、Skills、MCP、LSP、Subagent 与 Workflow。**计划中。**

先稳定事件、上下文和权限契约，再扩展 Web/Daemon/Subagent。否则每个客户端都会绑定临时内存
模型，并把上下文超窗或权限失败变成无法恢复的 UI 行为。
