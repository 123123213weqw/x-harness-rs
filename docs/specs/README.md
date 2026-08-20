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
| `xharness-host` | [有状态 Web Host](host.md) | 已实现 52 个基础行为及真实 Loop/工具/事件桥接 |
| `xharness-core` | [核心 Agent Loop](core-loop.md) | 已实现，已在 Linux 测试 |
| `xharness-provider-openai` | [OpenAI-compatible Provider](provider-openai.md) | 已实现，协议和真实 Chat 已测试 |
| `xharness-session` | [事件溯源 Session](session.md) | 已实现 |
| `xharness-session-jsonl` | [JSONL Session 存储](session-jsonl.md) | 已实现 |
| `xharness-tools` | [工具注册与执行管线](tools.md) | 已实现 |
| `xharness-process` | [子进程运行时](process.md) | 已在 Unix 实现 |
| `xharness-fs` | [工作区文件系统](filesystem.md) | 已在 Linux/macOS 实现 |
| `xharness-sandbox` | [原生沙箱](sandbox.md) | Bubblewrap 已实现并实测；Seatbelt 已交叉检查 |
| `xharness-platform` | [原生平台门面](platform.md) | 已在 Linux/macOS 实现 |
| `xharness-terminal` | [持久 PTY](terminal.md) | 已在 Unix 实现 |
| `xharness-web` | [网页搜索与抓取](web.md) | 已实现 |
| `xharness-coding-tools` | [标准 14 工具包](coding-tools.md) | 已实现并通过真实 Loop 测试 |

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
