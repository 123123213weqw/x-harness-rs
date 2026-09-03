# Windows 原生支持

XHarness 在 Windows 11 / Windows Server 2025 上使用原生 Windows 后端，不需要 WSL。
发布包需要 PowerShell 7（`pwsh.exe`）；Windows PowerShell 5.1 不作为回退项，
避免同一工具在不同机器上出现不同语义。

## 平台映射

| 能力 | Unix | Windows |
| --- | --- | --- |
| 一次性命令 | `/bin/bash` + `pipefail` | PowerShell 7 + native-command error propagation |
| 持久终端 | PTY / process group | ConPTY / kill-on-close Job Object |
| 进程树清理 | session/process group | Job Object |
| 受限写入 | Bubblewrap / Seatbelt | restricted token + capability SID + NTFS DACL |
| 原子替换 | `renameat2` / `renameatx_np` | `ReplaceFileW` |
| 持久日志锁 | Unix advisory lock | Windows file lock |

Agent Loop、上下文、压缩、Provider、Session、RPC、Web UI、工具 Schema 和审批流程共用同一份
Rust 实现。平台差异集中在 `xharness-win32`、`xharness-process`、`xharness-fs`、
`xharness-sandbox`、`xharness-terminal` 和 shell 工具选择器；不需要维护一个 Windows 专用仓库。

## 启动 DeepSeek

官方 API 通过 OpenAI-compatible Chat Completions 接入，凭据只从
`DEEPSEEK_API_KEY` 环境变量读取。不要把 key 填入 JSON、命令行参数或 Git 文件。

```powershell
$env:DEEPSEEK_API_KEY = Read-Host 'DeepSeek API key' -MaskInput
pwsh -File .\scripts\start-windows.ps1 -Workspace C:\src\my-project
```

脚本使用 [`config/providers.deepseek.example.json`](../config/providers.deepseek.example.json)，
默认路由是 `deepseek-v4-flash` / high，Web 中可切换 `deepseek-v4-pro` 和模型实际支持的
`off` / `low` / `high` / `max` 思考强度。配置的 1M 上下文是部署声明 fallback；
Harness 不会把模型名推断伪装成实时 capability。

## SSH 和 Bash

PowerShell 工具可直接调用 Windows OpenSSH，例如 `ssh user@host` 或 `scp`。
如果已安装 Git for Windows，Agent 也可以从 PowerShell 显式调用
`& 'C:\Program Files\Git\bin\bash.exe' -lc '...'`。Windows 上的模型面 shell 工具仍命名为
`pwsh`，以确保路径、编码、pipeline 失败和 Job Object 清理语义可预测。

## 安全边界

Windows ACL 后端与 DeepSeek Harness 参考设计一样显式报告 `partial`：

- `workspace-write` 只向规范化工作区和每次运行的私有 temp 授予 capability SID。
- `read-only` 不携带 workspace/temp SID，历史工作区 ACE 不会被激活。
- 任何 ACL、token、spawn 或 Job 创建失败都 fail closed，不会降级成非受限进程。
- 该机制限制写入，不隔离读取、网络和进程可见性；向 Everyone 开放写入的外部对象仍是环境授权。
- NTFS hard link 指向同一文件对象，因此不能把 ACL 后端视为 VM/AppContainer 级边界。

## CI 与产物

GitHub Actions 的 `Rust / Windows x86_64` job 在 `windows-2025` 上执行全工作区
format/check/test/clippy，然后生成 `xharness-host-windows-x86_64.zip`。产物包含 Host、
ACL runner、ripgrep、Web UI、DeepSeek 配置与 PowerShell 7 启动脚本。
