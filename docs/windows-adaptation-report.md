# Windows 适配评估报告

## 结论

XHarness 适合在同一仓库内增加 Windows 原生后端，不需要复制一套 Windows 源码树。
Agent Loop、Provider、上下文管理、压缩、Session、RPC、Web UI、工具协议和审批语义均可直接复用；
平台差异集中在进程、文件系统、沙箱、终端和 shell 五个边界，并由独立的
`xharness-win32` crate 承载 Win32 原语。

当前实现以 Windows 11 / Windows Server 2025、PowerShell 7 和 NTFS 为支持基线。
Windows PowerShell 5.1 不回退，WSL 不是运行时依赖。PowerShell 7 中可直接调用系统
OpenSSH，也可显式启动 Git for Windows 的 Bash，但模型面对的原生命令工具是 `pwsh`。

## 与 DeepSeek Harness 参考实现的关系

设计沿用 DeepSeek Harness 的 provider/consumer 分层：高层能力只消费平台接口，Win32
实现位于底层 provider。进程以 suspended 状态创建、加入 kill-on-close Job Object 后才恢复，
消除首条指令前派生后代的竞态；交互终端使用 ConPTY；
原子文件替换使用 `ReplaceFileW`；受限写入使用 restricted token、capability SID 与
NTFS DACL。与参考实现一样，ACL 沙箱明确报告 `partial`，不冒充 VM、AppContainer 或
完整读取/网络隔离。

实现没有照搬 Unix shell 语句。PowerShell 调用启用 UTF-8、严格错误处理与原生命令退出码
传播，并由 Job Object 统一处理超时、取消和后台子进程回收。

## 代码复用测量

测量基线为适配开始前的 `85c56511c1419c8bb14e7b471c86e80ffc1fa632`，统计对象为当前
分支的 Rust 文件和 workspace crates：

| 指标 | 结果 |
| --- | --- |
| Rust 文件 | 106 |
| 未修改 Rust 文件 | 71（67.0%） |
| Workspace crates | 27 |
| 整 crate 未修改 | 16（59.3%） |
| 修改或新增的生产 crate | 11 |

整 crate 复用的 16 个模块包括 `xharness-agent`、`xharness-api`、`xharness-compaction`、
`xharness-context`、`xharness-core`、`xharness-debug`、`xharness-interaction`、
`xharness-jobs`、`xharness-prompt`、`xharness-provider-openai`、`xharness-schedule`、
`xharness-server`、`xharness-session`、`xharness-token`、`xharness-tools` 和 `xharness-web`。

“67.0% 文件未修改”是可复现的保守指标，不等于按行数计算的业务逻辑复用率。实际高层
逻辑复用更高，因为 11 个受影响 crate 中的大部分修改也是 `cfg(unix/windows)` 的底层分支，
而不是另写 Agent 或 Provider。

## 能力与限制

| 能力 | Windows 实现 | 验收重点 |
| --- | --- | --- |
| 一次性命令 | PowerShell 7 | stdout/stderr、非零退出、超时、取消、后台任务 |
| 持久终端 | ConPTY | 连续输入输出、scrollback、关闭后进程树回收 |
| 进程树 | Job Object | 父子进程统一取消，句柄关闭时强制清理 |
| 文件系统 | Win32/NTFS | 大小写路径、reparse escape、CAS、ACL 保留、原子替换 |
| 写入沙箱 | restricted token + DACL | 工作区/temp 可写，外部路径拒绝，失败时 fail closed |
| 持久日志 | Windows file locking | 控制日志与 JSONL session 的并发、恢复与指纹 |
| DeepSeek | OpenAI-compatible Chat Completions | V4 Flash/Pro、thinking/reasoning patch、工具调用与调试证据 |

ACL 后端只限制写权限；它不隔离读取、网络或进程可见性。目标对象如果已经向 Everyone
开放写入，仍可能被环境授权访问。NTFS hard link 也共享同一个文件对象。因此需要更强边界
时应在 Windows Sandbox、Hyper-V/VM 或专用低权限账户中运行整个 Host。

## CI 与长任务验收

普通 CI 在 Linux x86_64、macOS arm64 和 Windows x86_64 上执行完整 workspace 的
format/check/test/clippy。Windows 还进行 release build，并打包 Host、ACL runner、
ripgrep、Web UI、DeepSeek 配置和 PowerShell 启动脚本。

需要真实模型和费用的测试放在手动 `DeepSeek live acceptance` workflow 中，凭据只从
GitHub Actions secret `DEEPSEEK_API_KEY` 注入。它包含两项验收：

1. 要求模型使用 Harness managed background job，并验证没有退回 nohup、tmux、screen
   或伪 PTY。
2. 在 Windows 上修复一个跨两个实现文件的依赖调度包，读取需求与公开测试、实际编辑、
   使用 `pwsh` 迭代运行测试，再由 harness 注入隐藏用例检查时长解析、稳定依赖排序、
   并行开始时间、环/未知依赖/重复 ID。最后检查 durable journal、工具参数流、Full Debug
   的 core/provider/tools/process 证据，以及 API key 未进入 trace。

这个验收用于判断真实 coding loop 是否能工作，并不把一次样例通过夸大为模型总体质量
基准。质量结论应同时记录模型路由、运行时间、工具调用序列、公开测试、隐藏测试与 trace
结果；没有执行真实 workflow 时不能声称 DeepSeek 已通过在线验收。
