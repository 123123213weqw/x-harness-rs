# OpenAI-compatible Provider 规范

**Crate：** `xharness-provider-openai`
**状态：** 已实现流式 Chat Completions 与 Responses。

## 目标

把两种显式 OpenAI-compatible 线协议适配成 Provider-neutral 的 `ModelProvider` 流。
协议必须由配置选择，禁止启发式自动回退。

## 配置

`OpenAiProviderConfig` 包含协议、Base URL、API Key、模型、连接/请求 Deadline、SSE
Pending/Event 字节预算和错误 Body 预算。流预算为零的配置必须在网络 I/O 前失败。
Debug 输出必须隐藏 API Key。

Provider Config 可选配置一个结构化 Capability Probe（URL、部署 Context Window JSON Pointer、
TTL），并可额外配置模型 Ceiling、Provider Limit、Account Limit 三个 JSON Pointer。Adapter
从同一份带版本响应中读取各条独立 Evidence，按模型 Ceiling 与所有实际运行约束的交集计算有效
硬上限；模型 Ceiling 单独存在时不能证明该 API 部署真的能接收这么长的请求。Probe 只描述
“去哪里读”，不在 Core 中硬编码 DeepSeek 1M、llama.cpp `n_ctx` 等模型容量。

Adapter 保存每条 Evidence 的来源、ETag、抓取时间和过期时间。若端点不提供能力，可配置显式
`context_window_fallback`；它必须以 `deployment_declared_fallback` 来源返回，不能伪装成 Provider
报告，且只在没有可用运行约束时生效。Adapter 禁止根据一次普通 400 错误猜窗口后自动重发。

端点派生规则：

- Chat Completions：`<base>/chat/completions`
- Responses：`<base>/responses`
- Chat 输入计数：`<base>/chat/completions/input_tokens`
- Responses 输入计数：`<base>/responses/input_tokens`
- Capability：不假设 OpenAI 统一路径，由部署配置显式 URL 与 JSON Pointer；llama.cpp 可把必填
  部署 Pointer 指向 `/props` 的 `/default_generation_settings/n_ctx`。若 Provider 的版本化能力
  响应还公开模型、Provider 或账号约束，再配置对应可选 Pointer；未公开就保持未知，不猜测。

输入计数请求从实际生成请求体派生，只移除流式和输出控制字段，确保 System、消息、Opaque Replay
Item 与 Tool Schema 不会和正式请求漂移。404/405/501 表示端点不支持并缓存 Capability Miss；
其他网络/HTTP/解析错误必须显式失败，禁止伪装成“不支持”后降低精度。

## 请求映射

每轮模型请求携带当前完整消息投影，以及所有已注册工具定义（name、description、JSON
Schema）。工具 Schema 必须放进协议原生 `tools` 字段，禁止插入 User/System 文本。

“当前完整消息投影”只是 v0 行为。正式调用方必须在进入 Adapter 前完成 Prompt 组装、工具
子集选择和整体 Token Guard。Adapter 应接收已经冻结的 Prepared Call，并保留其预算诊断，
但不负责擅自删除历史。

Chat 使用 Assistant `tool_calls` 和 `role=tool` 结果。Responses 使用 `store=false`、
无状态完整重放、原生 Function Call/Output Item，并保留 Reasoning 端点重放所需的 Opaque
Provider Item。

Prepared Call 的 Provider-neutral `max_output_tokens` 在 Chat Completions 映射为 `max_tokens`，
在 Responses 映射为 `max_output_tokens`。该值是 Token Guard 在目标上限、最小输出保留、真实输入
和安全余量之间计算出的 `selected_output_tokens`，不是永远固定的路由常量。

## 流归一化

SSE Parser 必须处理任意字节切分、被拆开的 UTF-8 字符、CRLF、注释、多行 `data:`、
Chat `[DONE]` 和 Responses 生命周期事件。无分隔符 Pending Bytes 与单个聚合 Event
必须分别设置上限。

归一化输出只能是 Text Delta、Reasoning Delta、Tool-call Delta、强类型 Completion 或
Provider Error。Usage 桶必须互不重叠：未缓存输入、可见输出、缓存读取、缓存写入、思考。

## 错误契约

- 网络错误、HTTP 408/429/5xx 标记为可重试，交给 Core 策略处理。
- 其他 HTTP 4xx 立即失败。
- `exceed_context_size` 属于不可重试请求错误；正确实现应在网络前由 Context Policy 拦截。
- 错误 Body 按配置预算增量读取，禁止先完整分配。
- 协议截断/Incomplete 必须转成强类型 Finish Reason，不能伪装成功。
- 流结束但没有合法生命周期 Completion 属于错误。

## Tool Call 身份重放

Core 持久化的 `ToolCall.id` 是全 Session 唯一 Execution ID，`provider_call_id` 是线协议原生
身份。Chat Assistant `tool_calls[].id`、Chat Tool `tool_call_id`、Responses
`function_call.call_id` 和 `function_call_output.call_id` 必须成对使用 Provider ID；Approval、
Journal 与 Web Audit 继续使用 Execution ID。Responses 存在 Opaque Provider Item 时仍原样重放，
Tool Result 从对应持久 Tool Call 恢复 Provider ID。旧日志没有该字段时回退到 Execution ID。

## 当前限制

- 每个 Adapter 实例只绑定一个 Provider/Model。
- Host 层 [`ModelRegistry`](model-registry.md) 已能把多个 Adapter 实例绑定到不同公共路由；按
  Purpose 选模型仍未实现。
- Tool Schema/Prompt 缓存依赖具体 Provider，本层不控制。
- 统一 Capability 已覆盖 Context Window；最大输出、Tokenizer、工具和多模态能力仍待扩展。

## 验收标准

协议 Fixture 必须覆盖单字节 Unicode 分片、多行 SSE、多工具调用、思考分离、生命周期
完成、Incomplete/Length/Filter 原因、Usage 归一化、超大 SSE/错误 Body、请求 Body 和
原生 HTTP Streaming。真实 Chat 集成必须在 OpenAI-compatible 端点完成两 Step 工具 Loop。
上下文测试必须解析完整请求体，把 System、消息、工具和模板开销全部计量；服务端返回 Context
400 时断言 Adapter 不自动重试。Capability Fixture 必须覆盖多条约束取交集、结构化 Probe、
ETag/抓取时间、TTL 缓存、非法 Pointer fail-closed，以及显式 fallback 来源不会被标成 Provider
Reported。模型切换测试必须验证：未显式选择软窗口时重新采用目标模型的有效硬上限，同模型只切换
思考档位时保留当前软窗口，绝不能把上一模型的窗口继承给下一模型。
