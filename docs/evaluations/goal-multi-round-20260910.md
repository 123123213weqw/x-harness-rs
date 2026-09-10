# Goal 多轮真实编程验收（2026-09-10）

## 结论与边界

V100（`WZU_Server`）隔离目录中，使用本机 XHarness **当前可编辑配置**的 `deepseek-flash` 和系统钥匙串凭据，完成三轮实际编码。不是三次独立脚本请求：一条持久 Session、现有 `DurableAgentHandle`、原 Loop、原 CodingToolBundle，由 Goal Controller 在轮与轮之间原子入队。

本次明确将交付分成“核心 / CLI / 最终审查”三个阶段，检验跨轮执行与恢复契约；**不据此声称模型能在任意开放任务中自行可靠规划轮次**。报告通过测试 Factory 的最终 JSON 适配器读取，没有注册新模型工具。生产报告入口及 UI 开关仍待接入。

## 工作与验收

目标：纯标准库 Python CSV 账本汇总程序，真实文件写入、修改、执行测试。

- 第 1 轮：`ledger.py` 核心解析、Decimal 汇总、基础测试；报告 progress。
- 第 2 轮：命令行入口、JSON 输出、集成测试；报告 progress。
- 第 3 轮：日期、金额、Unicode/CSV、异常输入等边界审查与 README；报告 complete。
- 模型完成声明先进入 **待确认**，不直接标记 Goal 完成。
- 外部 `scripts/goal-ledger-acceptance.py` 验收通过后，通过绑定报告 ID 的 review 写入确认，Goal 才变为 complete。

结果：

| 项目 | 结果 |
| --- | --- |
| 实际 Goal 轮数 | 3，自动续轮 2 次 |
| 编码至待确认耗时 | 237.868 秒（约 3 分 58 秒） |
| 原生工具调用 | 35：bash 19、write 4、edit 11、read 1 |
| Tool API 返回失败 | 0；此指标不等于覆盖了所有潜在业务错误 |
| 模型自写测试 | 106 通过 |
| 独立验收 | 12 通过，含多个无效输入子用例 |
| 最终产物 | ledger.py / test_ledger.py / README.md |
| JSONL 重新打开 | Goal 状态、报告、轮次、收据一致 |
| 最终 Goal 状态 | complete（独立验收后确认） |

Rust 验证：纯决策 18 项、持久 Runtime 16 项；全仓 541 通过、0 失败、5 忽略；Clippy `-D warnings` 通过，全部在 V100 执行。

完整时间/usage/产物 SHA256 见同目录 JSON，以 JSONL 的 durable_turn_ends/durable_usage 作为完整轮次事实（最初实验订阅器在第 3 轮广播尚未消费完时已读到持久状态，现已补等待 TurnFinished；没有丢失持久历史）。以上只是一次端到端实验，不是稳定性概率或性能对比基准；usage 沿用 Provider 字段，没有把缓存输入计数当作生成速度。

## 实验中发现并处理的问题

1. 最初误读旧兼容密钥文件，服务端返回 HTTP 401。该次 Goal 正确暂停在 ExecutionError，没有无限重试。随后按当前应用可编辑配置及原生凭据存储读取实际配置，实验通过。没有修改用户配置，也没有将密钥落盘到远程或输出日志。
2. 严格 claim revision 校验最初影响普通 schedule 启动，回归暴露后改为只约束 Goal 原子 claim；原有后台定时任务测试恢复通过。
3. `goal/execution` 全状态较大，改用 Box 保存事件载荷，避免放大所有 Session Event 的枚举尺寸。
4. 外部删除待执行 Goal 队列项时，改为暂停并说明取消，避免永久等待一个已不存在的意图。

## 复现与产物位置

- Rust 入口：`crates/xharness-host-app/examples/goal_work_eval.rs`；配置从 stdin 读取，API Key 不进入 Session。
- 在远程构建：`cargo build --locked -p xharness-host-app --example goal_work_eval`。
- 给二进制传一个**尚不存在**的独立工作目录；它拒绝覆盖现有目录。
- 验收：`goal_work_eval --confirm <实验目录>`。会先执行仓库的独立 Python 验收，失败不确认。
- 远程实验目录：`/home/data/wangyue/codex-goal-eval-20260910-ledger-current`。
- 本机产物副本：`/tmp/xh-goal-eval-20260910/work`。
- 本机原始日志：`/tmp/xh-goal-deepseek-current.log`、`/tmp/xh-goal-independent-acceptance.log`。

没有修改/重启现有软件、模型服务器或用户工作任务。软件 UI 发布、跨平台 CI、必要后台依赖投影与更大故障矩阵仍在 TODO。
