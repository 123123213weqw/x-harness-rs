# 标准 Coding 工具包规范

**Crate：** `xharness-coding-tools`
**状态：** 11 个模型侧工具已实现；生产 Host 已统一使用正式 Registry/Executor。

持久用户交互 `ask_user_question` 通过同一 Registry 注册，但由 `xharness-interaction` 提供；
未来提醒 `schedule_create/list/delete` 也通过同一 Registry 注册，但由 `xharness-schedule` 提供；
后台任务状态机由 `xharness-jobs` 提供，完整契约见[后台 Job](jobs.md)。底层
`xharness-terminal` 仍保留为可复用 PTY 能力，但六个 `terminal_*` 工具已经退出默认模型面，
避免模型在一次性 Bash、交互终端、`nohup` 和后台任务之间反复试错。

## 组合

`CodingToolBundle` 绑定一个 `NativePlatform`、进程级 `JobRegistry`、`WebRuntime`、Session ID
和 Owner ID。生产 `NativeToolFactory` 复用同一个 Job Registry，因此新模型 Step 可以读取或终止
前一个 Step 启动的任务；访问始终按 Owner ID 隔离。

`specs()` 返回正式 `xharness-tools::ToolSpec`；生产 Host 按 Capability 投影后注册为一个
`ToolExecutor`。Core 已落账的 Durable Execution ID 原样绑定内部 Tool Request。旧
`core_specs()` 兼容桥和自动批准 Provider 已删除，审批、并发、Timeout、Cancel 和 Panic
只由正式 Executor 管理。

## 模型可见工具

| 工具 | 必填输入 | 并发 | 审批 | 契约 |
|---|---|---:|---:|---|
| `bash` | `command` | exclusive | 是 | Unix 运行 Bash、Windows 运行 PowerShell 7；或以 `run_in_background=true` 注册 Job |
| `job_output` | `job_id` | 按 job_id keyed | 否 | 消费增量 stdout/stderr；可有限等待终态 |
| `job_list` | 无 | parallel | 否 | 列出当前 Owner 的全部保留 Job |
| `job_kill` | `job_id` | 按 job_id keyed | 否 | 幂等请求取消；已结束返回 `already_finished` |
| `read` | `path` | parallel | 否 | 分页读取、版本绑定 Cursor 并记录 Observation |
| `write` | `path`, `content` | 按 path keyed | 是 | Create/Observed-version 原子 Replace |
| `edit` | `path`, `old`, `new` | 按 path keyed | 是 | 恰好一次 UTF-8 Literal Replace |
| `glob` | `pattern` | parallel | 否 | 直接 Argv `rg --files -g` |
| `grep` | `pattern` | parallel | 否 | 直接 Argv `rg`，可选 Path/Case Mode |
| `web_search` | `query` | parallel | 否 | 用配置 Provider 搜索，可选 Limit |
| `web_fetch` | `url`，可选 `focus` | parallel | 否 | 匿名抓取并返回最多 8,000 字符 Reader 摘要 |

全部 Schema 设置 `additionalProperties=false`。Result 是 JSON Text，并在可用时携带强类型
Metadata。`bash` 前台结果报告 PID、Exit Code/Signal、Termination Reason、两条输出流、
Truncation 和总 Byte Count；后台只确认 `job_id/pid/status`，不得伪造命令已经完成。

`web_search` 未配置时从模型工具集合移除。Restricted Process Probe 失败时移除
`bash/glob/grep`，但保留三个 Job 控制工具，以便收集或取消此前已经启动的任务。平台和搜索
Readiness 尚未完整投影到 Web 工具目录。

## 原生 Shell 与后台选择

- 短命令使用前台 `bash`，默认 120 秒、最大 600 秒，Tool 外层保留 610 秒清理窗口。
- 长时间、非交互命令使用 `run_in_background=true`；该模式不接受 `timeout_ms`，必须使用
  `job_output`/`job_kill` 控制。
- “N 秒/某时/每隔多久后提醒我”使用 `schedule_create`，不要启动 Bash/Job 后再 `sleep`；Schedule
  完整契约见[持久定时提醒](schedule.md)。
- 每次调用都是新 Shell；Unix 使用 Bash，Windows 仅使用 PowerShell 7 (`pwsh`)；`cd`、变量、
  函数不会跨调用保存，应使用 `cwd`。Windows 可由 PowerShell 显式调用 `ssh` 或 Git Bash。
