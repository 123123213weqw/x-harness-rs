# 上下文压缩（Compact）规范

**所属层：** `xharness-compaction`、`xharness-context`、`xharness-session`、`xharness-token`  
**状态：** 自动 Pressure/Overflow、手动 `/compact`、摘要、重计量、Session Replace 事务、Web
投影与崩溃恢复已接线到正式 Durable Host；生产 Tool Result Pruner Replace 尚待完成。

## 目的

Compact 不是删除聊天记录，而是把不可变 Session Event Log 投影成更短的模型可见 Surface：

```text
完整 Event Log（审计真源，不删除）
        │
        ├─ Token Meter：计算完整请求压力
        ├─ Tool Result Pruner：无模型、确定性地缩短旧结果
        └─ Summary：把安全的历史前缀替换为一个 Checkpoint User Message
                           │
                           ▼
                    下一轮 Model Surface
```

历史原文、Tool Call/Result、Provider Call ID 和副作用审计必须仍能从 Event Log 恢复。摘要只能替换
Surface，不能成为唯一事实来源。

## 默认数值

`xharness-compaction` 的 Basic 默认值与当前 DeepSeek Harness `compaction-basic` 对齐：

| 配置 | 默认值 | 含义 |
|---|---:|---|
| `thresholdRatio` | `0.8` | 自动触发线的上界；生产链路同时按真实可用输入区和近期增长预留缓冲 |
| `retainRatio` | `0.16` | 摘要后尽量逐字保留最近 16% 窗口 |
| `maxTokens` | `8192` | 摘要的初始输出预算；截断后独立重计数并有界增加 |
| `compactionRetries` | `1` | 每个摘要请求的可重试网络/服务错误次数；输入超限不原样重试 |
| `maxOverflowRetries` | `1` | Provider 返回规范化超窗错误后的最大恢复次数 |
| `auto` | `true` | 开启 Step 边界压力触发 |

旧 Tool Result 的无模型裁剪默认值：

| 配置 | 默认值 |
|---|---:|
| `thresholdChars` | `8192` Unicode Code Point |
| `headChars` | `4096` |
| `tailChars` | `1024` |

中段使用固定标记 `[... tool result middle pruned ...]` 替换。字符预算按 Unicode Code Point
计算，不能切断 UTF-8；相同输入和配置必须产生逐字相同输出。

以当前 53,248 Token 模型窗口为例：

```text
thresholdTokens = floor(53248 × 0.8)  = 42598
retainTokens    = floor(53248 × 0.16) = 8519
```

这里的 42,598 是触发线，不是硬上限。真正能否发送仍由 `xharness-token::TokenGuard` 结合输出预留
和安全余量决定。

## 公共抽象

### 配置与路由

- `CompactionConfig`：全局默认策略、`auto` 和精确 Provider/Model 覆盖表。
- `ModelCompactionPolicy`：只做 Provider/Model 完全匹配，禁止前缀、别名或模糊匹配。
- `CompactionSpec`：把 Ratio 按真实 `context_window_tokens` 展开成整数 Token 预算。
- `summarizationProvider` 与 `summarizationModel` 必须同时为空或同时非空；为空表示复用当前会话
  路由。
- `retainRatio` 与 `retainTokens` 互斥，解析后 `retainTokens < thresholdTokens`。

### 规划

`BasicCompactionPlanner::plan(CompactionRequest)` 是无副作用的纯决策：

1. `Pressure`：只有 `currentInputTokens >= thresholdTokens` 才规划；`auto=false` 返回 Disabled。
2. `ContextOverflow`：绕过正常阈值并把 Retain 预算置零，以便至少做一次有用缩减；仍保留一个
   不可分割的安全尾部。
3. `Manual`：不检查阈值，使用正常 Retain 预算。
4. 规划只返回 `CompactionPlan`，不调用模型、不写 Session。

`CompactionPlan` 固定目标路由、Surface Generation、选中范围、Shadowed Seq/Token、摘要上限和
总尝试次数。异步摘要完成后，提交方必须重新验证 Generation 和范围价格，防止用旧摘要覆盖新历史。

### Tool Pair 安全边界

范围必须从当前 Surface 头部开始。规划器先从尾部累计 Retain Token，再向前移动到最近的安全
边界。安全边界要求：边界之前出现的每一个 Assistant Tool Call 都已经有对应 Tool Result。

禁止：

