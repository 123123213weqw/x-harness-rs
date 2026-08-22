# 标准 Coding 工具包规范

**Crate：** `xharness-coding-tools`
**状态：** 14 个工具已实现；正式 Registry 和 Core 兼容桥均可使用。

## 组合

`CodingToolBundle` 绑定一个 `NativePlatform`、`TerminalRegistry`、`WebRuntime`、Session ID
和 Owner ID。`specs()` 返回正式 `xharness-tools` Spec；`register/registry` 填充唯一
Registry；生产 Host 将投影后的 Spec 注册为一个 `ToolExecutor`，直接赋给
`LoopRequest.tool_executor`。Core 已落账的 Durable Execution ID 原样绑定到内部 `ToolRequest`。

旧 `core_specs()` 兼容桥和自动批准 Provider 已删除。交互式审批由 Core 的 Runtime Bridge
实现 `ApprovalProvider`，真正的 Schema、Policy、调度、Timeout 和 Handler 生命周期只有正式
Executor 一层。

v0 只暴露以下 14 个稳定模型工具名：

| 工具 | 必填输入 | 并发 | 审批 | 契约 |
|---|---|---:|---:|---|
| `bash` | `command` | exclusive | 是 | 在平台沙箱执行一次 `/bin/bash -lc` |
| `read` | `path` | parallel | 否 | 分页读取、版本绑定 Cursor 并记录 Observation |
| `write` | `path`, `content` | 按 path keyed | 是 | Create/Observed-version 原子 Replace |
| `edit` | `path`, `old`, `new` | 按 path keyed | 是 | 恰好一次 UTF-8 Literal Replace |
| `glob` | `pattern` | parallel | 否 | 直接 Argv `rg --files -g` |
| `grep` | `pattern` | parallel | 否 | 直接 Argv `rg`，可选 Path/Case Mode |
| `terminal_open` | `name` | exclusive | 是 | 命名的持久 Interactive Bash PTY |
| `terminal_send` | `name`, `input` | 按 name keyed | 是 | 写入、有限等待、增量读取 |
| `terminal_read` | `name` | 按 name keyed | 否 | 从可选 Byte Cursor 读取 Scrollback |
| `terminal_signal` | `name`, `signal` | 按 name keyed | 是 | 向 Foreground Group 发送白名单 Signal |
| `terminal_close` | `name` | 按 name keyed | 是 | 终止、等待并删除 Terminal |
| `terminal_list` | 无 | parallel | 否 | 列出当前 Owner 的 Terminal |
| `web_search` | `query` | parallel | 否 | 用配置 Provider 搜索，可选 Limit |
| `web_fetch` | `url` | parallel | 否 | 匿名、有界抓取公共页面 |

全部 Schema 设置 `additionalProperties=false`。Result 是 JSON Text，并在可用时携带强类型
Metadata。Process Tool 报告 PID、Exit Code/Signal、Termination Reason、两条输出流、
Truncation 和总 Byte Count。

`specs()` 生成完整的 14 工具候选集；正式 Host 会在每个模型 Step 前根据平台
Readiness、Search Provider 和现存 Terminal 投影稳定子集。最小 Coding System Prompt 已由独立
`xharness-prompt` 注入，工具定义仍是另一条协议字段。Profile/Step 级进一步裁剪和完整选择审计
仍待实现。

## 环境与路径

Process Tool 只提供受管环境（PATH、Locale、Terminal/Pager 控制），不继承环境凭据。
Relative Cwd 固定在 Workspace；Absolute Cwd 仍需通过 Platform Sandbox Policy。
`glob`/`grep` 直接调用 `rg`，不经过 Shell 解释。

## 工具选择语义

`bash` 用于有权威完成状态的一次性命令。需要持久/交互状态时使用 `terminal_*`。
`terminal_send` 的 Settle 只代表观察完成，后续进度要用 `terminal_read`/Status。
`web_search` 用于发现来源，`web_fetch` 用于抓取一个已知 URL。

如果 Sandbox Probe 已经返回确定性不可用，模型不应再次调用 `bash/glob/grep/terminal_open`；
Host 必须在下一 Step 移除这些进程启动工具，而不是只靠错误字符串提示模型。已有 Terminal 的
read/signal/close 按 Session 状态单独投影。一次工具失败后，模型应先
判断是否已有足够证据；禁止为了“再看一个文件”无限扩大上下文。

## 大输出与读取

`read` 默认页为 32 KiB/400 行，支持 `offset`、`start_line`、`limit`、`line_limit` 与
`next_cursor`。`cursor` 不能与起点或新 Limit 混用；它固定原页限制并绑定文件 SHA-256，避免
文件变化后错误拼页。结果保留完整 Byte Count、页起点、捕获 Byte、Hash、Truncation 与
Observation Version。大结果 Spill Reference 仍待实现。

`glob/grep/bash/terminal` 输出同样必须先经过工具级 Byte Cap，再进入全局 Context Policy。
Core 对超限单结果使用确定性 Head/Tail Envelope；单个结果未超过 256 KiB 不代表多个结果可以
安全并行写入下一次请求，持久 Spill/历史 Surface Reduce 仍待实现。

## 验证

确定性集成测试注册全部 14 个名称，并执行真实 Write → Read → Edit → Bash 流程。
可选 Live Test 把全部 Schema 发给 V100 上的 Qwen，观察模型选择 `write`、请求审批、真实
修改文件、重放 Tool Result、进入第二个模型 Step，最终 `Completed`。

## 当前限制

- Description 仍是简洁 v0 版本；更丰富的“何时用/何时不用”和 Profile/Step Tool Subset 已计划。
- `read` 已分页，但其他工具输出和历史 Tool Result 尚无统一 Spill/Reduce。
- Platform Probe 失败已自动缩小进程工具 Projection；相同 Readiness 尚未投影到 Web UI。
- 尚无 Background Bash Job、Patch Tool、目录修改、Image Read、Browser、MCP、LSP 或
  Subagent Tool。
- 完整 CLI/Host 还必须配置 Approval UX、Session Durability、Provider、Search Credential
  和 Platform Policy。
