# 持久托管控制适配层

实现 `CLOUD-02a/b`，复用 `xharness-cloud` 的接纳/状态机，**不依赖 Host、Provider 或 Tool，也不运行第二套 Agent Loop**。自己的 Rust 源码禁止 unsafe；SQLite 通过现有安全库接口使用。

## 已实现

- `SqliteCloudTaskStore`：私有本地目录、单写者文件锁、SQLite WAL + FULL；接纳时环境/卷预留、Task、Receipt、阶段 outbox 与序号一次提交。
- 只写发生变化的行，不把全部 Task 集合或会话上下文反复写入快照；恢复时校验版本、行身份、序号、所有权、绑定与停止证明。
- 持久提交成功后才发布内存状态；无法确定提交结果时禁止继续读取/接纳，必须重开库、核对原收据。
- 原生阶段收据先落盘，再应用状态事实；崩溃在两步之间时重放同一收据，不重复派发。
- `CloudController`：每任务串行、有界环境并发、有界 I/O；Pending 派发前持久标记，Running/NeedsReconcile 只查询原身份。
- 取消保留在飞阶段，迟到的激活结果不能解封或启动第二次；结算需完整封存、停止与保留证明，超时/已知清理失败不伪报终态。
- `NativeStageExecutor` 消费原 Host 的 bootstrap reservation / PreparedReady / Ready / 精确激活 ack；复用控制器 outbox 和重启核对。`NativeHostLifecycle` 留给可信 VM 服务负责幂等部署、外部停止与保留，不在本层运行第二套 Goal 或假造 VM quiet。

`CloudCommitSink` 是唯一规则核的持久提交端口；`StageExecutor` 是经过验证的环境/Host 阶段执行与查询端口。SQL、SSH 与网络鉴权不进入领域核。

## 可信管理 CLI

远程编译得到 `xharness-cloud-control`；以下命令在受信任服务器执行：

```bash
xharness-cloud-control --state-dir "$HOME/private-cloud-control" register < environment.json
xharness-cloud-control --state-dir "$HOME/private-cloud-control" environments owner-wangyue
xharness-cloud-control --state-dir "$HOME/private-cloud-control" admit owner-wangyue < command.json
xharness-cloud-control --state-dir "$HOME/private-cloud-control" list owner-wangyue
xharness-cloud-control --state-dir "$HOME/private-cloud-control" get owner-wangyue task_1
xharness-cloud-control --state-dir "$HOME/private-cloud-control" receipt owner-wangyue request-1
```

`register` 与 `admit` 输入分别为严格 `RegisteredEnvironment` 与 `CommandEnvelope`；输入上限 256 KiB，错误不回显请求或凭据。不存在目录会私有创建；Unix 已有目录需 0700，拒绝符号链接、空/损坏/错误版本数据库，不自动重置为新环境。

CLI 的 owner 来自可信调用者，**不是认证机制**。文件锁只证明同一控制库单写者，不是跨服务器或 VM 的分布式 fencing。CLI 不提供执行/公网服务入口；原生 StageExecutor 适配已实现，生产 VM 生命周期/凭据与材料授权、任务范围 Gateway 或 UI 仍未接。

## 验收

仅在 `WZU_Server` 编译、测试；先 rsync 当前源码并排除密钥、环境文件与构建目录。

```bash
cargo test --locked -p xharness-cloud -p xharness-cloud-app --all-targets
cargo clippy --locked -p xharness-cloud -p xharness-cloud-app --all-targets -- -D warnings
cargo test --locked --workspace --all-targets
```

定向 84 项通过：领域 56、持久化 14、核对器 14。另一个 `ignored` 入口是父测试启动的异常退出子进程 fixture，不是漏测：子进程通过 `process::exit` 避开 Rust Drop，父进程重开库验证 WAL、接纳及 ID 重放。

核对器的外部阶段用有回执的受控 Fake 注入故障，**不等同于真实 Host 任务恢复**。专属 VM 身份已在真实 SQLite 中登记，但未验证的能力保持 `unknown`，接纳实测拒绝。见[规范](../../docs/specs/cloud-runtime.md)与[专属环境手册](../../docs/runbooks/cloud-dedicated-vm.md)。

## VM-local 原生许可（独立于控制库）

`native_permit` 模块提供短 SQLite 事务的绑定、单向许可、操作 ack 和 launch/stop 收据。
`xharness-native-permit` 是可信本地管理 CLI，不是模型工具或公网服务；不保存 Key、不启动模型。
原生组合根和中立 ExecutionGate 见[手册](../../docs/runbooks/cloud-native-execution-gate.md)。

该收据只证明原生 Runtime 的清理结果，不能直接作为整个 VM 静止或云任务终态。

原生 journal 21 项、Host 接线及进程 fixture 已在 V100 通过；完整工作区 1041 passed、19 ignored、0 failed，原生 VM 切片 8 项通过。完整证据及边界见[验收报告](../../docs/reports/cloud-native-execution-gate-20261001.md)，不能把没有调用模型的测试当成真实长期任务验收。

后续 schema 2 增量加入唯一 Goal 预留与 PreparedReady，不重置旧许可或操作。控制器/native 适配测试与原 Host 真模型 Goal 证据见[2026-10-02 验收报告](../../docs/reports/cloud-goal-bootstrap-20261002.md)，不能将测试生命周期端口当成生产 VM 部署实现。
