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
- 本机仅执行不编译 Rust 的检查：桌面发布 6 项、release build 30 项、统一发布 36 项、
  Unix 更新验收契约 20 项，及 context 插件脚本和桌面静态资源检查，全部通过。
- 新打包 Stage 守卫已拒绝当前损坏 App 的 rg（外部 dylib），不会再次将它打进新包。

## 尚待交付验收

跨平台 CI、最终签名包内 rg 实测，以及替换本机后的旧会话审批清理。不能把源码测试
结果当作已经更新用户软件。独立 3082 Web 服务和模型服务不属于本次重启范围。