- 把 Assistant Tool Call 放进摘要、却把对应 Tool Result 留在逐字尾部；
- 把 Tool Result 放进摘要、却把对应 Tool Call 留在逐字尾部；
- 接受孤立 Tool Result、重复/空 Call ID、乱序或重复 Surface Seq。

当前 Tail 可以包含尚未完成的调用，但 Compact 范围不能切进该调用批次。

### 摘要接口

`CompactionSummarizer` 是异步 Provider-neutral Trait。`SummaryRequest` 包含：

- 已冻结的 `CompactionPlan`；
- 原请求的 System 和被选消息；
- 固定的 Compact Instruction。

Compact 是封闭摘要操作，必须发送 `tools=[]`，避免重复注入 Tool Schema 或诱导模型调用工具。
后端应当先逐字重放原 System/Messages，最后追加 Compact Instruction，以复用 Provider 的
Prefix/KV Cache。摘要推理强度与主对话完全隔离：Host 按模型声明顺序选择最低支持档，无推理档位
的模型不发送 override；禁止把主对话的 high/xhigh 复制到摘要请求。返回值必须是完整、非空、
纯文本输出；输出截断必须丢弃局部正文并调整额度或分块，取消和不可恢复错误不得提交半截 Checkpoint。

落地的替换消息使用：

```text
Checkpoint Preamble
<compacted-summary>
...结构化摘要...
</compacted-summary>
```

提交前必须用相同 Token Meter 计算带 Frame 的摘要；如果摘要 Token 数不小于被遮蔽历史，必须
拒绝替换。

## 已落地的生产接线

1. Session 已有 `compaction/start`、`compaction/summary`、`compaction/end`、
   `compaction/prune` 和 `UserMessage.surfaceReplace`；`derive_surface_messages()` 只遮蔽模型
   Surface，原 Event Log 保持不变。
2. Core 先 Flush Start，再执行异步同路由摘要；Summary + Checkpoint Replace + 成功 End 在一个
   CAS Batch 内提交并 Flush。摘要失败写错误 End；未闭合 Start 在重启恢复为 interrupted End。
3. 正式 Host 默认安装 `CompactionConfig::default()`。达到预算感知触发线时自动 Pressure；Hard
   Guard Overflow 在发普通模型请求前压缩；Provider 在无 Delta 前返回可识别的 400 Context
   Overflow 时关闭当前 Step、压缩并在新 Step 重试。
4. Checkpoint Frame 用同一 Provider-neutral 保守消息价格重新计量；不小于 Shadowed Token 的
   摘要拒绝提交。成功 Replace 后重新构造完整请求，并再次走 Provider 原生计数/Token Guard。
5. Web 投影公开全部 `compaction/*`，替换消息携带
   `surfaceOp={op:"replace",start,end}` 与 `sourceEventSeqs`。
6. `/compact` 是空闲 Session 的无输入 Maintenance Turn：先持久写入 `command/run`，再以同一
   `commandId` 关联 `compaction/start|summary|end`，完成后写 `command/done`。它不创建用户消息、
   不调用普通 Agent 回复；运行中 Session、参数或附件会明确拒绝。Host/Agent 重启会从未闭合的
   `command/run` 恢复，同一命令不会被当成普通消息重复执行。
7. 自动压缩的 Web 节点从 `compaction/start` 起立即显示“正在压缩”动画；成功 Checkpoint 原位
   替换为可展开摘要，失败或取消在 `compaction/end` 后移除临时节点。实时事件与分页历史使用同一
   reducer，避免刷新前后表现不同。

当前自动摘要复用活跃 Provider/Model，保留相同 System、被选消息和末尾 Compact Instruction，
但不携带工具，并通过 `LoopRequest.compaction_reasoning_effort` 使用该模型最低成本档位；主请求仍
保持用户选择的独立 `reasoning_effort`。配置若指定了不同摘要路由而 Host 尚未注册 Purpose Router，
会明确失败，不会偷偷使用另一个模型。

## 消融开关与 4080 Qwen 验证

正式 Host 支持从 CLI 或环境变量选择 Compact 策略：

- `--compaction-config default` / `XHARNESS_COMPACTION_CONFIG=default`：安装默认自动策略；
- `--compaction-config off`：完全不安装 Compaction Runtime，用于真正的无压缩对照组；
- `--compaction-config /absolute/policy.json`：加载并校验一份 `CompactionConfig`；
- JSON 中的 `auto=false` **不等于完全关闭**，它只关闭 Pressure，Provider/Hard Guard 的
  Context Overflow 仍可以触发有界恢复。

