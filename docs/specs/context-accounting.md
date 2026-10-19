# 请求级上下文计量与预算

## 目标与不变量

上下文占用是**一次请求的输入长度**，不是整段会话的累计计费 token，也不是日志文件大小。
请求前计数、请求完成后的 Provider usage、下一轮新增历史必须分开。不得用估算覆盖同一次请求的实际输入；不得把旧模型的实际 usage 配上新模型容量。

本次不缩减工具正文、不修改旧会话日志、不通过硬编码模型名称推测上下文上限。

## 分层

- `xharness-token`：预算约束、精度标记、可替换 Meter、纯数字校准器。
- `ModelProvider`：原生 `count_input_tokens`、无网络的 `estimate_input_tokens`、可选计数故障通知。
- OpenAI Adapter：基于与生成相同的 request body 编码计算特征；归一化 Chat / Responses usage；隔离端点、模型、工具 schema、推理参数和编码版本。
- Core：原生计数优先，失败策略、超时、输出预留与安全边界在统一 admission 中执行；Compact 后必须重新计量。
- Host：按 turn/step 与 request/header 重建占用投影；Web 和 Tauri 共享。
- UI：显示最近请求实际输入，未知时显示带 `≈` 的本次估算；请求详情保留两种读数、来源、输出预留和请求标识。

## 计数与降级

1. 可用的原生整请求计数优先，保留 `exact_request` / `exact_tokenizer` 精度。
2. 原生计数不支持，或可重试网络故障 / 超时，使用 Adapter 本地估算；没有 Adapter 实现时继续使用现有 Meter。显式通过 `TokenGuard::new` 注入的自定义 Meter 不被 Adapter 估算覆盖，只有 `conservative` 默认允许；也可用 `with_provider_estimate` 明确选择。Meter 可声明自身精度。
3. 默认计数阶段总截止时间 10 秒，可通过 `TokenGuard.with_counter_policy` 配置。瞬态失败使 Adapter 冷却 60 秒，避免每轮重复等待。`fallback_reason=transient_counter_failure` 写入预算报告和 Debug。
4. 401/403、坏响应等非重试错误不掩盖；严格模式可关闭瞬态降级。取消和暂停仍优先中断计数，不继续发生成请求。
5. 即使降级，也必须执行 `输入 + 最低输出保留 + 安全边界 <= 有效上下文容量`（期望输出预留可向下调节，实际选择的输出不能越过剩余容量）。估算不是精确保证；服务端拒绝仍走已有有界 overflow/Compact 恢复，不绕过预算。

## Local calibration

- Cold input uses complete encoded-request UTF-8 content and protocol framing; it never assumes a fixed bytes-per-token divisor.
- Features distinguish ordinary ASCII, structured/tool ASCII, non-ASCII, framing and independent image allowances.
- Pure-text and mixed-request observations occupy separate bounded caches: up to 64 scopes and 32 numeric samples per scope in each partition. Neither partition evicts observations from the other.
- Reuse requires at least eight same-scope samples, no older than seven days, within 2x request size and a text-distribution distance below 0.30. Scope identity still covers endpoint, model, tool schema and reasoning controls.
- Pure-text reuse takes the highest reported-input/feature-unit ratio, multiplies by 1.25 and adds 256 tokens. This remains a conservative estimate, not a statistical confidence interval or exact tokenizer.
- If pure-text reuse is unavailable for an image-containing request, comparable mixed completions may supply a separate upper envelope. It uses the **entire** reported input, including cache and images, as its numerator. Never subtract a guessed image cost. Add the current independent image/caption allowance in full, and never use mixed observations to discount a text-only request.
- Mixed requests remain `estimated`. Duplicate bodies cannot satisfy warmup more than once; a higher repeated mixed usage that violates a learned bound still invalidates it. Genuine provider context overflow clears both partitions for that scope.
- The Host persists only hashed identities and numeric features. Snapshot v2 preserves both partitions and reads valid v1 text caches. Downgrading to a v1-only binary safely discards this disposable cache and cold-starts; no conversations, settings or credentials are migrated or deleted. Corrupt/oversized snapshots remain non-fatal. The existing cache filename and 2 MiB cap are unchanged.
- No extra provider probe, model call, transcript edit or compaction-threshold relaxation is introduced.

## 无损工具编码

仅处理已识别的 Harness 外层 ToolResult：`ok` / `truncated` 必须是布尔值，内层 content 必须是包含 `exit_code`、`job_id` 或 `bytes_read` 的 JSON 对象。
将内层 JSON 字符串恢复为对象，避免双重转义。stdout/stderr、退出码、诊断字段和未知字段全部保留。其他文本/未知格式原样发送，日志持久化仍保存原始结果。
生成、原生计数和本地特征共用此映射；Chat 和 Responses 保持等价。

## 事件与显示生命周期

- `request/header.options.measurement`：requestId、turn、step、source、phase；计量时间使用外层日志事件时间。
- `step/start`：清除上一请求实际/估算，进入 preparing。
- `request/header`：记录本次估算/精度，进入 in_flight；不会沿用上轮实际输入。
- 同 turn/step 的 usage：更新实际输入（非缓存 + 缓存读 + 缓存写）；重复消息替换、不累加。迟到的旧 step usage 不覆盖当前占用。
- `tool/result` / `user/message` / Compact：标记 history_changed。保留的 usage 只代表“最近请求”，不是下一请求的预测。
- 切换模型：立即清除读数与旧容量，等待新请求；切换后迟到旧 usage 不恢复旧读数。
- 流失败且无 usage：保留本轮估算，不伪造实际值。
- 原有 `pressureTokens` / `projectedTokens` / `contextWindow` 兼容保留，附加 measurement/phase/accuracy。
- 前端历史 inspector 使用一次有序遍历关联 usage，不对每个请求反复扫描全部历史。

