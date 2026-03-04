# 执行检查点验收记录（2026-09-10）

## 环境

- 基线：`origin/master@ee02f5d`；独立工作分支 `codex/execution-checkpoints-20260910`，未修改原 checkout 的未提交文件。
- Rust：源码 rsync 至 `WZU_Server:~/codex-build/x-harness-rs/`，仅在 V100 Linux 服务器编译、测试。
- UI：本机隔离 Playwright，实际 shipped Conversation 插件 + runtime + React，不连接用户会话。
- 没有替换已安装软件、重启服务或写用户工作区；真实模型使用远程临时目录。

## 结果

| 项目 | 结果 |
| --- | --- |
| `cargo test --locked --workspace --all-targets` | 507 passed，0 failed，5 个外部条件测试默认 ignored |
| 最后边界修订后的 Core 全量回归 | 84 passed；含审批重启有/无检查点两种路径 |
| `cargo clippy --locked --workspace --all-targets -- -D warnings` | 通过 |
| 新增 Node 检查点测试 | 实时/历史投影、硬停止、隐藏快照、注册、补丁幂等通过 |
| Chromium / WebKit | 真实 runtime append/reload/prepend 一致，检查点展开、硬停止默认展开、375px 无横向溢出 |
| 现有 Node 回归 | 上下文计量、附件、历史消息编辑、模型控制通过 |
| DeepSeek Flash 真实编程 smoke | Completed；2 次阶段续行，`read → edit → bash → bash`；独立 Python 断言通过，模型测试耗时约 5.6 秒（不含编译） |

真实编程测试故意将阶段跨度缩为 2 步；验证在控制提醒下继续调用现有工具并完成任务，不代表实测了 1024 步连续长任务。模拟 Provider 用 131 步测试覆盖原默认 128 步截停回归。重复行为由确定性测试覆盖，不将一次真实模型成功泛化为“不会循环”。

完整本地运行日志：`/tmp/xhcp-final-rust.log`、`/tmp/xhcp-final-core.log`、`/tmp/xhcp-deepseek-live.log`。UI 截图在工作树 `dist/execution-checkpoint-ui/`，不提交构建/临时产物。

## 后续发布门禁

- 新 Node/浏览器测试已加入跨平台 CI；真实模型 smoke 加入手动 `deepseek-live` 工作流。
- GitHub CI 本轮未触发；Windows/macOS Rust 编译和已安装实例验收仍需评审/发布阶段执行。
- 新 durable event 不保证旧二进制降级可读；升级前备份，禁止直接旧版覆盖后读取新日志。
