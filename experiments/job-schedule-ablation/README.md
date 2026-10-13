# Job / Schedule 统一入口消融实验

## 目标与边界

验证「立即后台执行 + 未来/周期执行」是否能共享一个 Job 入口，而不是直接合并两个状态机。
这是测试专用原型，未接入生产 Host、工具 Schema、前端或模型；不修改已安装的软件。
`lab.rs` 仅通过 `#[cfg(test)]` 编译，复用真实 `JobRegistry`、`ScheduleManager`、Durable Agent 和 JSONL Store。

## 实验组

- **A 独立入口**：直接调用现有 JobRegistry 与 ScheduleManager。
- **B 统一入口**：`Definition::{NowProcess, ScheduledAgent}` → `UnifiedJobs::create()`。
  保留 `Ticket::Run` / `Ticket::Plan` 身份边界；进程和规则仍使用原生命周期驱动。
- **C 负对照**：分别去掉调度/执行分离、规则持久化、每次执行独立 ID，观察语义破坏。
  负对照测试通过表示成功捕获预期缺陷，不表示 C 的设计正确。
- **共同缺口诊断**：检查原始进程 job_id 在 Registry 重建后是否复用。
  统一入口如果只沿用原始 ID，不会自动获得跨 Host 重启的持久化执行身份。

## 验收矩阵

1. Linux 真实 `/bin/sh` 输出、Unicode、stderr、非零退出码和增量游标。
2. 等待超时不等于失败，也不取消底层 Job。
3. 多个未来规则不能占用进程并发名额。
4. 取消未来规则与取消某次进程运行互不误伤。
5. 周期任务每次使用独立 run_id，保留先前结果。
6. 错过多个周期只合并补一次，不制造重放风暴。
7. 当前聊天忙时定时派发等空闲，独立进程仍可注册。
8. Agent 收到任务不代表成功；Provider 失败要形成 failed 回执。
9. 删除计划不应取消已被接纳的 Agent 执行。
10. 关闭并重新打开 JSONL Store，保留暂停态、时间相位、幂等键，再补发一次。
11. 统一入口保留 owner 隔离和计划/运行类型校验。
12. Job 完成事件无须模型轮询即可观测；不冒充已实现持久化 Agent 回执桥。

## 证据强度

除 Linux smoke 外，进程 producer 为显式控制的 fixture；模型为确定性 Fake Provider。
虚拟时钟直接驱动生产调度决策，避免真的等待 5 分钟。
微计时为 debug 内存诊断，不证明真实模型选工具准确率、原生速度或生产 SLA。
不证明新增「任意定时 Shell」「Host 重启后恢复原进程」「完整任务中心 UI」已经实现。

## 执行

遵循根目录 AGENTS.md：源码同步到 WZU_Server，所有 Cargo 编译/测试在远端执行。
使用 `scripts/run-job-schedule-ablation-remote.sh`，完整输出写入本地实验 evidence 目录。
编译缓存与实验源码隔离，避免覆盖其他任务的源码或线上部署。

## 已执行结果

见 [中文验收报告](../../docs/evidence/job-schedule-ablation-20261013.md)：
53 项独立测试全部通过，严格 Clippy 通过。结论是统一入口可行，但不能直接用当前进程 Registry 替代持久化调度。
跨 Registry 重建的原始运行 ID 复用已复现，正式任务中心需要单独解决。
