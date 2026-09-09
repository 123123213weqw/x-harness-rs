# 桌面搜索与审批修复回归

日期：2026-09-09。

## 故障证据

本机 0.2.8 的 `Contents/MacOS/rg` 依赖 Homebrew PCRE2 dylib；签名环境中执行
`--version` 就发生 dyld 错误，退出 134。与此同时 glob 把 signal 6 的进程结果包装成
工具 success。受影响会话的 Bash 审批等待 300000 ms 后超时，只有工具错误，没有审批决定。

## 已通过

- 先 rsync 当前源码到 `WZU_Server:~/codex-build/x-harness-rs/`，排除 Git、target、
  node_modules、环境和密钥文件，再执行 `cargo test --locked --workspace --all-targets`。
  全部通过，4 个既有测试保持 ignored。完整输出保存本机 `/tmp/xh-three-fixes-test7.log`。
- 远程 `cargo clippy --locked --workspace --all-targets -- -D warnings` 通过。
- 搜索退出矩阵与真实 rg 的正常/空匹配/坏正则/不存在路径通过。
- 审批超时、取消、暂停时超时、迟到批准/拒绝、旧日志修复和幂等恢复通过。
- 本机仅执行不编译 Rust 的检查：桌面发布 7 项、release build 30 项、统一发布 36 项、
  Unix 更新验收契约 20 项，及 context 插件脚本和桌面静态资源检查，全部通过。
- 新打包 Stage 守卫已拒绝当前损坏 App 的 rg（外部 dylib），不会再次将它打进新包。

## 已交付验收

- 首轮 CI 暴露 Runner 在测试之后才准备 rg。已把 Linux/Mac/Windows 和个人发布流水线的
  rg 准备提前，并补充执行顺序契约；没有跳过真实搜索测试。
- [PR #43](https://github.com/123123213weqw/x-harness-rs/pull/43) 已合并，提交 `2cb3e26`。
- [跨平台 CI 34326877021](https://github.com/123123213weqw/x-harness-rs/actions/runs/34326877021)
  全部通过，包括 Chromium/WebKit 与三种 Unix 原生签名更新演练。
- [macOS 发布 CI 34328082801](https://github.com/123123213weqw/x-harness-rs/actions/runs/34328082801)
  通过；[0.2.9 个人测试包](https://github.com/123123213weqw/x-harness-rs/releases/tag/desktop-test-v0.2.9)
  使用原有可信更新公钥验签，SHA256 和 App codesign 验证通过。仍是未公证个人包，不绕过正式发布门禁。
- 本机 `/Applications/XHarness.app` 已替换并重启为 0.2.9。最终包 rg 15.2.0 显示
  `features:-pcre2`；精简 PATH 下版本查询、glob、匹配/无匹配全部通过。
- 199 个打包 Web 文件与本批源码一致。28 个旧会话全部保留；启动后另有一个新空会话，
  当前合计 29 个。Provider 配置 hash 不变。
- 受影响会话原始 JSONL 字节前缀不变，只追加第 144 号取消事件；`session.history`
  返回该审批 `outcome=cancelled`，无历史命令重放。原文件 144 个事件，修复后 145 个。
- 本机验收摘要 `/tmp/xh-three-fixes-installed-proof.json`；回滚备份位于
  `~/Library/Application Support/XHarness-app-backups/20260909-162350-three-fixes-029/`。
- 原生 UI 自动化连接超时，因此没有宣称截图/实际点击验收；已验证桌面服务的 UI history
  终态以及打包资源，审批的共享 UI 协议没有更改。

独立 3082 Web 服务和模型服务未重启；本次没有放宽沙箱权限、没有删除历史或自动批准。