## 回归与交付

覆盖校准预热、漂移、重复、超范围外推、多模态隔离、配置指纹、计数超时/鉴权/严格模式、模型切换、历史回放、迟到 usage、实际/估算优先级、无损工具映射及浏览器重建。

验证记录见 [2026-09-09 验证报告](../reports/context-accounting-20260909.md)。本机禁止 Rust 编译，全部同步 WZU_Server 执行；跨平台构建由 GitHub CI 验证。

软件安装更新是独立交付步骤：源码测试通过不等于已运行的软件自动生效。

## #59：每个读数独立标记精度（2026-09-12）

| 字段 | 含义 | 精度字段 |
|---|---|---|
| `pressureTokens` | 最近请求实际输入，非缓存 + 缓存读 + 缓存写 | `pressureAccuracy=provider_reported` |
| `projectedTokens` | 请求前计数；不是实时变化后的下一轮预测 | `projectedAccuracy` 保持原计量器的精度 |

旧的 `accuracy` 为兼容旧客户端仍保留，描述当前优先显示的读数；新客户端不能
用这个字段替代两个独立精度字段。收到 usage 不能把 estimated/calibrated 升格为精确值。
`projectedAccuracy` 缺失时可读取旧 `accuracy`，但只有 `exact_request` / `exact_tokenizer`
能把请求前读数标为精确；旧 `provider_reported` 不会把估算值升级为实测。

圆环优先显示实际输入，否则显示请求前计数。estimated/calibrated 显示 `≈`；
缺少有效容量或读数时不显示百分比，0 是有效值，百分比上限 100%。
工具结果、用户新消息或 Compact 到来后标记“历史已变化”；即使随后收到同轮迟到 usage，
也不宣称它是变化后历史的大小。下一轮 step/start 清空旧读数，新请求重新计量。
Host 实时增量 fold 和前端历史 replay 使用同样的精度/生命周期约定。

## #57：超限诊断字段（2026-09-12）

`TokenBudgetError::Exceeded.reserved_output_tokens` 必须报告配置期望输出预留，
不能错误填入 `minimum_output_tokens`。报错同时展示 `output_reserve`、`minimum_output`
和 `safety_margin`，本地计量和 Provider 计数两条分支一致。

**预算算法未变**：硬准入仍使用 `context - minimum_output - safety_margin`；
通过后实际选择的输出长度随剩余空间调节，不能把期望预留误当成始终固定的硬扣除。
测试覆盖预留 512 / 最低输出 64 的不同值、准入边界 928 可用 / 929 拒绝。


## Display attribution v2 (2026-10-17)

The context total still comes from request admission or normalized provider usage.
The display-only composition now records `attributionVersion: 2` and separates
`userTokens` (verified human-origin admissions), `agentReportTokens`,
`runtimeContextTokens`, `checkpointTokens`, and `unattributedTokens`. Category
shares remain estimates; matching their sum to the total does not establish
independent tokenizer accuracy. No model request, budget, or durable message is
rewritten by this display calculation.

Classification follows recorded inbox source metadata at consumption time.
Both direct sources and the Host RPC metadata wrapper are supported. Checkpoints
follow explicit `surface_replace` events, not text markers or ID prefixes.
Working-set history references and transient continuation/control notices are
runtime context. Provenance is mapped through each actual projection before
composite audit edits replace the mapping. Missing, ambiguous, or unrecognized
provenance is never silently claimed as human authorship.

Existing recorded compositions without version 2 remain readable but show
**User-role history (source unknown)** rather than **Your messages**. New requests
can classify retained old messages where durable source metadata exists. The
original logs and old estimated buckets are not retroactively rewritten. Live
and history-replayed projections carry the same small numeric composition;
provider-reported totals, stale-history indicators, and estimate labels remain
independent and unchanged.

Working-plan snapshots inserted into a prepared request are runtime context.
Their insertion updates the attribution vector at the same exact index, so
the following genuine human message retains its durable authorship category.
This does not change the snapshot bytes, request ordering, or admission budget.

## Mixed text/image admission (2026-10-18)

Reading a screenshot must not switch the entire retained text history from a
warm calibrated estimate to byte counting. The request estimate is:

```text
compatible text estimate + independent conservative image allowance
```

- Text reuse still requires eight unexpired, same-scope, text-only samples within
  the existing size/distribution bounds. A mixed query with cold or incompatible
  text can now use the separate mixed upper envelope described above; until
  that partition warms up it retains the byte fallback. The 1.25 multiplier and 256-token reserve are unchanged.
- A mixed request remains `estimated`, not `calibrated` or exact: its image price
  is not measured. Exact provider counters still take priority.
- Mixed usage cannot identify the text price. Do not subtract an estimated image
  allowance from reported total usage to manufacture a text observation.
- If complete mixed usage exceeds the reused-text-plus-image estimate, invalidate
  that scope and persist the invalidation. Normal mixed completions neither train
  nor evict the text-only observations. They may train the separate mixed
  partition. Snapshot v2 reads legacy v1 text observations, while mixed totals
  are never accepted as persisted text samples.
- Caption blocks not yet expanded by the wire encoder are reserved separately at
  conservative UTF-8 byte cost plus framing; text calibration cannot erase them.
- Hard input/output/safety budgets, compaction thresholds, image pixel allowance policy,
  prompt content, attachment encoding, and the running user's state are unchanged.

Regression coverage includes first/repeated/removed images, cold starts, distribution
drift, scope isolation, saturation and genuine overflow, underestimated mixed usage,
cache-inclusive HTTP usage through Chat Completions and Responses, and restart.
The numeric-only first-image fixture holds the recorded pre-image text fixed to
isolate the accounting transition; it is not a new live model or game-quality test.
