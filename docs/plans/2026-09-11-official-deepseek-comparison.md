# XHarness vs Official DeepSeek Harness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> 本环境执行时对应可用的 `executing-plans` 技能；不存在的技能不假装已加载。本文件是待执行计划，不是测试结果。

**Goal:** 在相同任务、模型和资源预算下，比较 XHarness 与官方 DeepSeek Harness 的独立任务通过情况、可靠性和 token 成本，找到可验证的优化方向。

**Architecture:** 复用 PR #55 的 Harbor 任务隔离、独立 verifier、凭据代理与计量。新增官方完整 headless 的薄适配器，只负责配置、启动、结束和收集证据，不重写官方推理循环。先通过零付费环境验收，再跑 3 题 × 2 个 harness 的配对小试验；不在本轮修改生产 App。

**Tech Stack:** Harbor 0.16.1、固定修订的 Terminal-Bench 2.1、WZU Linux Docker、远端构建的 Rust Host、固定版本官方 dsh/Node、同一 DeepSeek API。

---

## 1. 我们究竟比较什么

主问题：同一个模型交给两套原生 harness，能否完成同一任务；完成质量相近时，谁使用更少 token/时间，谁更可靠。

推荐方案：**资源归一化的原生 harness 比较**。保留各自系统提示词、工具定义、上下文压缩/回读、重试和子 agent 机制；固定双方外部预算。工具数量和调用次数是观察指标，不硬凑相同。

暂不采用：

- 各自完全默认配置：更接近开箱体验，但模型、上下文和消耗上限可能不同，不适合作为第一轮归因依据。
- 强制两边相同提示词/工具：更适合后续单变量定位，会削弱第一轮对产品整体能力的代表性。

官方入口区别：`BENCHMARK.md` 指向 Python SDK 的 `jsonrpc-agent` minimal 变体；完整 headless 使用共享 base 组装。第一轮选择 **官方完整 headless**，不是 minimal，不声称复现官方排行榜配置。若后续需要 minimal，单独命名、单独计分。

## 2. 第一轮拟冻结协议

| 项目 | 规则 |
|---|---|
| 组别 | A：XHarness 实际 Host；B：官方 dsh 完整 headless；Terminus-2 不参与本轮 |
| 版本 | 开跑前锁定双方完整 Git SHA、构建产物 SHA、配置/工具清单与镜像摘要；全批次不追踪浮动 master |
| XHarness 目标 | 包含待验收历史持久化/回读修改的明确提交；若采用 PR #54 提交，报告不能冒称上游已合并版本 |
| 模型 | 同一账号/端点的 `deepseek-flash`，记录响应 model、执行日期；别名可能变化，不承诺跨日期模型完全相同 |
| 模型参数 | thinking enabled、high；所有能够影响采样的显式参数先核对双方支持情况，统一并写入 manifest；不伪造不支持的 seed |
| 上下文 | 双方目标上限 65,536 token；由各自原生上下文策略处理，不在代理层删消息、切工具配对或截原始参数 |
| 单次输出 | 拟 16,384 token，包含 reasoning；取代旧试验的 4,096。先验证双方及 API 支持，若不支持则在任何评分前统一修订协议 |
| 时间 | 每题有效 agent 运行 600 秒，双方都从环境/运行时就绪、首次提交任务时开始；到点统一停止，清理时间单独计量，不再 XHarness 少 10 秒 |
| 请求与费用 | 每题最多 40 次模型请求、$0.50 保守预留上限，任一达到即停止；主 agent、子 agent、摘要和重试共享预算 |
| 总规模 | 3 题 × 2 组 × 1 次 = 6 trials；拟总预留上限 $3，不含旧批次已花费；本次制定计划不触发支出 |
| 机器条件 | 同一服务器、同题相同镜像/依赖层、相同 CPU/内存/权限/网络策略；不更改共享宿主防火墙，不挂 Docker socket 或用户目录 |
| 题目 | 沿用固定 TB 2.1 修订 `7131e4375048a0e408a8fb404b5f499d726b695b` 的三题，避免见分换题 |
| 调度 | async 题 A→B，Cython 题 B→A，日志题 A→B；顺序执行避免争抢。后续重复轮翻转顺序 |
| 隔离 | 每次全新工作目录、会话、凭据 capability；不复用前一组的补丁、agent 历史或答案 |

每题 600 秒是缩短版 pilot，不是官方 900 秒协议。最多约 60 分钟有效 agent 时间，镜像准备、启动、独立评分另计，不承诺总耗时 60 分钟内。

已有代理把模型输出上限写死为 4096、预算写死为 $0.30；**执行前必须将这些限制统一配置化并测试，不能只改说明文件**。输入预留估算与输出上限同步变更，未知 usage 不返还预留。关闭试验时处理在途请求，不能漏算最后一次调用或让其计入下一题。

## 3. 题目与评分

