# 标准 Coding 工具包规范

**Crate：** `xharness-coding-tools`
**状态：** 14 个工具已实现；正式 Registry 和 Core 兼容桥均可使用。

## 组合

`CodingToolBundle` 绑定一个 `NativePlatform`、`TerminalRegistry`、`WebRuntime`、Session ID
和 Owner ID。`specs()` 返回正式 `xharness-tools` Spec；`register/registry` 填充唯一
Registry；`core_specs()` 把同一个 Executor 适配到当前 `xharness-core::ToolSpec`。

兼容桥禁止绕过正式 Schema 校验、并发、Timeout 或 Result Mapping。桥仍存在期间，交互式
审批由 Core 管理。

v0 只暴露以下 14 个稳定模型工具名：

| 工具 | 必填输入 | 并发 | 审批 | 契约 |
|---|---|---:|---:|---|
| `bash` | `command` | exclusive | 是 | 在平台沙箱执行一次 `/bin/bash -lc` |
| `read` | `path` | parallel | 否 | 有界读取并记录 Observation |
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

当前 `core_specs()` 会让 Host 在每个模型 Step 注入上述 14 个 `name/description/Schema`。
最小 Coding System Prompt 已由独立 `xharness-prompt` 注入；工具定义仍是另一条协议字段。
最终实现必须根据平台 Readiness、Search Provider、Profile 和 Step 选择稳定子集，并将选择写入
Request Header。

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

当前 `read` Schema 只有 `path`，底层默认最多读取 256 KiB、2,000 行、单行 16 KiB。
这些限制用于内存安全，不是合适的模型上下文页大小。P0 必须增加显式 Byte/Line Range、下一页
Cursor 和更小默认页；大结果使用 Spill Reference，并保留原始 Byte Count、Hash、Truncation
与 Observation Version。

`glob/grep/bash/terminal` 输出同样必须先经过工具级 Byte Cap，再进入全局 Context Policy。
单个结果未超过 256 KiB 不代表多个结果可以安全并行写入下一次请求。

## 验证

确定性集成测试注册全部 14 个名称，并执行真实 Write → Read → Edit → Bash 流程。
可选 Live Test 把全部 Schema 发给 V100 上的 Qwen，观察模型选择 `write`、请求审批、真实
修改文件、重放 Tool Result、进入第二个模型 Step，最终 `Completed`。

## 当前限制

- Description 仍是简洁 v0 版本；更丰富的“何时用/何时不用”和动态 Tool Subset 已计划。
- `read` 尚无分页参数，可能一次向模型历史加入数万 Token。
- Platform Probe 失败目前不会自动缩小下一 Step 的进程工具 Projection。
- 尚无 Background Bash Job、Patch Tool、目录修改、Image Read、Browser、MCP、LSP 或
  Subagent Tool。
- 完整 CLI/Host 还必须配置 Approval UX、Session Durability、Provider、Search Credential
  和 Platform Policy。
