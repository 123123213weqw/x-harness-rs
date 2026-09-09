# 桌面搜索与审批终态修复

日期：2026-09-09。范围：`DESKTOP-FIX-01`～`DESKTOP-FIX-03`。

## 1. 安装包内搜索依赖

`rg` 是随软件分发的内部可执行文件，不要求用户安装 Homebrew、PCRE2 或 ripgrep。
这不代表不存在操作系统依赖：macOS 仍依赖系统库，Linux 仍有既有的 GUI/沙箱依赖。

macOS CI 固定构建 ripgrep 15.2.0，使用 `--locked --no-default-features`，不启用可选
PCRE2。普通正则搜索继续可用；现有 glob/grep 接口本来也不传 `--pcre2`。
禁止直接打包构建机 Homebrew 的 rg。构建脚本仅允许在 CI 执行；本机不编译 Rust。

两层验收：
- Stage 前执行 `otool -L`，只允许 `/usr/lib/`、`/System/Library/` 的系统依赖；
  Homebrew、相对 rpath 和未知依赖拒绝打包。
- 最终签名 App 内的 rg 必须在精简 PATH 环境执行版本查询、列文件、匹配和无匹配搜索。
  不以构建机 PATH 中可运行的 rg 代替最终包测试。

不关闭 hardened runtime，不放宽 dylib 验证，不让用户手动安装库兜底。
Linux/Windows 保留原生实现与现有分发流程。

## 2. glob/grep 退出状态

| 进程结果 | 工具结果 |
| --- | --- |
| 正常退出 0 | 成功，`no_matches=false` |
| 正常退出 1 | 成功的空搜索，`no_matches=true` |
| 退出 2 或其他错误码 | 失败 |
| signal、未知退出状态、超时、取消 | 失败 |
| 创建进程失败 | 复用原有错误处理，失败 |

stdout/stderr、退出码、signal 和截断标记保留在诊断中。不能把进程崩溃包装成
`ok=true`，也不能将合法的“无匹配”视为异常。此表只适用 rg，不改变 Bash 的退出语义。

## 3. 审批必须收敛到终态

- 用户批准/拒绝：持久化既有决定，再派发给等待中的工具。
- 等待期限到达、工具结束、运行取消：追加 `approval/decided: cancelled`，发出
  `ToolApprovalResolved(cancelled=true)`，Host 删除 pending 并向 UI 发 `approval/resolved`。
- 决定派发前恰好超时：以执行器的工具终态为准，不重新执行，不导致整个 Agent 失败。
- 已结束 call 的迟到批准/拒绝被拒绝，不进入下一轮的审批缓存。
- 暂停只暂停模型推进；已失效的审批仍必须清除。
- App 启动恢复旧日志：若工具已有结果或其 turn 已结束，但审批没有决定，追加取消事件，
  flush 后重新投影。原日志不改写、不删除；再次启动不会重复追加。
- 正在进行、未有工具结果的审批保留恢复能力；绝不自动批准或重放已结束工具。

Session 校验仅放行闭合 turn 后追加的“取消”修复，仍拒绝闭合 turn 后凭空批准。
旧 `ToolApprovalResolved` 缺少 cancelled 字段时按 false 解码，保持兼容。

## 验证

1. 搜索退出矩阵、真实 rg 空匹配/坏正则/路径不存在。
2. 审批正常批准、拒绝（既有回归），超时、运行取消、暂停中超时及迟到回答。
3. 旧日志修复、正在等待的审批不修复、幂等恢复、不重放工具。
4. CI 打包契约、外部 dylib 拒绝、签名后真实 rg 冒烟。

交付状态另见总 TODO，源码测试通过不等于用户安装包已经更新。
