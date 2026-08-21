# 上下文预算与压缩规范

**所属层：** `xharness-context`、未来的 `xharness-token` / `xharness-prompt`
**状态：** 第一阶段已实现独立 Surface 抽象；预算、裁剪和压缩策略仍是 P0。

## 已落地的抽象边界

`xharness-context` 已从 Core 中独立出来，定义：

- `ContextRequest`：完整消息、Provider/Model、Step 和全部工具 Schema。
- `ContextPolicy`：从不可变来源投影一次性的模型可见 Surface。
- `ContextSurface`：模型可见消息、源消息数量、Policy 名称/版本和 Surface Edit。
- `SurfaceEdit`：用半开源区间记录 Tool Result Prune、历史压缩或自定义替换。
- `IdentityContextPolicy`：兼容策略，逐字完整重放。

Core 在任何 Provider I/O 前调用 Policy、验证 Surface 结构，并把 Policy、源/可见消息数量及
Edit 写入 `request/header.options.context`。LoopResult 和 Session 原始历史不因 Surface 替换而
改变。当前抽象只建立正确的替换边界，尚未宣称具备 Token 窗口安全。

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

本地 OpenAI-compatible 端点如果能提供同模型 Tokenizer，应优先做精确计量；否则采用保守估计。
估计不确定性不能通过减少安全余量来掩盖。超过预算必须在 Provider 网络 I/O 前返回结构化
`context_budget_exceeded`，并携带各分项，禁止把上游 HTTP 400 当成正常控制流。

## 工具结果治理

工具原始结果先持久化，再生成独立的模型可见版本。默认规则必须确定、可测试：

1. 小结果逐字保留。
2. 大文本按 UTF-8 边界保留头部、关键片段和尾部，并报告原始字节数与截断原因。
3. 超大结果写入内容寻址 Spill/Attachment，历史只保留引用、摘要和可复读范围。
4. 相同 Tool Call 的压缩结果必须稳定；禁止依据进程随机状态改变内容。
5. Tool Call/Result 配对和 Provider 原生 Call ID 不得因压缩断裂。

旧工具结果可以通过 Surface Replace 从后续请求中缩短，但审计、导出和崩溃恢复必须仍能看到
原始事件。摘要失败时应回退到确定性截断，而不是继续发送超预算请求。

## 文件读取策略

面向模型的 `read` 必须支持显式 `offset`/`limit` 或 `start_line`/`end_line`，并返回下一页
游标。默认不能一次返回 256 KiB/2,000 行。模型需要完整文件时，应分段读取并只保留与任务
相关的片段；Binary/Image 走 Attachment，不得内联进普通文本历史。

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

该样本必须成为固定回归 Fixture：在 53,248 总窗口、至少 8,192 输出预留下，Core 必须在
网络请求前分页/压缩或明确失败，绝不能再次发送 64,196-token 请求。

## 当前实现差距

- Host 仍安装 `IdentityContextPolicy`，原样返回全部消息。
- Host 没有安装 Token Meter、Context Policy 或输出预留。
- Core 的单个模型可见工具结果上限仍为 256 KiB。
- `read` 模型 Schema 目前只有 `path`，虽然底层 FS 已支持字节/行上限。
- 每个 Step 固定发送全部 14 个工具 Schema。
- Request Header 尚未记录完整预算分项。

## 验收标准

测试必须覆盖精确/估算 Tokenizer、模板和工具开销、未知窗口、预留输出、单个与多个大工具结果、
Unicode 截断、Surface Replace 后的 Tool 配对、摘要失败回退、动态工具子集，以及上述
64,196/53,248 回归样本。任何超过预算的请求都必须证明 Provider 尝试次数为零。
