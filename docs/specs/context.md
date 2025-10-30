# 上下文预算与压缩规范

**所属层：** `xharness-context`、`xharness-token`、`xharness-prompt`
**状态：** Surface 抽象和请求前硬预算已实现；分页、裁剪、精确 Tokenizer 与压缩仍待实现。

## 已落地的抽象边界

`xharness-context` 已从 Core 中独立出来，定义：

- `ContextRequest`：完整消息、Provider/Model、Step 和全部工具 Schema。
- `ContextPolicy`：从不可变来源投影一次性的模型可见 Surface。
- `ContextSurface`：模型可见消息、源消息数量、Policy 名称/版本和 Surface Edit。
- `SurfaceEdit`：用半开源区间记录 Tool Result Prune、历史压缩或自定义替换。
- `IdentityContextPolicy`：兼容策略，逐字完整重放。

Core 在任何 Provider I/O 前调用 Policy、验证 Surface 结构，并把 Policy、源/可见消息数量及
Edit 写入 `request/header.options.context`。随后 `xharness-token::TokenGuard` 对冻结 Surface 和
全部 Tool Schema 做硬准入；成功报告写入 `request/header.options.tokenBudget`。LoopResult 和
Session 原始历史不因 Surface 替换而改变。

正式 `xharness-host-app` 只要配置了模型，就必须通过 `XHARNESS_CONTEXT_WINDOW` 或
`--context-window` 显式给出部署真实窗口；未知窗口拒绝启动。嵌入式 Core 仍允许不安装 Guard，
用于测试或由宿主提供其他 Prepared-call 管线，这不属于生产 Host 的安全默认值。

## 目标

任何模型请求都必须在发起 HTTP 之前证明自己能够放进目标模型的上下文窗口。预算必须覆盖
System Prompt、消息历史、工具定义、Provider 模板开销和本轮最大输出，不能只统计
`message.content`。上下文压缩只改变“本次模型可见 Surface”，不得删除或改写 Session 原始
事件日志。

## 预算模型

一次 Prepared Call 至少记录下列值：

- `context_window_tokens`：模型或部署显式声明的总窗口；未知时禁止假装无限。
- `reserved_output_tokens`：为本轮输出和 Tool Call 参数保留的预算。
- `safety_margin_tokens`：覆盖模板/Tokenizer 偏差的安全余量。
- `estimated_input_tokens` 或权威 Tokenizer 得到的 `measured_input_tokens`。
- `tool_schema_tokens`、`system_tokens`、`message_tokens` 和 `provider_overhead_tokens`。
- `context_policy_version` 与发生过的 Surface Replace/Summary 标识。

硬约束：

```text
input_tokens + reserved_output_tokens + safety_margin_tokens
    <= context_window_tokens
```

`xharness-token::TokenMeter` 是统一抽象，不依赖 llama.cpp。当前
`ConservativeByteMeter` 按 Provider-neutral JSON 的 UTF-8 字节数并加入显式消息/工具/请求框架
开销；对普通 Byte-BPE 家族宁可过估。后续同模型 Tokenizer 可实现同一 Trait，替换 Meter 而不
改变 Core、Host 或 Context Policy。本地 OpenAI-compatible 端点如果能提供同模型 Tokenizer，
应优先做精确计量；否则采用保守估计。
估计不确定性不能通过减少安全余量来掩盖。超过预算必须在 Provider 网络 I/O 前返回结构化
`context_budget_exceeded`，并携带各分项，禁止把上游 HTTP 400 当成正常控制流。

## 工具结果治理

工具原始结果先持久化，再生成独立的模型可见版本。默认规则必须确定、可测试：

1. 小结果逐字保留。
2. 大文本按 UTF-8 边界保留头部、关键片段和尾部，并报告原始字节数与截断原因。
3. 超大结果写入内容寻址 Spill/Attachment，历史只保留引用、摘要和可复读范围。
4. 相同 Tool Call 的压缩结果必须稳定；禁止依据进程随机状态改变内容。
5. Tool Call/Result 配对和 Provider 原生 Call ID 不得因压缩断裂。

当前已实现单结果 `head_tail/v1`：在 Core 模型写回预算内保留 UTF-8 安全的头尾，并携带
原始/遗漏 Byte 数和 SHA-256；相同输入逐字稳定。它还不是完整 Spill/Surface 方案：持久
Session 当前保存模型可见版本，原始结果只存在于运行时 `ToolCompleted` 事件，进程重启后不能
通过内容引用重新分页读取。因此“大结果先持久化”的完整不变量仍待内容寻址 Spill Store 落地。

旧工具结果可以通过 Surface Replace 从后续请求中缩短，但审计、导出和崩溃恢复必须仍能看到
原始事件。摘要失败时应回退到确定性截断，而不是继续发送超预算请求。

## 文件读取策略

面向模型的 `read` 已支持 `offset`/`limit` 或 `start_line`/`line_limit`，并返回绑定 SHA-256
和原页限制的下一页 Cursor。默认 32 KiB/400 行，不再一次返回 256 KiB/2,000 行。模型需要
完整文件时，应分段读取并只保留与任务相关的片段；Binary/Image 走 Attachment，不得内联进
普通文本历史。

## 工具定义预算

工具 Schema 是模型请求的一部分。Host 应根据 Profile、平台可用性和当前 Step 投影稳定的工具
子集。后端探测确认某工具不可用后，下一 Step 应移除该工具或明确标记不可用；例如 Restricted
Process 不可用时移除 `bash/glob/grep/terminal_open`，但已有 Terminal 的管理工具按 Session
状态决定。禁止继续让模型反复调用同一个必失败能力。动态投影必须记录在 Request Header，
便于重放。

## 已知回归样本：2026-08-21

WZU_4080 的 llama-server 使用 `-c 53248`。一个 Web Turn 的原始消息约 62,181 tokens，
14 个工具定义及聊天模板再增加约 2,015 tokens，最终请求为 64,196 tokens，服务端以 HTTP
400 拒绝。主要来源是三个完整文件结果：约 20,115、26,953 和 6,848 tokens；最后一批
并行读取单次增加约 33,800 tokens。

该样本已成为固定回归：测试构造 64,196 输入估计和 53,248 可用输入预算，Core 在网络请求前
明确失败并断言 Provider Attempt 为零。自动分页/压缩尚未实现，因此当前行为是本地拒绝，而非
再次发送超窗请求。

## 当前实现差距

- Host 仍安装 `IdentityContextPolicy`，原样返回全部消息；超限时会拒绝，但不会自动腾出空间。
- 当前正式 Host 安装保守 Byte Meter；Provider-aware 精确 Tokenizer 尚未实现。
- Core 的单个模型可见工具结果上限仍为 256 KiB。
- `read` 已分页；其他工具结果仍缺统一 Spill/Reduce。
- 每个 Step 固定发送全部 14 个工具 Schema。
- 工具 Schema 和 System/Message/Protocol 分项已经记录；Provider 原生 Chat Template 的精确开销
  仍需要 Provider-aware Meter。

## 验收标准

测试必须覆盖精确/估算 Tokenizer、模板和工具开销、未知窗口、预留输出、单个与多个大工具结果、
Unicode 截断、Surface Replace 后的 Tool 配对、摘要失败回退、动态工具子集，以及上述
64,196/53,248 回归样本。任何超过预算的请求都必须证明 Provider 尝试次数为零。
