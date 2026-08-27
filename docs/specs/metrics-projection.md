# 模型性能与 Token 投影规范

**涉及 Crate：** `xharness-core`、`xharness-provider-openai`、`xharness-session`、
`xharness-host`  
**状态：** M1–M4 已实现并验证；M5 仍属于后续可观测性扩展。  
**兼容目标：** DeepSeek Harness Web 当前使用的 `TokenUsage`、`tokenUsage` 和
`sessionStats` 契约。

## 一、目标

后端必须让现有 Web 前端无需修改即可稳定显示：

- 单轮和全 Session 的 TTFT；
- Decode Token/s；
- 输入、输出和缓存 Token；
- Prompt Cache 命中率；
- LLM 与工具累计耗时；
- 刷新、History 分页和 Host 重启后的同一结果。

本阶段只完成确定性 Session 投影和 Web 契约，不把 OpenTelemetry、计费、Provider
专有 Kernel Timing 或 GPU Profiling 混入同一个实现。

## 二、实现前缺口（现已关闭）

1. Core 已有 `TokenUsage`，内部字段为：
   `input_tokens/output_tokens/cache_read_tokens/cache_write_tokens/reasoning_tokens`。
2. OpenAI Adapter 已读取 `cached_tokens`、`prompt_cache_hit_tokens`、
   `cache_read_tokens` 和 Cache Write 别名。
3. Durable Session 已记录 `step/start`、首个非空 `assistant/chunk`、
   `assistant/message`、`tool/call`、`tool/result` 和事件时间。
4. Durable Web 投影曾把 Usage 原样序列化为 snake_case，而前端只读取 camelCase：
   `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens`。
5. `session.history.projections.values` 曾未提供 `tokenUsage` 与 `sessionStats`。
6. TTFT 和 Token/s 没有必要成为 Provider 专有字段；现已从完整权威日志确定性重建，
   并对新增事件增量折叠，History 分页不会改变全 Session 统计。

## 三、边界与真源

- 权威数据源只能是 Append-only Session Log；Host 内的 Metric State 只是可重建缓存。
- Provider Usage 是 Token 数量真源；缺失时不得通过字符数伪造“真实 Token”。
- Session Event 的毫秒时间是 Web 兼容统计真源：
  - TTFT：`step/start.time → 首个非空 Token Delta.time`；
  - Decode：`首个非空 Token Delta.time → assistant/message.time`；
  - LLM：`step/start.time → assistant/message.time`；
  - Tool：同一 `callId` 的 `tool/call.time → tool/result.time`。
- Provider 返回的 `timings`、`prompt_per_second`、`predicted_per_second` 等只能作为可选
  Diagnostic Metadata；禁止覆盖跨 Provider 的统一口径。
- 内部 Rust 类型可以继续使用 snake_case；所有 Web Event、History 和 Projection 必须在
  `xharness-host` 边界统一转换为冻结的 camelCase 契约。

## 四、公开 Web 契约

### 4.1 单次 Usage

`assistant/chunk(type=usage)` 与 `assistant/message.data.usage` 必须输出：

```json
{
  "inputTokens": 1560,
  "outputTokens": 176,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0,
  "reasoningTokens": 0
}
```

这些桶互不重叠：`inputTokens` 只表示未缓存输入；总 Prompt Token 为
`inputTokens + cacheReadTokens + cacheWriteTokens`。可选字段没有报告时可以省略；聚合投影
必须把缺失 Cache 桶视为 0。

### 4.2 `tokenUsage` 全日志投影

```json
{
  "uncachedInputTokens": 1560,
  "outputTokens": 176,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0
}
```

同一 `(turn, step)` 通常先出现 Usage Chunk，随后在最终 Assistant Message 再出现一次完整
Usage。后一个样本必须**替换**前一个样本，禁止重复累计。Cache 命中率由前端计算：

```text
cacheReadTokens /
(uncachedInputTokens + cacheReadTokens + cacheWriteTokens)
```

