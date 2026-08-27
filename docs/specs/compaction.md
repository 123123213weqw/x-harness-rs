# 上下文压缩（Compact）规范

**所属层：** `xharness-compaction`、`xharness-context`、`xharness-session`、`xharness-token`  
**状态：** 自动 Pressure/Overflow、摘要、重计量、Session Replace 事务、Web 投影与崩溃恢复已
接线到正式 Durable Host；手动 `/compact` 和生产 Tool Result Pruner Replace 尚待完成。

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
| `thresholdRatio` | `0.8` | 完整请求达到模型窗口 80% 时进入自动压缩 |
| `retainRatio` | `0.16` | 摘要后尽量逐字保留最近 16% 窗口 |
| `maxTokens` | `8192` | 摘要辅助请求的最大输出 |
| `compactionRetries` | `1` | 首次之外再尝试一次，总计最多两次 |
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
- 原请求的 System、Tool Schema 和被选消息；
- 固定的 Compact Instruction。

后端应当先逐字重放原 System/Tools/Messages，最后追加 Compact Instruction，以复用 Provider 的
Prefix/KV Cache。返回值必须是完整、非空、纯文本输出；超出 `maxTokens`、图片输出、取消和流错误
都必须失败，不能提交半截 Checkpoint。

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
3. 正式 Host 默认安装 `CompactionConfig::default()`。完整请求达到 80% 时自动 Pressure；Hard
   Guard Overflow 在发普通模型请求前压缩；Provider 在无 Delta 前返回可识别的 400 Context
   Overflow 时关闭当前 Step、压缩并在新 Step 重试。
4. Checkpoint Frame 用同一 Provider-neutral 保守消息价格重新计量；不小于 Shadowed Token 的
   摘要拒绝提交。成功 Replace 后重新构造完整请求，并再次走 Provider 原生计数/Token Guard。
5. Web 投影公开全部 `compaction/*`，替换消息携带
   `surfaceOp={op:"replace",start,end}` 与 `sourceEventSeqs`。

当前自动摘要复用活跃 Provider/Model，保留相同 System、工具 Schema、被选消息和末尾 Compact
Instruction，以尽可能复用 Prefix/KV Cache。配置若指定了不同摘要路由而 Host 尚未注册 Purpose
Router，会明确失败，不会偷偷使用另一个模型。

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
2. 增加手动 `/compact` 和空闲 Session Maintenance Turn；当前只有自动 Pressure/Overflow。
3. Provider 优先消费结构化错误码；为 OpenAI-compatible 私有部署保留的 400 文本分类必须继续
   限定为“无任何 Delta + 有上限恢复”，不能泛化成任意字符串重试。
4. 增加 Purpose Provider Registry、独立摘要路由、真实 SIGKILL/Flush 全切点矩阵和按模型精确
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
