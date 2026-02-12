# 网络恢复增强回归记录 · 2026-09-07

## 编译环境

- 未在本机编译 Rust；源码含未提交修改通过 rsync 同步到 WZU_Server 的 `~/codex-build/x-harness-rs/`。
- 排除 .git、target、node_modules、根 dist、.env 和 .env.*，复用远程 Cargo 缓存。

## 已执行

1. `cargo test --locked --workspace --all-targets`：65 组，439 passed / 0 failed / 4 ignored。
2. `cargo clippy --locked --workspace --all-targets -- -D warnings`：通过。
3. `cargo build --locked --release -p xharness-host-app --bin xharness-host`：通过。
4. 网络 HTTP 集成测试 12 项 + 真实 TLS 测试 1 项连续执行 5 轮，全通过。
   TLS 每轮覆盖输出前断开、部分输出断开、协议完成后断开三种状态。
5. `node scripts/test-model-controls.mjs`、`node scripts/test-desktop-bootstrap.mjs`：通过。
6. 本机仅执行 `cargo fmt --all --check` 和 `git diff --check`，通过。

第一次新增持久化测试错误地期待权威 Journal 与旧 MemorySnapshot 双写，测试失败。
确认 Core 只使用权威 Journal 后，改为验证真实 Journal 恢复的新 Turn，而非修改生产代码做双写。
之后完整回归通过。Clippy 另指出测试中 Default 后字段赋值，已改初始化写法。

## 本机日志

- `/tmp/xharness-network-workspace.log`：完整工作区回归、Clippy、Release 输出。
- `/tmp/xharness-network-repeats.log`：5 轮 HTTP/TLS 重复测试输出。

这些是开发机路径，不作为其他使用者的运行依赖；测试夹具已入库，可在 CI 重跑。

## 尚未冒充完成的验收

- 物理 Wi-Fi/运营商/代理路径切换没有执行，未中断用户机器网络。
- 4080 桌面检查时仍有运行中的 Agent，未强制结束；整包发布/安装与运行测试是独立步骤。
- 4 个被忽略测试仍保持原状态，不计算为通过。
- 没有使用真实 DeepSeek 密钥或真实模型反复制造计费请求；本轮验证的是实际 HTTP/TLS 传输故障与 Loop 策略。