分母为 0 时前端隐藏命中率，不显示伪造的 0%。`reasoningTokens` 继续保留在单次 Usage，
但不加入当前冻结的 `tokenUsage` Projection Schema。

### 4.3 `sessionStats` 全日志投影

```json
{
  "turns": 1,
  "steps": 1,
  "llmMs": 5708,
  "toolMs": 0,
  "ttftMs": 2730,
  "ttftSteps": 1,
  "decodeMs": 2978,
  "decodeTokens": 176
}
```

- `turns`：至少有一个 `step/end` 的不同 Turn 数；
- `steps`：`step/end` 数，包括完成、失败和取消步骤；
- `llmMs`：成功组装 `assistant/message` 的步骤耗时之和；
- `toolMs`：成功匹配 Tool Call/Result 的耗时之和；
- `ttftMs/ttftSteps`：TTFT 总和与有效样本数；
- `decodeMs/decodeTokens`：同时具有首 Token 与 Output Usage 的步骤总和。

前端显示：

```text
平均 TTFT = ttftMs / ttftSteps
Token/s = decodeTokens / (decodeMs / 1000)
```

首 Token 是第一个非空 `text-delta`、`reasoning-delta` 或有效
`tool-call-delta`。空 Heartbeat 和空 Delta 不得计为首 Token。取消后没有组装 Assistant
Message 的部分流不进入耗时聚合；`turn/end` 必须清理未完成的 Tool Call 计时状态。

## 五、后端模块设计

### 5.1 Web Usage Mapper

在 `xharness-host` 建立唯一的 `web_token_usage()`：

- 输入内部 `TokenUsage` 或 Session 中的兼容 `Value`；
- 同时接受历史 snake_case 和未来 camelCase 日志；
- 输出严格 camelCase；
- `web_assistant_chunk()`、`assistant/message` Live Frame、History Restore 共用；
- 禁止在 Driver 和 Restore 中分别手写字段。

### 5.2 纯 Metric Projector

新增无 I/O 的纯折叠器，至少包含：

- `TokenUsageProjectionState`：Totals 与当前 Step 的最后 Usage Sample；
- `SessionStatsProjectionState`：Totals、Open Step、Last Turn 与 Pending Tool Calls；
- `apply(event)`：返回发生变化的 Projection Key；
- `view()`：只返回冻结的 Web Value；
- `rebuild(session)`：从完整 Session Cut 确定性重放。

投影器不得依赖 UI、网络、当前系统时间或 Provider 实现。

### 5.3 Host 集成

- Session 创建时以零值初始化两个 Projection；
- Durable Session 恢复时从权威日志重建；
- `sync_authoritative_session()` 对新增事件增量 Apply；
- 每次 Projection 变化都发送带对应 Event `seq` 的 `session/projection` Frame；
- `session.history` 第一页、`session.list` 与 Session Summary 返回同一 Snapshot；
- History 分页不重新按当前页面统计，防止切页后数字变小；
- Ephemeral Runtime 走同一个 Projector，禁止维护另一套算法。

### 5.4 Provider 能力与未知值

- Provider 报告 Cache Usage：按真实值归一化；
- Provider 只报告总 Prompt Token：只能按已知字段拆分，禁止猜 Cache Hit；
- Provider 不报告 Usage：单次 Usage 和相关吞吐样本缺失，UI 隐藏对应指标；
- llama.cpp 等返回专有 `timings` 时，可原样保存在 Debug Trace/Provider Metadata，不能作为
  `sessionStats` 的唯一来源。

## 六、实施顺序

### M1：恢复单条消息指标（P0）

1. 实现统一 Web Usage Mapper。
2. 修复 Durable `assistant/chunk` 和 `assistant/message` 的 camelCase。
3. 保持读取旧 snake_case Session 的兼容性。
4. 增加 Live、History、Restart 三路径字节级等价测试。

### M2：恢复全 Session Token 与 Cache（P0）