`scripts/compaction-ablation.py` 会为每个 Variant 创建独立 Workspace、State Dir 和 Durable
Session，通过正式 Web RPC 驱动两轮任务，并保存 History、Debug Trace、Usage、Compact 事件、事实
命中率、延迟和退出状态。内置四组为 `disabled`、`overflow_only`、`auto_default` 和
`auto_aggressive`。

2026-08-25 在 RTX 4080 的 Qwen3.8-27B `Q3_K_M`/llama.cpp 上完成首轮四组烟测：四组均精确
回忆 3/3 事实；两个非 Auto 组 Compact 0 次，两个 Auto 组各完成 1 次
`start/summary/end`；四个 Host 均正常退出、没有 Forced Kill。机器可读证据见
[`docs/evidence/compaction-qwen-4080-20260825`](../evidence/compaction-qwen-4080-20260825/README.md)。
该轮共用一个热推理进程，所以只能作为功能验证；延迟/KV Cache 性能结论必须增加多任务、多 Seed、
轮换顺序，并在 Variant 间重启或清空 Provider Prefix Cache。

## 剩余接线

1. 把 `ToolResultPruner` 接成 `compaction/prune + tool/result replace` 的生产事务；目前单次模型
   写回仍先经过 256 KiB Head/Tail Envelope，自动摘要可继续缩短历史，但 8,192 字符旧结果裁剪
   尚未主动运行。
2. Provider 优先消费结构化错误码；为 OpenAI-compatible 私有部署保留的 400 文本分类必须继续
   限定为“无任何 Delta + 有上限恢复”，不能泛化成任意字符串重试。
3. 增加 Purpose Provider Registry、独立摘要路由、真实 SIGKILL/Flush 全切点矩阵和按模型精确
   Tokenizer；当前 Range 节点价格是保守 JSON/UTF-8 价格，最终准入仍由请求级权威计数决定。

## 验收标准

- 默认数值和 53,248 窗口展开值固定回归。
- 精确路由覆盖、重复路由、Ratio/Tokens 冲突、Summary Target 半配置均 fail closed。
- Pressure、Overflow、Manual 三种 Trigger 行为固定。
- 多 Tool Call 并行批次不得在任意 Call/Result 之间切开。
- Unicode 裁剪不产生无效 UTF-8，重复执行结果稳定且第二次不再裁剪。
- 空摘要、截断摘要、图片摘要、摘要不变小、Surface Generation 改变都不能提交。
- Session 测试已覆盖成功 Replace 不删除源历史和未闭合 Start 恢复；仍需真实 SIGKILL 覆盖
  Summary、Replace、End、Flush 边界。

## 2026-09-18：摘要预算与分块恢复

### 现场与根因

`code5` 的正常模型请求经过 `context-history-pruning` 后约 21 万 Token；摘要直接取 Session 原始
Surface，恢复了更长的历史思考和工具结果，摘要输入达到 29–33 万，超过当前 262144 的部署窗口。
旧实现没有给摘要请求独立计数，且失败后重复同一请求；这不是普通请求 Tokenizer 漏计。

### 执行契约

- Core `compaction::SummaryRunner` 复用当前 Provider 的完整请求计数和 `TokenGuard`，通过
  `with_budget` 仅重绑摘要输出预留；保留计数超时、估算策略与 strict/fallback 设置。
- 每次请求（原始摘要、每个分块、合并、增大输出后的重试）在发模型前检查
  `input + summary_output + safety <= context`。未知容量不能猜，缺少绑定预算明确失败。
- 首选完整原始消息，以保留事实和前缀缓存。过大时只在闭合 Tool Call/Result 边界二分。
  单个巨大事务/文本仍超限则转为带角色、调用 ID、参数和附件引用的历史文本片段，按 UTF-8
  边界分割；不会把孤立 Tool Result 当作协议消息发送。opaque 签名不是摘要正文；附件引用
  不是重新识别出的图片内容，原始多模态数据仍保留在历史中。
- 分块结果递归合并，不能靠拼接无限增长的中间摘要绕过预算。中间摘要不缩小原输入时失败。
  最多 64 次模型调用、16 层恢复，防止失效模型导致无限分裂；达到保护线不提交替换。