- 禁止用 `&`、`nohup`、`disown`、`screen`、`tmux` 或 PTY 模拟受管后台任务。前台命令根进程
  退出后，Process Runtime 会清理同一受管进程组；这些技巧既不能获得可靠状态，也可能形成逃逸
  后代和 Capture EOF 故障。
- 非零 Exit Code 是正常的已完成进程结果，不是 Harness 基础设施异常；模型必须检查
  `success/exit_code` 或 Job `detail`。

## Job 控制语义

`job_output(wait=false)` 立即消费自上次读取后的两条输出流。`wait=true` 默认最多等待 30 秒，
最大 600 秒；超时返回 `running/stopping`，不取消 Job，也不产生 Tool Error。等待本身被用户取消
时只取消此次读取，后台任务继续运行。

模型必须保存每个返回的 Job ID；可继续做独立工作，不应 Sleep/Busy Poll。给最终回答前应收集仍
相关的任务，并终止已经无用的任务。当前 Runtime 已发布进程内 `JobEvent`（Started/Stopping/
Finished）；把 Finished 自动注入 Idle Agent/Wake Turn 属于 Host 下一阶段，尚未伪装为已实现。
Host System Prompt 和 Bash Description 同时注入该规则。三个控制工具只投影公开状态字段，Owner、
PID、容量与 `reported` 通知账本不会写回模型。

## 环境、输出与沙箱

Process Tool 从宿主环境保留操作系统运行所需变量，再按大小写不敏感规则清除 credential 与
`XHARNESS_*` 变量，并覆盖 PATH、Locale、Terminal/Pager 控制；模型命令不继承环境凭据。Relative
Cwd 固定在 Workspace；Absolute Cwd 仍受 Platform Sandbox Policy。`glob/grep` 直接调用 `rg`，
不经过 Shell 解释。macOS Release 将 ARM64 `rg` 与 Host 同目录打包；Linux `.deb` 通过依赖提供。

`read` 默认 32 KiB/400 行，Cursor 固定分页限制并绑定 SHA-256。Bash 最终 Capture、Process
Live Window 与 Job 未读流各自有界；Job 默认每条流 256 KiB，丢弃最老未读数据并设置
`*_truncated=true`。全局 Context Policy 仍会对写回历史的工具结果执行 256 KiB 硬上限和
8,192 字符请求侧 Pruner。完整持久 Spill Reference 仍待实现。

## 验证

三平台 CI 必须覆盖：11 个稳定名称、文件读写编辑、Unix `pipefail`、Windows PowerShell 严格错误/
UTF-8/原生命令退出码、前后台 Shell、非零退出、
实时增量输出、两次读取消费语义、Wait Timeout、Kill/Already-finished、Owner 隔离、10 个活跃
Job 上限、启动失败不占 ID、动态零值配置、历史保留、公开字段投影、五态迁移、Cancel Hook
异常、Producer Lease 丢失、Shutdown Cancel 异常/超时、进程树收敛和 UTF-8/Byte Cap。可选
Windows 还覆盖 PowerShell 调用 Git Bash。真实模型测试会记录 DeepSeek 面对“后台、nohup、PTY”提示时实际选择的工具和参数，不能仅凭
Tool Description 推断。

2026-09-01 已在 `WZU_Server` 对 DeepSeek V4 Flash 运行该行为测试：模型先调用
`bash({run_in_background:true})`，再调用 `job_output({wait:true})`，命令参数未出现 `nohup`、`&`、
PTY、screen 或 tmux；任务返回 `completed / exit code: 0 / deepseek-job-ok`。该测试保持 `ignored`
且需显式 Live 凭据运行，普通 CI 不访问外部模型。

## 当前限制

- Job 记录是 Host 进程内状态；正常 Host Shutdown 会取消并等待，异常崩溃后不会恢复进程或自动
  重放有副作用的命令。跨进程 Outcome/Orphan Reconciliation 尚未实现。
- 完成事件已有广播 seam，但尚未自动唤醒 Idle Agent。
- Job 未读输出只有内存 Tail，无完整 Spill 文件。
- 默认模型面不再提供交互 PTY；确需 TUI/密码提示/REPL 的专用 Profile 要在未来以独立、严格
  受控能力重新设计，不能把旧六工具无条件塞回每轮 Schema。
