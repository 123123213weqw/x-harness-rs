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

端点派生规则：

- Chat Completions：`<base>/chat/completions`
- Responses：`<base>/responses`

## 请求映射

每轮模型请求携带当前完整消息投影，以及所有已注册工具定义（name、description、JSON
Schema）。工具 Schema 必须放进协议原生 `tools` 字段，禁止插入 User/System 文本。

Chat 使用 Assistant `tool_calls` 和 `role=tool` 结果。Responses 使用 `store=false`、
无状态完整重放、原生 Function Call/Output Item，并保留 Reasoning 端点重放所需的 Opaque
Provider Item。

## 流归一化

SSE Parser 必须处理任意字节切分、被拆开的 UTF-8 字符、CRLF、注释、多行 `data:`、
Chat `[DONE]` 和 Responses 生命周期事件。无分隔符 Pending Bytes 与单个聚合 Event
必须分别设置上限。

归一化输出只能是 Text Delta、Reasoning Delta、Tool-call Delta、强类型 Completion 或
Provider Error。Usage 桶必须互不重叠：未缓存输入、可见输出、缓存读取、缓存写入、思考。

## 错误契约

- 网络错误、HTTP 408/429/5xx 标记为可重试，交给 Core 策略处理。
- 其他 HTTP 4xx 立即失败。
- 错误 Body 按配置预算增量读取，禁止先完整分配。
- 协议截断/Incomplete 必须转成强类型 Finish Reason，不能伪装成功。
- 流结束但没有合法生命周期 Completion 属于错误。

## 当前限制

- 每个 Adapter 实例只绑定一个 Provider/Model。
- Provider 路由和按用途选模型属于后续 LLM Registry。
- 在 namespaced Journal ID 能无歧义重放前，Responses 的 Execution ID 与 Provider 原生
  Call ID 仍需显式稳定映射。
- Tool Schema/Prompt 缓存依赖具体 Provider，本层不控制。

## 验收标准

协议 Fixture 必须覆盖单字节 Unicode 分片、多行 SSE、多工具调用、思考分离、生命周期
完成、Incomplete/Length/Filter 原因、Usage 归一化、超大 SSE/错误 Body、请求 Body 和
原生 HTTP Streaming。真实 Chat 集成必须在 OpenAI-compatible 端点完成两 Step 工具 Loop。
