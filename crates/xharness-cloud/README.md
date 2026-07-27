# 专用 VM 托管领域基础

`CLOUD-01/02` 的可复用领域核，**不是第二套 Agent Loop，也不是已上线的云服务**。

- `contract`：严格 Submit/Cancel DTO、版本/限额/引用校验、稳定指纹。
- `state`：Task 纯归约、终态证明门禁、prepared/active/sealed 单向许可。
- `store`：接纳、CAS、收据和 outbox 的唯一规则实现。默认 Memory 非持久；`CloudCommitSink` 在内存发布前提交增量变更，`CloudSnapshot` 校验后恢复，不复制第二套数据库状态机。
- `environment`：能力三态与异步环境 I/O 端口。
- `testing`：Fake 环境及丢回执/未知结果/已知失败注入，不执行进程或 SSH。

没有内部 crate 依赖，禁止 unsafe；生产 Host 目前不依赖此模块。持久 SQLite Store 和重启核对器位于 [`xharness-cloud-app`](../xharness-cloud-app/README.md)，领域核不依赖 SQL、SSH 或 Host。原 Host 可选许可门禁已接入组合根；认证、凭据/材料解析、生产 VM 生命周期适配、Gateway 和 TS UI 路由尚未接入。

另有[四 VM 实验](../../docs/runbooks/cloud-vm-lab.md)：在 V100 上部署四个真实 KVM 客体与原 Host，测试连接切换/隔离/重启/崩溃恢复。这是 opt-in 验收脚本，不是生产环境适配器或新的模型 Loop；不注入模型密钥，不实现运行中任务迁移。

其中一台现已升级为[保留型专属测试 VM](../../docs/runbooks/cloud-dedicated-vm.md)，固定身份/磁盘、人工启停、无实验时长自动关机。登记到持久控制库时，未验证的任务能力仍为 `unknown`，实际任务接纳被拒绝，不能以基础设施验收代替长期 Agent 恢复验收。

完整约束、黄金样本与已验收/未验收边界见[托管规范](../../docs/specs/cloud-runtime.md)。
Rust 编译仅在远程进行；先从本机同步源码，复用[回归入口](../../scripts/regression/remote-regression.sh)在 `WZU_Server` 执行 `full`。
