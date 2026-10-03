# Bash timeout_ms 单变量：DeepSeek 与 V100 Qwen 27B 验收（2026-10-03）

## 决策

**保留严格解析作为正确性修复候选，不包装成性能优化；不推进其它工具改动。**

- 生产差异只有前台 native shell 的 timeout_ms 严格解析。描述、Schema、默认 120 秒、最大 600 秒、返回结构及其它工具未改。共享 native shell handler 同样用于 Windows pwsh，但本轮没有 Windows 实机验收。
- 旧实现把负整数解析成 None、按默认时间执行。新实现明确拒绝，且在 spawn 前返回。不是新增 timeout 上限，也不是禁止合法探索。
- 16 次真实模型运行（DeepSeek 8、Qwen 8），所有编程产物通过既有测试、独立门禁与源码范围检查。
- 两模型各两次负超时诊断：旧版各 2/2 接受 -1 并执行；候选各 2/2 拒绝。候选的 4 次均以合法 30000 ms 恢复并完成编程任务；3 次重试命令追加 cat/echo 检查，非逐字复制原命令。
- 普通编程中没有自然出现负超时，两模型均值耗时反而增长；**不能证明提速／更低成本，不能称为稳定泛化收益。**

## 隔离与真实配置

基线固定 PR #196 提交 `446a34beaf67940c148a6fac9298ab02fdacedff`。独立分支 `experiment/bash-timeout-strict-20261003`，没有修改 #196 或安装软件。

两个远程源码目录各 2425 个文件的非空 manifest 逐项比较，只有 `crates/xharness-coding-tools/src/lib.rs` 不同；共同的测试和 probe example 相同。付费调用前检查，全部运行后复查冻结文件无变动。每轮 registry definitions 和真实 ProviderRequest.tools 完全相同。

- DeepSeek：本机已配置密钥，通过 SSH stdin 传入；`https://api.deepseek.com`、`deepseek-flash`、thinking enabled / reasoning_effort low。
- Qwen：V100 实际 `/v1/models` 与 `/props`，`qwen3.8-27b-uncensored`、`/uncensored/Qwen3.8-27B-Uncensored-Q8_0.gguf`、Q8_0、n_ctx=262144、1 slot，两张 V100 32GB。保存完整 props 及模板 hash；chat_template_kwargs.enable_thinking=true / reasoning_effort=low。
- Qwen 原始采样配置保留，未重启模型／清空缓存／停止其它用户任务；共享负载、缓存和随机性是耗时干扰因素。usage 中 reasoning_tokens=0 不证明没有思考。

原生 CodingToolBundle → ToolExecutor → LoopEngine → OpenAiProvider，实际调用 read/write/edit/bash 等工具。没有用 Python 仿造工具执行或模型返回。但不涵盖 Host/UI、Goal、Compact 的完整产品链路。

## 预先固定协议

同一新编程 fixture：修复 runs(items)，按连续相同元素分组并计数，支持 Unicode、空输入、列表和 generator。只允许修改 runs.py，不改既有 test_runs.py。两个任务类型：普通编程、先明确强制传 -1 的故障恢复；后者是人工探测，不当作自然误用率。

每模型每类型两对、A/B 与 B/A 交替，16 次运行。各轮独立工作区、会话和 JobRegistry。基线源码同时被既有测试／独立门禁拒绝，正确控制通过；独立门禁有固定种子的 80 个随机序列及边界，逐个验证列表与 generator。所有源范围检查不依赖模型自称完成。

共同限制：16 步、每模型请求最多 4096 输出 Token、每 turn 最多 16000 生成 Token、300 秒 watchdog；同一套配置用于两臂，不动态调优。最多 16 任务／60000 DeepSeek 未缓存输入，不追加运行。新增限制仅属于隔离实验保护，不改变生产设置。

## 确定性回归

V100 候选 coding-tools/platform/fs 共 **47 项通过**（46 既有／#196 + 1 新契约测试），4 项 live endpoint 测试 ignored。新增一项包含 9 个非法值无 spawn 与 3 个合法／省略参数调用；负数、i64::MIN、0、600001、u64::MAX、null、浮点、字符串、bool；合法覆盖省略默认、30000、600000。类型错误和 0／超上限原本已有拒绝能力，不能说全是新修复。

同一新测试在基线真实失败：`timeout_ms=-1` 被接受，命令成功运行并产生 sentinel；保留完整失败输出和退出码 101。候选三 crate 回归、coding-tools 全目标 Clippy（包括 probe）和 probe build 通过，全在 V100 编译。本机仅 fmt/Python；fmt --all --check、diff --check 通过。分析与独立门禁的 4 项 Python 测试本机／V100 均通过。

## 真实模型结果

| 模型 | 类型 | 编程验收 A→B | 平均耗时 A→B | 耗时变化 | 平均请求 A→B | 平均报告未缓存输入 A→B |
|---|---|---|---|---|---|---|
| deepseek | 普通编程 | 2/2 → 2/2 | 12.14 → 13.73 s | +13.15% | 7.5 → 8.5 | 2605.5 → 2386.0 |
| deepseek | 强制负超时恢复 | 2/2 → 2/2 | 9.27 → 14.13 s | +52.42% | 6.0 → 8.5 | 1775.0 → 2497.0 |
| qwen | 普通编程 | 2/2 → 2/2 | 27.43 → 36.54 s | +33.21% | 6.0 → 6.5 | 1973.0 → 1450.0 |
| qwen | 强制负超时恢复 | 2/2 → 2/2 | 38.95 → 44.56 s | +14.41% | 6.0 → 8.5 | 2373.0 → 2098.0 |

