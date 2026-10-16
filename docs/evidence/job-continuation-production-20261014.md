# 后台 Job 自动续跑验收

2026-10-14，分支 `feat/job-continuation-20261014`，基于 master `b03b020e`。正式 Native Host 的自动续跑已接入，沿用现有 Session、Inbox、Durable Agent 和 Loop；没有移植实验中的 test-only DeferAdapter，也没有另建 Scheduler 或推倒重写主链路。

## 实现结果

模型调用 `bash(run_in_background=true)` 得到 Job ID，再调用 `job_output(action=defer, continuation=...)`。注册落盘后立即返回，当前轮可结束。生产者结束时 Controller 保存终态快照，将一次完成回执送入原会话 Inbox，再由原 Loop 执行依赖步骤。

- 注册、终态、投递确认均为版本化 Session 控制面事实，不进入模型正文。
- 同一订阅重复注册幂等；投递确认丢失后，从历史 Inbox 插入事实去重，即使输入已消费也不再执行一次。
- 活跃会话只排队，不开第二个同会话执行器。用户停止、失败及非缩减压缩失败后，完成回执不能自行恢复失败循环；明确的用户输入仍可恢复。
- 取消订阅不等于停止 Job；已投递的输入不假装可撤回。缺失原 Registry 的恢复状态为 interrupted，不自动重放生产者。普通对话 fork 不继承父会话生产者订阅。
- 活日志 Cursor 保持原语义；归档快照明确没有 Cursor，不伪造增量日志。
- outbox I/O 卡住也有界退出并继续收敛生产者，保存失败明确报错。

## 远程回归

全部 Rust 编译、测试和检查在 WZU_Server 执行，先 rsync 当前源码，复用 `target-unified-jobs-20261013` 缓存。Cargo.lock 已回传并检查，仅增加本次依赖边；最后一轮使用 `--locked`。

最终记录：[完整输出](job-continuation-production-20261014/remote-suite-6.log)。

| 验收 | 结果 |
| --- | --- |
| 新增正式 Native 集成回归 | 13 通过，1 个官方模型入口默认 ignored |
| Agent/Core/Host/Coding/Jobs/Session/Projection 与 Host App lib 扩展测试 | 合计 782 通过、15 ignored，0 失败 |
| workspace 全 targets 检查 | 通过 |
| 相关模块全 targets 严格 Clippy | 通过，`-D warnings` |
| 本机格式与差异检查 | cargo fmt check、git diff check 通过；本机未编译 Rust |

782 已包含新增 13 个场景，不重复相加。ignored 包含凭据、平台或显式集成环境入口，不等于已跨平台实机验收。

新增场景包括：注册后释放当前轮并回复新消息、完成后自动验证产物、同键十路注册竞争、取消与 owner 隔离、已完成失败 Job 注册、活跃轮中排队、用户停止后保留回执、真实 Core 非缩减压缩失败不重触发、失败前已入队的回执不绕过 Actor 门闸、确认丢失且输入已消费后的恢复去重、缺失 Registry 的 interrupted 与归档 Cursor、冷 Host 恢复、fork 不继承订阅，以及 I/O 卡住时仍关闭生产者注册表。

完整测试曾发现门闸过宽，阻断了 Goal 授权的网络退避重试和用户恢复后 FIFO 中的普通 Agent 消息。最终将新增拦截收窄到 `job-settlement/agent-settlement`，并检查整个待处理队列中的用户恢复信号。原有 Goal 冷恢复、退避重试与停止恢复测试已全部通过。早期编译/夹具失败记录保留在同目录，不用最后一次绿灯覆盖它们。

## PR 架构检查补充

PR #294 首次 CI 在编译前发现 Host 到 Jobs 的新依赖尚未登记。只补充了 `xharness-host → xharness-jobs` 这一条基线边，并在规范记录分层理由；检查器未修改、未关闭。架构依赖检查及 5 个边界变异测试通过。Rust 源码和已验收的模型行为没有变化。

## 官方 DeepSeek

端点固定为 `https://api.deepseek.com`，模型 `deepseek-flash`，thinking disabled，每请求输出上限 1024，测试总模型请求上限 16。真实 Provider、NativeToolFactory、进程、JSONL、Host Admission 与 Durable Inbox；不存在脚本模拟模型 Loop。

[现场输出](job-continuation-production-20261014/remote-live-deepseek.log)、[原始结果](job-continuation-production-20261014/live-deepseek.json)、[模型行为审计](job-continuation-production-20261014/live-deepseek-analysis.json)。

### 成功流程

模型自己选择后台启动和 defer，未用 wait 阻塞。第一次轮结束时构建仍在运行；新用户消息得到 `LIVE_PONG`，构建仍未完成。测试控制器释放生产者后，系统恰好投递 1 次回执，模型读 Job 输出并运行 consume.py，实际文件为 `VERIFIED_OK`。

本次释放当前轮约 7.4 秒，完整样例约 12.1 秒，9 次真实模型请求。它们是固定夹具的一次观察，不是吞吐或相对提速基准；其中包含 3 次被夹具拒绝的额外探查/目录覆盖尝试。

### 失败流程与模型限制

预置生产者真实退出码为 7，stderr 为 `BUILD_FAILED`。这个用例由测试宿主注册订阅，终态回执自动唤醒真实模型。模型实际读取 failed 状态，没有运行 consume.py，也没有把失败报告成成功；4 次真实模型请求。

**模型仍尝试过一次再次运行 fail.py**，该调用因 cwd 覆盖违反夹具约束而被拒绝。另有一次源码探查被拒绝。模型最后自述“未自动重试脚本”不能当作其没有发出重试请求的证据。

因此，绿色结果只证明正式续跑链路、物理产物和失败状态读取。框架没有自动重放脚本，但不能据此承诺模型一定服从“不要重试”。本夹具刻意仅开放 Bash/Job 工具、限制为原样预置脚本，模型探查受限；该行为值得在后续具备正常 read 工具的真实 Coding 场景继续测，不能外推为生产中重试必被拦截。

## 交付边界

代码和中文规范已更新，本分支用于 PR 代码审阅；未替换当前安装的软件、未重启用户 Host。本机及服务器已有服务、用户任务、模型部署均未变更。

复现脚本：`scripts/run-deepseek-job-continuation-live.py`。凭据仅通过加密 SSH stdin 进入测试进程环境；没有远程凭据文件、命令行 Key 或包含 Key 的验收文件。

[规范](../specs/job-continuation.md)、[源码哈希](job-continuation-production-20261014/source-sha256.json)、[测试二进制哈希](job-continuation-production-20261014/remote-test-binary.sha256)。