| 题目 | 能力侧重 | 正确性的唯一主依据 |
|---|---|---|
| cancel-async-tasks | 异步并发、取消、错误传播 | 固定官方独立 verifier |
| build-cython-ext | 依赖与构建兼容修复 | 固定官方独立 verifier |
| log-summary-date-ranges | 日志解析、日期边界、输出格式 | 固定官方独立 verifier |

不把模型说“完成”、自行编写的测试 PASS 或退出码 0 当成任务通过。记录以下互不混淆的状态：

- **PASS / FAIL**：verifier 的测试确实执行并产出有效判定；FAIL 必须能看到真实断言/功能失败，而非仅有退出码。
- **TIMEOUT / BUDGET_LIMIT**：记为资源受限终止，仍对截止时的工作区进行评分；终止原因与最终 PASS/FAIL 两列分别记录。
- **INFRA_ERROR / ADAPTER_ERROR**：缺依赖、DNS、容器/评分器启动或适配器错误，评分记 NA，不伪装零分；同时计入端到端可靠性记录。
- **NOT_STARTED / INTERRUPTED**：批次中止时保留缺口及原因。

完整配对不足时不发布“3 题胜率”。不默默丢弃基础设施失败；所有尝试、累计花费都保留。基础设施修复后的新批次单独编号；不得选择性重跑代码失败题或取最好一次。

## 4. 指标与判读顺序

1. 主指标：每题 PASS/FAIL/NA，以及配对的胜/平/负；一组三题只做诊断，不做显著性/普遍更强声明。
2. 可靠性：正常终止、预算耗尽、工具错误、适配器错误、安装/评分失败、取消后残留进程。
3. 效率：总输入、cache hit/miss、输出及 reasoning 子集；主/子/辅助调用全部计入。累计输入不是单次上下文长度。
4. 成本：保守无缓存估计、缓存感知估计和官方账单（若可得）分列。无法控制服务端缓存冷热，报告命中率和交错顺序，不声称完全消除缓存影响。
5. 时间：启动、有效 agent、工具等待、模型响应、评分各自计量；并行活动可能重叠，不能简单相加冒充墙钟耗时。
6. 资源：记录整个 harness 进程树的峰值 RSS/CPU 和容器峰值，不能只量 Rust 主进程而漏掉 Node worker/子 agent。Linux 结果不直接外推 Windows 内存。

比较 token 的首选集合是**双方都通过的相同题目**。全套总成本/通过数可以附报，失败尝试成本不能消失；通过数为零时记 NA，不能声称最省。工具调用少、输出少、进程占用低都不单独等于 agent 能力强。

## 5. 分阶段执行与验收门槛

### Task 1：环境和评分器先验收（零模型费用）

**Files:** 新建 `scripts/terminal_bench/environment_preflight.py`、`scripts/terminal_bench/test_environment_preflight.py`；修改 `scripts/terminal_bench/health.py`、`scripts/terminal_bench/README.md`。

1. 写失败测试：依赖缺失、DNS 卡死、pytest 未收集测试、verifier 安装失败却写 reward 0，均不得通过验收。
2. 执行 `python -m unittest discover -s scripts/terminal_bench -p test_environment_preflight.py -v`，确认测试先失败。
3. 准备每题双方相同的中性依赖层，预装所需 Node/Python、rg、ps 和评分依赖；已不跑 Terminus，不再把 tmux 当成无条件要求。依赖版本必须兼容题目原始构建故障，不得预先升级包而把题目修掉。
4. 验证真实安装和评分入口，而非只测 HTTP 200。空白基线应能跑到实际测试；如使用官方 oracle 验证评分链，只放在独立 grader 验收容器，绝不进入 agent 可见工作区、镜像层、提示或日志。
5. 同一镜像通过工具、原始题目状态、网络/离线依赖和 verifier 执行检查后保存 manifest。离线方案不能悄悄改变题目网络权限或替换评分逻辑；出现不兼容则停止。
6. 重跑测试，提交独立的环境验收改动。任何共享宿主网络调整先请求用户明确授权。

### Task 2：接入官方完整 headless，保持原版行为

**Files:** 新建 `scripts/terminal_bench/deepseek_agent.py`、`scripts/terminal_bench/test_deepseek_agent.py`；修改 `scripts/terminal_bench/agents.py`、`scripts/terminal_bench/run_pilot.py`。