普通任务均未触发负 timeout，因此无法把它们的耗时／Token 差异归因于严格解析：

- DeepSeek 两对耗时变化为 −33.31%、+96.74%；报告未缓存输入均值 −8.42%，但请求均值增加。
- Qwen 两对为 −9.70%、+85.97%；报告未缓存输入均值 −26.51%，但可见输出与请求数增加。
- 各子组只有两对、一个很小的新 fixture，不足以证明普遍不退化；不混合两个模型求“总体收益”。
- 故障任务多一次明确拒绝／重试是正确行为，不能将增加的 ToolResult error 直接判作失败率恶化；旧版“成功”实际上违反负超时契约。也不能隐去候选故障任务耗时增长。
- 两后端都有报告缓存字段，但共享缓存未重置；不宣称这次解析变动改善 KV 命中。缓存均值变化不能脱离请求数量与历史长度解释。

## 消耗与设施审计

DeepSeek 总报告未缓存输入 **18527**、缓存读取 **180736**、归一化可见输出 **15308**、推理 **2350** Token；共 16 次任务而非 16 个 API 请求（DeepSeek 61，Qwen 54）。Qwen 报告输入／缓存读取／可见输出分别 15788／159079／13745。

初次分析脚本把 ToolCall 字段误写成 arguments（真实为 arguments_json），且误用大写 Completed（真实序列化为 completed）；首个付费任务结果已落盘。修复解析后复用该原始结果，没有重新调用模型。恢复协议比较还修复 tuple→JSON array 的比较差异。保留初版脚本、原始异常与 parser-fix；16 个模型结果／工具轨迹／请求／产物／门禁不追改。续跑行的 wrapper wall_ms 不代表原运行耗时，所有耗时比较用 LoopEngine 原始 elapsed_ms。

私有原始证据与 hash manifest：`/Users/wangyue/codex-build/bash-timeout-evidence-20261003/`。已检查没有包含实际 API 密钥。模型 keys 仅经 stdin，不进入 argv、环境、模型工作区或文件。

## 下一步边界

- 本轮仅证实负超时处理 bug 修复及双模型可恢复；**不是“全面超越旧版”**。
- 实验完成时生产候选、测试及报告留在独立工作区，未推送／提 PR／合并，未替换／重启软件。用户随后要求正式修复，独立 PR 整理状态见下节。
- 若合入，按正确性修复单独审核，不以提速为合入依据；搜索能力／write-edit 描述等另起单变量实验，不混入本轮。

## 正式修复整理

用户要求正式修复后，保持与实验相同的生产逻辑及工具定义；不改描述、不改默认值、不改其它工具。两个独立测试分别验证 9 个非法值没有 spawn、副作用与 3 个合法／省略参数行为，fixture 在失败时也自动清理。实验 probe example 与私有跑批设施不作为生产修复的一部分，不新增依赖。

PR #196 尚未合并，后续修复以其分支为基线，保证 PR diff 只有本项修复，不重复包装 read 改动。GitHub CI 与平台验收按实际检查状态报告；不自动合并、不替换软件。

正式 PR 版本在 V100 执行 `cargo test --locked -p xharness-coding-tools -p xharness-platform -p xharness-fs`，**48 项通过、4 项 live endpoint 测试 ignored**；三个 crate 的 `cargo clippy --locked --all-targets -- -D warnings` 通过。上述 16 次真实模型实验已独立执行，不把 ignored 项计入通过数。Windows/macOS 尚待 CI／实机验收。

正式回归首次运行曾错误接受 −1，保留失败日志 `pr-regression.log`。本机／远端生产源码 SHA-256 均为 `3cace56fc156733c4dc8a6546579db23686b973e17faea976546a40e45867e83`；不改源码内容，仅更新源文件时间戳强制重新编译后，48 项及 Clippy 全部通过，完整输出保留为 `pr-regression-retry.log`。这与两臂共用 target、rsync 保留时间戳引起的旧产物复用一致，但不把它当成已证明的生产缺陷；CI 将从正式提交重新构建复核，不能只依据共享 target 的首次输出。

### CI 等待语义修正

正式 #197 的 Windows CI 中，既有后台 PowerShell 测试在 5 秒等待结束后拿到 `running`，却直接断言 `failed`。`job_output` 的正常等待超时本就允许返回 running，不能把单个窗口当作终态门禁。测试改为在总 30 秒 deadline 内按 1 秒有界等待，直到收到 terminal snapshot，保留完整 stdout/stderr、failed 终态及 exit 7 的全部断言；不修改生产生命周期、不放宽结果标准。V100 bundle＋shell 契约 9 项通过，Windows 路径由新 CI 验证，Linux 测试不能声称覆盖 Windows 实机。
