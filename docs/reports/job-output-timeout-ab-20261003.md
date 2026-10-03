# job_output 等待超时：隔离实验报告（2026-10-03）

## 结论

- **真实 bug 已复现**：旧版 `job_output(wait=true, timeout_ms=-1)` 经宽松整数解析变成缺省值，而不是错误。生产缺省等待仍是 30 秒。已完成 Job 的测试明确返回成功，证明错误参数被接受。
- 候选只改这一个解析点。V100 **68 项回归通过**、4 项 live endpoint ignored；coding-tools 全目标 Clippy 通过。
- DeepSeek 与 V100 Qwen 27B 共 **8 次真实隔离任务，8/8 独立验收通过**；候选故障组 **2/2** 拒绝负值，并以同一 Job id、合法值恢复。旧版故障组 **2/2** 接受了负值。
- **这不是提速证据**。每模型／变体只有一对，Qwen 普通任务候选耗时明显增长，不隐去退化；不扩样本追逐优势。
- 实验完成时仅留候选、测试和文档，未提 PR／推送／合并／替换软件。用户随后授权提交 PR 并在 CI 通过后合并，正式整理见下节。

## 唯一变量与基线

基线 `dc4b53d`，包含 #196 Read 与 #197 前台 Shell 参数修复。仅 `crates/xharness-coding-tools/src/lib.rs` 一个生产文件不同：调用 `job_wait_argument`，显式负值不再被当作缺省。工具描述／Schema、30 秒默认、1–600000 ms 范围、Job 生命周期、并发键、返回结构及其它工具不改。两臂相同测试和同一个实验 probe；source manifest 在运行前、后核对一致；每个模型请求的 Definitions 完全一致。

两臂分别远程编译并保留二进制；本机不编译 Rust。编译前刷新源文件时间戳，避免上次共享 target 旧产物复用风险：

- baseline SHA-256：`785fa3cb237248146cc0603b464533dca3c1df52ce03a1eb15681f0e922f2f7f`
- candidate SHA-256：`7733210bc3f372ec8d336824bfdad23aba27b96a907280fc5aaea5b2bb9d89ab`

## 确定性回归

新增 6 个 ToolExecutor → CodingToolBundle → JobRegistry 集成测试，覆盖：

1. 已完成 Job 也不能接受 −1、i64::MIN、0、600001、u64::MAX、null、浮点、字符串、bool；其中类型错误及零／超上限原本已有拒绝能力，不算新收益。
2. 缺省、1、30000、600000 ms 合法参数保留输出与 completed 状态。
3. 正常运行 Job 的等待超时返回 running，不取消 Job；输出游标增量读取且重复读取为空。
4. 取消等待仍能读到 running Job，后台任务不随等待取消。
5. Job 完成唤醒等待，另一个 Job 的读取也能完成。
6. 外会话 Job、未知 id、错误／越界游标、wait=false 携带 timeout 等保持错误。

同一新增测试在旧版为 **5 通过／1 失败**（负数被接受），退出码 101，保留原始日志。候选四 crate 测试：coding-tools、platform、fs、jobs 共 **68 通过**（48 基线 + 6 新契约 + 14 Job 回归）；4 个现有 live 测试 ignored 不计入通过，真实模型实验单独运行。coding-tools `clippy --all-targets -- -D warnings`、本机 fmt／diff 检查通过。分析器 4 个单测本机和 V100 通过。

新增等待测试使用受控 JobLease，真实模型任务另用实际 shell 子进程。只在 Linux V100 验证，不等同于 Windows/macOS 实机验收；短 Job 可能在模型发起读取之前已经完成，本轮不宣称实测消除了 30 秒等待。

## 模型与任务

- DeepSeek：本机现有配置 `deepseek-flash`，`https://api.deepseek.com`，thinking enabled、reasoning_effort=low；实验独立设置，不改变软件偏好。
- Qwen：V100 `/v1/models` 和 `/props` 实际返回 `qwen3.8-27b-uncensored`，Q8_0、n_ctx=262144；沿用上次相同 enable_thinking／low 配置，不修改服务。
- 两个模型各运行普通任务 A/B、故障任务 B/A，共 8 次，新工作区／Loop／JobRegistry，无历史共享。
- 编程任务修复 consecutive groups 的 `runs.py`，列表／生成器／空输入／Unicode；固定测试不许改，要求后台运行测试并通过 `job_output` 收集完成及测试输出。
- 故障变体先创建 0.4 秒无害后台 Job，明确调用一次 timeout_ms=-1；候选被拒绝后必须使用同一 Job id、1000 ms 恢复，再完成编程。**这是显式故障恢复测试，不是模型自发选择 Job 的泛化测试。**
- 独立检查原始测试、80 个固定种子的随机序列及边界、列表／生成器两种输入、文件修改范围和后台测试终态；原始错误实现的门禁失败，正确控制实现通过。
- 每次最多 16 步、4096 输出／请求、16000 输出／turn、300 秒 watchdog，两个臂一致；总 8 次、30000 DeepSeek 未缓存输入上限，不追加运行。

