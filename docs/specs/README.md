# XHarness 规范索引

本目录是 Rust 工作区的规范性契约。文中的“必须”“禁止”“应当”“可以”分别对应
RFC 2119 的 `MUST`、`MUST NOT`、`SHOULD`、`MAY`。源码代表当前实现；如果源码与
规范不一致，则该变更在规范、测试和实现统一之前都不算完成。

## 变更规则

每个改变行为的 Pull Request 必须：

1. 指明受影响的规范；
2. 更新公开契约、不变量或限制；
3. 新增或更新验收测试；
4. 如果完成或新增了计划工作，同步更新 [`../TODO.md`](../TODO.md)。

## 已实现规范

| Crate | 规范 | 当前状态 |
|---|---|---|
| `xharness-api` | [Web 线协议](api.md) | 已实现 52 个 RPC 及 frame/envelope 目录 |
| `xharness-server` | [Web 服务承载层](server.md) | 已实现 HTTP/WS/静态资源承载 |
| `xharness-host` / `host-app` | [有状态 Web Host](host.md)、[LLM/Provider Registry](model-registry.md)、[启动恢复](host-restore.md)、[Web Session 投影](web-session-projection.md)、[模型性能与 Token 投影](metrics-projection.md) | 52 个基础行为；多 Provider/Model 路由；History 直接刷新权威 Session；可恢复 Queue/Pending Turn；完整性能投影计划中 |
| `xharness-agent` | [长生命周期 Agent](agent.md) | Inbox、Supervisor、多 Turn/Steer、Registry、本机 Lease 与恢复 Wake 已实现 |
| `xharness-core` | [核心 Agent Loop](core-loop.md) | 已实现，已在 Linux 测试 |
| `xharness-provider-openai` | [OpenAI-compatible Provider](provider-openai.md) | 已实现，协议和真实 Chat 已测试 |
| `xharness-session` | [事件溯源 Session](session.md) | 已实现 |
| `xharness-session-jsonl` | [JSONL Session 存储](session-jsonl.md) | 已实现 |
| `xharness-tools` | [工具注册与执行管线](tools.md) | 已实现 |
| `xharness-process` | [子进程运行时](process.md) | Unix Process Group / Windows Job 已实现并原生测试 |
| `xharness-jobs` | [后台 Job 注册表](jobs.md) | 已实现五态、Owner 隔离、增量输出与 Shutdown |
| `xharness-schedule` | [持久定时提醒](schedule.md) | 已实现三工具、Session 事件、Idle-only 唤醒、重启恢复与 Web 实时投影 |
| `xharness-fs` | [工作区文件系统](filesystem.md) | Linux/macOS/Windows 已实现并原生测试 |
| `xharness-sandbox` | [原生沙箱](sandbox.md) | Linux Bubblewrap、macOS Seatbelt、Windows ACL partial 后端已实现 |
| `xharness-platform` | [原生平台门面](platform.md) | Linux/macOS/Windows 已实现并原生测试；模型侧 Capability 投影已接通 |
| `xharness-terminal` | [持久 PTY](terminal.md) | Unix PTY / Windows ConPTY 已实现；不在默认模型工具面 |
| `xharness-web` | [网页搜索与抓取](web.md) | 已实现 |
| `xharness-coding-tools` | [标准 11 工具包](coding-tools.md) | Unix Bash / Windows PowerShell 7 与后台 Job 已实现 |
| `xharness-interaction` | [用户提问与等待交互](user-questions.md) | 类型/状态机、Registry、Session/Host/Web 持久恢复和 AGENTS.md Sink 已实现 |
| `xharness-context` | [上下文预算](context.md) | Surface 抽象、原生/后备 Token Guard 与 Durable Compact 接线已实现 |
| Web Context Inspector | [上下文检查器](context-inspector.md) | RequestHeader 完整输入投影、第三个 Context Tab、颜色分类与压缩前后视图已实现 |
| `xharness-compaction` | [上下文压缩](compaction.md) | 自动 Pressure/Overflow、摘要重计量、Session Replace 与 Web 投影已接线；手动命令/生产 Pruner 待完成 |
| 发布验收 | [DeepSeek Flash 真实 Coding 验收闭环](live-deepseek-evaluation.md) | 五级门禁已冻结；真实任务按 REL-08 持续执行 |
| `xharness-debug` | [Full Debug Trace](debug-trace.md) | Host/Core/Provider/Tool/Process/Terminal/Sandbox/Web/Server 全链路 Debug Trace 已接线 |
| `xharness-token` | [上下文预算与压缩](context.md) | TokenMeter、保守后备与请求前 Hard Guard 已实现 |
| `xharness-prompt` | [Prompt 组装与注入](prompt.md) | v1 最小确定性注入已实现；完整 Registry 计划中 |
| Linux Packaging | [`.deb` 安装与沙箱自配置](linux-deb.md) | Helper/打包已实现；真实 4080 安装待管理员授权 |

部署和故障定位见 [`../operations.md`](../operations.md)。该文档记录平台 Probe、模型真实窗口、
当前 Web Host 边界以及 2026-08-21 的上下文超窗样本。

## 状态术语

- **已实现**：公开契约已经存在，验收测试通过。
- **已交叉检查**：目标平台可以编译和 lint，但本仓库测试没有在该系统上原生运行。
- **计划中**：只列在总 TODO 中，目前没有兼容性承诺。
- **兼容桥**：调用方迁移到正式服务期间暂时保留的 API。

## 全局不变量

1. 模型可见历史来自 Session 投影，不能来自临时可变的 UI 状态。
2. 有副作用的工具必须先记账再执行；崩溃后的未知结果禁止自动重放。
3. 缺少策略、审批或受限沙箱能力时必须 fail closed（默认拒绝）。
4. 模型 Provider 不负责文件系统、进程、终端或 UI 行为。
5. 操作系统差异必须收敛在 `xharness-platform` 及更底层的原生 crate。
6. 取消是协作式的；Run 报告结束前必须给受管任务一个有界清理窗口。
7. 即使工具并发执行，写回模型的结果仍必须保持模型调用顺序。
8. 凭据禁止进入 Session 快照或模型可见的工具输出。
9. 发起 Provider 请求前必须把 System、历史、工具 Schema、模板开销和输出预留计入同一
   上下文预算；超限时禁止网络 I/O。
10. UI 预设、工具注册和模型实际收到的 Prompt/Tool Projection 是三件不同的事；Request
    Header 必须记录模型真正看到的版本。
11. 已确认不可用的平台能力不得继续投影成可调用工具。
12. Provider 的输出上限必须是可审计的一等终态；不得把 `max-tokens` 伪装成通用失败，
    也不得执行或重放达到上限时尚未闭合的 Tool Call。