1. 在独立源码目录阅读官方对应 SHA 的 AGENTS、headless、base、模型配置与凭据接口；锁定构建工具链，记录官方配置。
2. 写失败测试覆盖正常退出、非零退出、超时后评分、凭据脱敏和子进程清理；运行 `python -m unittest discover -s scripts/terminal_bench -p test_deepseek_agent.py -v` 确认红灯。
3. 通过真实 `dsh` launcher 启动完整 headless；适配器仅注入任务、工作目录和测试模型端点。不用自制精简 agent，不套用 XHarness 提示词。
4. 使用独立 runtime home，避免读取服务器/用户已有配置、插件和密钥。模型端点只用受限代理，真实 key 不进入容器、argv、报告或仓库；子 agent/辅助调用也不能绕过代理。
5. 用本地 mock provider 完成确定性任务，确认双方经历真实工具执行、会话结束、日志保存、评分和清理，零真实 API 费用。
6. 测试转绿后做独立提交。官方适配器并非本计划撰写时已实现。

### Task 3：统一协议、计量、截止和错误分类

**Files:** 新建 `scripts/terminal_bench/protocol.py`、`scripts/terminal_bench/test_protocol.py`；修改 `scripts/terminal_bench/broker.py`、`scripts/terminal_bench/headless.py`、`scripts/terminal_bench/run_pilot.py`、`scripts/terminal_bench/test_broker.py`、`scripts/terminal_bench/test_agents.py`。

1. 写失败测试：同一配置驱动两个适配器、16384 输出的预算预留、40 次全局请求、子调用共享预算、到点清理、在途用量完整归属、有效评分与安装报错区分。
2. 执行 `python -m unittest discover -s scripts/terminal_bench -v`，确认新测试失败。
3. 将散落的 290/300 秒、4096 输出、0.30 美元改为同一份不可变协议配置；移除对照组的非对称提前停止；固定两组相同输入任务与机器限制。
4. 写入完整 SHA、依赖清单、镜像摘要、模型响应标识、参数、提示词/工具清单哈希；运行前保存协议，运行后不得原位修改记录。
5. 用 mock provider 验证一次超时、一次预算拒绝和一次普通完成都能生成准确的结构化报告；任何活跃模型任务必须在隐藏测试注入前停止。
6. 测试通过后原子提交。CI 只跑无密钥测试；Rust 构建/测试只在 WZU 或 CI，禁止本机 Windows Rust 编译。

### Task 4：执行一次完整小样本（6 trials）

**Files:** 修改 `scripts/terminal_bench/run_pilot.py` 的默认对照配置；新建 `docs/specs/official-deepseek-comparison-results.md`。

1. Task 1–3 全部通过，且批次预算确认后，才允许真实模型调用；当前计划不是已启动运行。
2. 固定上述顺序、完整配置和新批次目录，运行六次。以任务为配对单位；禁止看一半结果修改提示词、时间或参数。
3. 持续记录预算与基础设施故障；发生已确认的共同基础设施问题停止后续调用，报告未开始样本，不循环收费重试。
4. 每次结束后独立评分、保存证据并检查容器/进程清理。隐藏测试不能反馈给仍在运行的 agent。
5. 输出六行完整明细：版本、题目、agent、终止原因、grade、输入/缓存/输出/reasoning、调用次数、有效时间、工具失败、费用、证据位置。

### Task 5：看分数和轨迹选一个优化，再验证

**Files:** 新建 `scripts/terminal_bench/summarize.py`、`scripts/terminal_bench/test_summarize.py`；更新结果报告。产品修改的具体文件须等失败归因后另列，不能事先认定是上下文/工具设计问题。

1. 测试报告不能把 NA 变 0、不能把失败成本过滤掉、不能对无共同通过题计算误导性节省率。
2. 先列差距：谁独立通过、谁失败、失败发生在模型推理/工具/等待/上下文/环境哪一层；仅有日志相关性时标记为假设。
3. 每轮只改一个有证据的因素。候选包括预算提示、长任务等待、工具发现、原文回读；不靠删除历史原文或拆断未结束工具状态提速。
4. 3 题 × 1 次不支持强弱结论。若值得继续，另行确认扩展预算，让两组每题累计至少 3 次，并对顺序交错；三次重复仍只用于观察稳定性，不夸大统计把握。
5. 这三题成为开发集后，再从未用于调参的任务中冻结留出集验证改动；不能只在已见题目上追分。长时间上下文恢复、自定义 Windows/PowerShell 回归另列专项，不混入官方题目分数。
6. 测试工具与报告沿用上游 PR #55 后续提交，不重复创建相同方向 PR；明确标注真实运行结果与尚待验证项。

## 6. 最终交付与本次边界

- 可复用命令入口、固定 manifest、官方适配器、环境验收、离线 CI、原始私有轨迹与公开脱敏汇总。
- 第一轮目标是拿到 **6 个可解释的结果**，不是承诺 XHarness 获胜。环境/适配器仍失败时，交付明确的阻塞证据而不是虚构成绩。
- 本次仅新增计划文件；不改运行代码、不启动模型、不发版、不变更 App、不推送 PR 修改。

参考：[官方 BENCHMARK.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/BENCHMARK.md)、[官方完整 headless](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)。文档引用查看于 2026-09-11；执行时以最终锁定 SHA 的内容为准。