1. 实现 `tokenUsage` 纯投影。
2. 正确处理同一步 Usage Chunk/Final Message 替换，禁止双计数。
3. 接入 Snapshot、Mux 增量 Frame、History 和 Session List。
4. 验证前端出现输入/输出 Token 与缓存命中率。

### M3：恢复 TTFT 与吞吐（P0）

1. 实现 `sessionStats` 纯投影。
2. 覆盖 Text、Reasoning、Tool-call 首 Delta。
3. 覆盖 Retry、Cancel、Failed、Limit Reached 和未完成 Tool Call。
4. 验证前端显示平均 TTFT、Token/s、LLM/Tool Duration。

### M4：真实端点与性能验证（P1，已完成）

1. 用本机 Web + V100 27B 真实流跑一轮纯文本和一轮工具调用。
2. 对照 Session Event 手工复算 TTFT 与 Token/s，误差不得超过事件毫秒精度。
3. 重启 Host、刷新页面、翻 History，数值必须保持一致。
4. Provider 未报告 Cache 时验证指标为 0/隐藏；报告 Cached Tokens 的 Fixture 必须显示正确百分比。
5. 测量万级 Event 的重建时间和每事件增量开销；如需要再增加版本化 Projection Checkpoint。

2026-08-27 验证结果：本机 3082 Host 使用 GitHub 原生 Apple Silicon Runner 生成的 ARM64
Release，在双 V100 的 Qwen3.8-27B 真实端点完成新 Session 纯文本流。结果为 TTFT 4481 ms、
Decode 207 ms/36 Token（约 173.9 Token/s）、总 LLM 4688 ms，Usage 为 1572 Input/36 Output；
单次 Usage 只含 camelCase。随后强制重启 LaunchAgent，重启前后 Projection JSON 字节级相等。
既有真实工具 Session 从完整日志恢复为 9 Steps、121984 ms Tool、36989 Cache Read Token，证明
工具耗时、Cache 与长历史重建路径同时生效。GitHub Linux/macOS ARM64 CI 和 WZU_Server 全
Workspace Fmt、Check、Test、Clippy `-D warnings` 全部通过。

### M5：可观测性扩展（P2）

1. 增加 TPOT、Provider Attempt、Retry Delay 和 Cancel Reason 的结构化指标。
2. 接 OpenTelemetry Adapter 和 Diagnostic Bundle。
3. 增加 Debug Trace Rotation/Retention。
4. Provider/GPU 专有 Timings 进入独立命名空间，不污染 Web 兼容字段。

## 七、测试矩阵

- Usage：无 Usage、完整 Usage、缺 Cache 字段、Cache Read/Write、Reasoning、超大整数；
- 去重：Chunk 后 Message 相同、Message 更新 Chunk、不同 Step 连续累计；
- Timing：首 Text、首 Reasoning、首 Tool-call、空 Delta、Retry 后首 Token；
- Lifecycle：正常、工具多步、取消、失败、Step Limit、未匹配 Tool Result；
- Projection：Live Frame、History 首屏、分页、Compact Replace、Fork、Host Restart；
- 兼容：旧 snake_case Session 输入、camelCase Web 输出；
- 性能：长 Session 重建、实时高频 Chunk，但只有 Projection 变化时推送。

所有 Rust Check/Test/Clippy 必须按仓库策略同步到 `WZU_Server` 执行；本机只允许
`cargo fmt`。真实 V100 端点测试不能把 API Key 或 Provider 原始敏感 Body 写入普通日志。

## 八、完成标准

同时满足以下条件才可以标记完成：

1. 当前 Web Dist 无修改即可显示 TTFT、Token/s、Token 总量和 Cache Hit；
2. Usage 的 Live 与 History 字段全部为 camelCase；
3. `tokenUsage`、`sessionStats` 在刷新和重启前后逐字相同；
4. 同一步 Usage 不重复计数；
5. 缺失 Provider Usage 时不伪造 Token/s；
6. V100 27B 真实冒烟测试和 WZU_Server 全 Workspace 门禁通过。
