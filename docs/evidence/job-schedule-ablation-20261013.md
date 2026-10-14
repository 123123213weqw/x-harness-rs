# Job / Schedule 统一入口消融结果

## 结论

**可以统一入口与任务展示；当前进程 JobRegistry 不能直接替代 Schedule。**

推荐一个 Job 服务协调两类驱动，并保留「计划定义 / 某次运行」的身份和生命周期边界。
这不要求两个驱动永远放在不同 crate；实验否决的是删掉边界的简化实现，
不是否决所有统一存储或统一模块设计。

## 实验环境与复现

- 日期：2026-10-13；服务器：WZU_Server / Linux。
- 基线：master `164301a497cea55b9efa7b12330dde314ca05a73`。
- 编译器：Cargo 1.98.1；全部 Rust 编译、测试、Clippy 在远端完成。
- 远端源码：`~/codex-build/x-harness-rs/job-schedule-ablation-20261013/`。
- 当前 Rust 工作区、测试原型和未提交修改通过 rsync 同步；排除 Git、target、node_modules、环境密钥，
  以及不参与本次 Rust 测试的 Web/桌面打包资源与报告。
- 复现脚本：`scripts/run-job-schedule-ablation-remote.sh`；复用 Cargo target 缓存，不修改线上软件。
- 最终完整输出：[remote-tests-20261013T031024Z.log](job-schedule-ablation-20261013/remote-tests-20261013T031024Z.log)。
- 源码校验：[source-manifest.json](job-schedule-ablation-20261013/source-manifest.json)。

## 对照组

| 组 | 实现 | 实际观察 |
|---|---|---|
| A | 独立调用现有 JobRegistry / ScheduleManager | 保持原语义 |
| B | 统一 `create(Definition)`，内部委托两套现有驱动 | 所测行为与 A 一致；owner 与 Plan/Run 类型检查保留 |
| C1 | 去掉触发/执行分离，把未来规则注册为运行中 Job | 并发名额为 1 时，未来任务挡住立即任务；B 的 12 个未来规则不会占名额 |
| C2 | 去掉持久化规则，只保存进程 Registry | 重建 Registry 后未来规则丢失；B 从真实 JSONL 文件重开后可恢复 |
| C3 | 去掉每次执行独立身份，计划 ID 只指向最新输出 | 第二次执行覆盖第一轮输出入口；B 保留两个 run_id 和原回执 |

负对照测试的 `ok` 表示成功捕获预期缺陷，不表示 C 的设计通过产品验收。

## 功能验收

17 项新增实验测试通过；另外 36 项原有生命周期测试通过，**共 53 项独立测试，0 失败**。
第一次单独实验与随后完整回归包含重复执行，不能相加报告为 70 项独立测试。
严格 Clippy（`--all-targets -- -D warnings`）通过。

覆盖：真实 Linux shell 的 Unicode/stderr/退出码/游标，等待超时不取消任务，未来规则与进程名额分离，
取消当前执行与取消未来触发互不误伤，周期运行 ID 与历史结果，错过周期合并补发，
聊天忙时等待空闲，Provider 失败不是成功回执，删除规则不取消已接纳 Agent 运行，
JSONL 重开后的暂停态/时间相位/幂等键/补发，owner 隔离，完成事件不依赖模型轮询。

## 性能诊断，不是生产 SLA

debug 内存测试每组 12 个样本，每个样本 200 次「注册 → 写输出 → 完成 → 读取」。交替测试 A/B 顺序。

| 轮次 | A 中位耗时/操作 | B 中位耗时/操作 | 差值 |
|---|---:|---:|---:|
| 初次 | 45.180 μs | 46.392 μs | +1.212 μs（约 2.68%） |
| 最终复跑 | 42.277 μs | 42.985 μs | +0.708 μs（约 1.67%） |

这里只支持「薄入口开销在微秒量级」的观察；未做统计显著性检验，
不证明真实模型速度、原生启动时间或单工具 Schema 选择准确率有提升。
两次周期执行的 Fake Provider 调用数 A/B 均为 2，统一入口没有额外创建模型 Loop。

## 额外复现的共同缺口

**原始运行 ID 在 Registry 重建后复用。** 在同一 Session Store 和相同 owner 下，
旧、新 Registry 的第一次运行都返回 `bash-1`；旧 ID 与旧起始游标能读到新任务输出。
A、B 都复现，这不是统一入口新增的缺陷，也不是摘要策略能解决的问题。

正式任务中心应使用持久化的执行身份，或包含 Host generation 的不透明运行引用。
旧 generation 的引用必须明确过期，不能根据相同字符串悄悄关联新任务。
现有进程 job_id 可以保留为内部 runtime ID，不应直接承担长期 JobRun 的公开身份。

## 尚未证明 / 尚未接入

- 模型为确定性 Fake Provider，未做真实 Qwen/DeepSeek 选工具的准确率消融。
- 除固定 shell smoke 外，producer 是显式 fixture；未重新验收进程树清理或沙箱审批。
- JSONL 重开验证的是规则与回执恢复，不是任意进程能在 Host 重启后继续运行。
- Registry 已有完成事件，但持久化 Agent Inbox 桥接、去重与失败门控仍需正式实现和测试。
- 原型只在 `cfg(test)` 下使用，未替换生产工具、未改前端、未重启或部署当前软件。

## 下一步建议

1. 先补执行身份的 generation / 持久化边界回归。
2. 增加薄 Job 服务，统一创建、列表、状态展示，内部继续复用两个驱动。
3. 明确 `cancel_run` 与 `cancel_future`，不能用模糊的取消语义误伤执行。
4. Job 完成回执走已有持久化 Inbox；遵守终止失败 gate，避免重演反复唤醒。
5. 完成模型可见 Schema 后，再做真实模型的 A/B：选路成功率、重复调用数、上下文成本。