- `output token limit`：丢弃不完整结果，输出按倍数增加，每次重新计数。提高上界不超过初始值
  4 倍与主路由已配置输出目标的较小者，并受上下文硬容量约束；初始摘要额度是目标，不是
  小窗口也必须满足的最小值。实际输出按当前摘要输入余量分配；仍截断或空间不足则分块。
  主对话输出预算、思考强度均不修改；摘要继续使用独立最低支持思考档。
- 只有可重试 Provider 错误有限退避；401/其他永久错误直接失败；输入超限必须改输入。
  同一运行内相同历史范围、相同摘要配置失败后不重复花费。跨用户回合没有永久封禁恢复。
- 取消会同时取消计数和摘要流。所有分块完成、最终摘要更小，且完整候选主请求通过预算验收后才执行原子 CAS 替换。
  任何中途失败均保留原始历史，记录失败 End；新测试覆盖失败时不存在 `CompactionSummary`。
- `compaction.summary_completed` debug 记录模型调用数、分块数和累计 usage；持久化摘要的
  `max_tokens` 记录本次实际用过的最高输出预算，而非固定初始值。

### 触发线与保留空间

生产 Core 使用 `plan_with_input_budget`：

```
B = 当前 TokenGuard 的 available_input_tokens
G = 最近 8 次有效计量中最大正增长
buffer = clamp(2 * G, max(1, floor(B / 20)), max(1, floor(B / 5)))
threshold = min(floor(context * thresholdRatio), B - buffer)
```

例如 262144 窗口、49152 最小输出、1024 安全余量：B=211968，初始触发线为 201370，
不再贴着原来的 209715 触发线。增长 8000 时触发线为 195968。上下文下降后清空增长样本。
没有预算输入的旧 `plan` API 保持原行为。默认仍保留最近 16% 的完整历史作为低水位，摘要后
重新经过普通请求准备/计量；不是每隔固定轮数压缩，也不把用户输出预算调小。

### 回归

- 33 万规模原始记录在 26 万窗口内通过三次摘要请求完成；无超预算请求发送。
- Provider 400（计数低估）、输出截断增额、瞬时错误与 401 分流。
- Unicode、超长单消息/闭合工具事务、过大 system、计数超时与 strict 配置、取消计数。
- 持久化成功后重计量；失败不提交摘要、不隐藏原文。

### 本次验证记录

2026-09-18，在 `WZU_Server:~/codex-build/x-harness-rs-compact/` 完成
`cargo test --workspace`，退出码 0；`xharness-core`、`xharness-compaction`、`xharness-token`
的 `cargo clippy --all-targets -- -D warnings` 通过。新增 15 个回归用例，包括分块部分成功后
第二块失败不提交任何 Checkpoint、摘要流取消和永远截断的模型有界退出。

33 万/26 万案例是可复现的 Provider 计数与流式 fixture，不冒充真实 Qwen/DeepSeek 质量验收；
本次未发送用户原始对话到外部模型，也未替换正在运行的软件。

### 审核补修：小窗口与提交前验收

- 摘要的目标输出与主对话最小输出是不同概念。摘要临时 `TokenGuard` 最小输出设为 1，
  允许按计数后余量选择实际输出；主对话的目标/最小输出、安全余量、思考强度均不修改。
- `summary_actual_output = min(summary_target, context - summary_input - safety)`；输入连一个
  输出 Token 都容不下时先分块。目标扩容有上下文硬上界；实际输出已小于目标且仍截断，
  或扩容不能增加实际输出时，直接分块，不原样重复生成。
- 8192 是默认摘要目标，不是硬下限；4K/8K/16K 小窗口都必须能使用默认策略。
- 主请求与候选压缩结果共用 `prepare_context`，包含 System、ContextPolicy、工具 schema、
  输出续写提示及运行时通知。候选全文在内存构造，先用主请求预算验收，再提交 Summary /
  Replace / End。摘要较小但候选整体仍超限时不提交；Pressure 可继续原来合法的主请求，
  Hard Overflow 明确失败，不发送超限请求。
- 验收时用户取消，维持 Cancelled 语义；Pause/Steer 中断候选，回到控制边界，不使用旧计数。
  验收结束再次核对源 Surface；并发写入仍受已有 Session CAS 和允许的外部控制事件规则约束。
