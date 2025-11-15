# 上下文压缩（Compact）规范

**所属层：** `xharness-compaction`、`xharness-context`、`xharness-session`、`xharness-token`  
**状态：** Provider-neutral 配置、压力规划、Tool Pair 安全范围、工具结果裁剪和摘要接口已实现；
Session Replace 事务与 Host 自动触发尚未接线。

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

## 生产接线顺序

当前 crate 只完成可测试的抽象和纯算法。下一阶段必须按以下顺序接线：

1. Session 新增 `compaction/start`、`compaction/summary`、`compaction/end`、`compaction/prune`，
   以及带 Source Seq 的 Surface Replace。
2. 形成单写者事务：Start 落盘充当锁；异步摘要；重验 Surface；写 Summary；原子 Replace；End；
   Flush。任何失败都尝试写 End，未闭合 Start 在恢复时视为中断事务。
3. Core 在 Provider 请求前取得同模型权威 Token Count；先执行 Tool Result Pruner 并重新计量，
   仍超阈值才请求摘要。
4. Provider 把 HTTP 400/413 中的真实 Context Overflow 规范化为 typed error；只允许按
   `maxOverflowRetries` 恢复，禁止匹配任意字符串后无限重试。
5. Host 暴露自动配置、手动 `/compact` 和可观测事件；Web 只消费 Session 投影。

在以上事务接线完成前，生产 Host 仍使用 `IdentityContextPolicy + TokenGuard`：它能在请求前拒绝
超窗，但不会自动压缩。

## 验收标准

- 默认数值和 53,248 窗口展开值固定回归。
- 精确路由覆盖、重复路由、Ratio/Tokens 冲突、Summary Target 半配置均 fail closed。
- Pressure、Overflow、Manual 三种 Trigger 行为固定。
- 多 Tool Call 并行批次不得在任意 Call/Result 之间切开。
- Unicode 裁剪不产生无效 UTF-8，重复执行结果稳定且第二次不再裁剪。
- 空摘要、截断摘要、图片摘要、摘要不变小、Surface Generation 改变都不能提交。
- Session 事务测试必须覆盖崩溃在 Start、Summary、Replace、End 和 Flush 各阶段的恢复结果。