## 观测

| 模型／任务 | 验收 A→B | 耗时 A→B | 请求 A→B | 报告未缓存输入 A→B |
|---|---|---|---|---|
| DeepSeek 普通 | 1/1→1/1 | 8.91→8.67 s（−2.68%） | 8→8 | 2235→2238 |
| DeepSeek 故障 | 1/1→1/1 | 13.12→9.38 s（−28.47%） | 11→9 | 2864→2958 |
| Qwen 普通 | 1/1→1/1 | 22.59→40.51 s（+79.34%） | 5→7 | 1090→1639 |
| Qwen 故障 | 1/1→1/1 | 40.66→44.48 s（+9.41%） | 6→9 | 2036→2229 |

普通组没有负超时调用，两臂主路径语义相同；模型生成长度、额外检查、请求数量不同，不能把耗时差异当作该解析点的因果收益／损失。仅一对也无法证实不退化。故障组新增参数拒绝是预期正确行为，不以 ToolResult 错误数单独判断质量。

额外轨迹：DeepSeek 普通两臂、旧版故障臂都曾 `write` 未经 read 观察的文件，被现有版本保护拒绝后恢复；旧版故障臂还有一条 Python 语法错误命令。这些不是本次变量，不改保护机制，也不归因于 job_output。可作为后续**仅改 write 描述**实验的候选证据，不能据此断言描述一定有效。

共享模型缓存和负载不重置、模型随机采样未固定。按模型分别报告，不跨模型合并“性能收益”，不声称 KV 命中改善。

## 消耗与证据

- DeepSeek 36 个生成请求：报告未缓存输入 **10295**、缓存读取 **103929**、归一化可见输出 **5182**、推理 **1036** Token。
- Qwen 27 个请求：报告输入 **6994**、缓存读取 **87589**、可见输出 **7268**、报告推理 **0**；零字段不证明模型没有推理。
- 每次 step_usage 数与捕获请求数核对一致。私有证据 `/Users/wangyue/codex-build/job-output-evidence-20261003/`：原始事件／请求／结果／产物、模型 metadata、两臂 source manifest、binary hash、门禁／分析与完整编译日志；hash manifest 已保存。
- API 密钥只经 SSH stdin 传给 probe，不写入配置／证据；实际密钥扫描确认不在证据文件内。
- 预检 metadata 曾把 props URL 错写为 `/v1/../props`，返回 404；修正为实际 `/props`，发生在付费运行之前，无付费任务重跑。ToolCompleted 解析预先使用上一轮原始轨迹确认 `result.content` 字段，没有依赖猜测。

## 下一步

建议将严格等待超时解析视为正确性修复，用户确认后再整理独立 PR。其它工具继续逐项、单变量实验；不在本轮混改描述或扩大 API。规范见 [实验流程](../specs/job-output-timeout-ab.md)。

## 正式 PR 整理

用户确认后仅提交生产解析、六项契约测试与中文文档；实验 probe／跑批／密钥／私有证据不提交。以 #197 的分支为 base，避免重复包装 #196／#197；两项前置 PR 的 CI 尚未全绿，不能提前合并。源代码和测试与上述 V100 已验证版本完全相同；待正式提交的跨平台 CI 复核。不替换软件。

### 合并基线调整

进一步检查确认该参数修复不调用 #196／#197 的新增 API，没有实际代码依赖。为避免不必要的串行门禁，正式 PR 改为以最新 master `6010a59` 为基线，仅移植 job_output 解析与六项测试，不带入 read／前台 Shell 改动；上述 A/B 原始实验仍保留原冻结基线，不追改证据。正式 master 基线重新执行回归后单独报告，需本 PR 全部 CI 通过方可合并。

同时修正既有 Windows 后台测试的等待假设：一次 5 秒 wait 返回 running 是合法结果；测试在总 30 秒 deadline 内用 1 秒有界 wait 收到终态后再检查 stdout/stderr、failed 与 exit 7，所有原断言保留。不改变生产逻辑，不把 Linux 验证冒充 Windows 通过。

最新 master 独立基线的 V100 四 crate 正式回归 **55 项通过、4 项 live 测试 ignored**，coding-tools 全目标 Clippy 通过；与实验的 68 项差额为未携带 #196 的 11 项 Read 新契约及 #197 的 2 项 Shell 新契约，不是删测试／测试退化。完整输出保存 `master-regression.log`。