- 成功提交后仍保留正式请求重计量；`compaction.candidate_budget` debug 记录提交前的验收报告。
- 本次新增 7 个测试函数：小窗口截断分块、4K/8K/16K 默认预算、无增额空间不原样重试、
  Pressure/Overflow 候选拒绝、候选与正式请求投影一致、验收取消、验收 Steering。
- 暂未实现独立“压缩后目标线”的严格验收；本次保证完整请求合法，不声称每次都留出固定比例
  的后续工作空间。真实模型摘要质量和跨模型切换回忆能力仍需独立实验。

本次补修在 WZU_Server 执行 `cargo test --workspace` 与
`cargo clippy -p xharness-core -p xharness-compaction -p xharness-token --all-targets -- -D warnings`
均通过；Core 为 23 个单元测试、88 个 Loop 集成测试。上述为确定性 Fixture 回归，不是实时
DeepSeek/Qwen 费用调用，也不代表当前已安装软件已经替换。


### 扩展 Corner Case 矩阵（2026-09-18）

新增 13 个测试函数，不引入随机测试依赖、不调用真实模型：

- TokenGuard：7^4 组配置，每组边界前/边界/边界后共 7203 次检查，包含 0、1、u64 极值；
  独立 u128 算式校验，不复用被测的饱和计算作为唯一判据。
- 固定种子 `0x5848434f524e4552`：10000 组预算，每组校验原窗口和缩小/扩大后的窗口，
  共 20000 次检查；验证旧 Guard 不被新路由污染。这是预算层容量切换，不是桌面选模型端到端测试。
- 324 组摘要容量/安全余量/输出目标/Unicode 历史组合；逐个检查已发送请求的预算、独立
  reasoning、空 tools、调用次数有界。Fixture 的计数用于验证控制逻辑，不代表真实 tokenizer。
- 512 组 Unicode/转义/组合字符文本，递归分片后拼接逐字相等、每次分片严格缩小。
- Planner：540 组压力阈值边界检查；512 组多工具事务，每组 5 个保留量及 2 个损坏历史，
  验证不拆开调用/结果，保留尾部，拒绝孤立结果和重复序号。
- 12 种摘要异常 × Pressure/Overflow 两种触发：空流、缺结束标记、空正文、纯 reasoning、
  内容过滤、未知终止、非正常完成、非法工具调用、部分正文后永久/瞬时错误。
  失败不写入 Summary、不隐藏历史；仅 Pressure 可继续本来合法的主请求。
- 同一 Unicode 摘要按不同字符宽度分块并交错 reasoning，覆盖显式 Stop 与兼容 None 结束；
  最终检查提交内容一致，不混入 reasoning，且只有一次 Summary 提交。
- 已取消无 I/O、退避中取消无下一次请求、瞬时错误重试上限、重试不拼入上次的半截摘要。
- 候选验收中 Pause/Resume，以及通过真实 Inbox 接口并发入队的新用户消息：Pause 中止旧候选；NextTurn 入队不误判
  当前 Surface 变化，摘要可正常提交，并保留新消息供下一轮消费。

此次 V100 SSH 超时，因此没有在本机编译；新增测试由 PR #111 远程 CI 执行。
不把参数组数称为独立测试函数数，不据此宣称真实模型质量或网络恢复已经完成验收。

第一轮新增测试 CI：Linux/macOS 的 Core 91/92 个 Loop 集成测试通过；一个测试直接在 open step
写入 UserMessage，被 Session 生命周期校验正确拒绝（属于测试夹具无效，不是生产缺陷）。已改为
实际使用的 AgentInboxSpliced/NextTurn 接口重新验证。第一轮提前退出的预算层用例不算通过。

第二轮验证：测试源码提交 `4dac7065b0cc09505217b21c35f41ac0a3cd84a6`，
[CI 35324269598](https://github.com/123123213weqw/x-harness-rs/actions/runs/35324269598)。
Linux、macOS arm64、Windows 的 `cargo test --workspace --all-targets` 均通过；Linux 和 Windows
全工作区 Clippy 通过。Linux Core 单元 28 项、Loop 集成 92 项全部通过，预算随机矩阵也已执行。
本节约 32253 组矩阵/生成场景位于 13 个新增测试函数内，不能与独立测试函数数混算。
当时 Windows 原生安装包构建和 Unix 更新演练仍在继续，不能称整个 CI 已绿；本批未合并、发布或部署。
