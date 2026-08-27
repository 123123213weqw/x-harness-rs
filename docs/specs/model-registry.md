# LLM / Provider Registry 规范

**Crate：** `xharness-host`（Provider-neutral Registry 与路由）、`xharness-host-app`（配置和 Adapter 组合）  
**状态：** Provider/Model 多路由、Web 发现、每路由 Token Guard 和精确模型推理等级已实现；Purpose、其他能力发现和热重载计划中。

## 目标

同一个 Web Host 必须能够复用多个推理接口，而不复制 Loop、工具、Session 或 Web API。4080、
V100 和云端服务只要通过某个 `ModelProvider` Adapter 暴露流式模型事件，就进入同一条执行链。

```text
Web Session 选择 provider/model
             |
             v
       ModelRegistry.resolve
             |
       RegisteredModel
       |- Bound ModelProvider
       `- Route TokenGuard
             |
             v
    Durable Agent -> Core Loop
```

## 路由身份

- 公共路由由 `(provider, model)` 唯一标识；`reasoning_effort` 是调用控制，不参与 Registry Key。
- 公共路由 ID 与 Adapter 的线协议模型名必须分离。例如，公共路由
  `llama-v100/qwen` 可以把请求中的 `model` 编码为远端服务实际接受的
  `qwen3.5-9b-v100`。
- Registry 在注册时用公共路由身份包装 Adapter。`request/header`、Retry、Session 恢复和 Web
  Projection 必须记录公共身份；Adapter 内部仍使用自己的 Base URL、协议和上游模型名。
- 重复路由、空 ID、空展示名以及未注册的默认路由必须在 Host 启动阶段失败。

## 配置边界

`xharness-host-app` 支持 `XHARNESS_PROVIDERS_FILE` 或 `--providers-file` 指定 JSON 配置。每个
Provider 显式声明：

- 稳定 ID 与展示名；
- Adapter 类型；当前为 `openai-compatible`；
- Base URL 和 `chat` / `responses` 协议；
- 可选 `api_key_env` 凭据引用；配置文件禁止内联 Secret；
- 一个或多个公共模型 ID、可选上游模型名、真实 Context Window、输出预留和安全余量。

### 精确模型推理等级

推理强度不能由前端维护一套全局词表。每个模型可选声明 `reasoning`：

- `efforts` 是按 Adapter 首选顺序排列的 `{id,name,description?,request_patch}`；
- `default_effort` 可选，但存在时必须引用同一模型已声明的 ID；
- Browser 只接收 `id/name/description/defaultEffort`，不得看到 `request_patch`；
- `request_patch` 必须是 JSON Object，由 OpenAI-compatible Adapter 映射到该端点的原生字段；
- Patch 禁止覆盖模型、消息、工具、流、输出预算等 Core 所有字段；
- 空 ID/展示名、重复 ID、未知默认值、非 Object Patch 或保留字段覆盖均在 Host 启动时失败。

`reasoning_effort` 仍不参与 Registry Key，但 `can_route` 必须同时验证它属于目标模型。省略选择值
表示使用该模型 Adapter 默认；模型配置有 `default_effort` 时，新 Session 和模型切换会物化该值。
Loop/Core 只把 Opaque ID 传给 Adapter，不解释 `low/high/max`。Adapter 对正文请求和原生 Token
Count 请求应用同一映射，使计量请求与实际请求保持一致。

单接口环境变量和 CLI 参数继续作为兼容入口；未提供多路由文件时，它们构造只有一个条目的
Registry。协议禁止根据错误自动回退。

## Web 契约

- `llm.providers` 必须按 Registry 稳定顺序返回去重后的 Provider。
- `llm.models` 和 `session.models` 必须按 Provider 分组返回所有已注册模型。
- `llm.discoverModels` 返回已注册模型的公共 ID、展示名和 Provider ID。
- `session.selectModel` 必须在写 Session Event 之前调用 `can_route`；未注册路由返回
  `model-unavailable`，不得污染 Session 当前选择，也不得等到下一次 Prompt 才失败。
- 新 Session 使用配置中的默认路由。恢复 Session 使用日志中的 latest-wins
  `session/model-selected`；如果部署已移除该路由，Session 仍可浏览，但 Pending Turn 不得自动在
  其他模型上执行。

## 运行时边界

- 一个 `DurableLoopAgentRuntime` 持有一个 Registry、一个 Session Store 和一个 Agent
  Supervisor。禁止为每个 GPU 创建彼此竞争同一 Session Lease 的独立 Runtime。
- 每个模型请求使用 Turn 开始时解析出的绑定；模型选择不得在同一请求中途替换 Adapter。
- Token Guard 属于具体模型路由。不同机器的 Context Window、输出预留和安全余量不得共用一个
  全局默认值。
- Adapter 或 Token Guard 不进入 Session 快照；快照只保存稳定公共路由和实际 Request Header。

## 当前限制

- Registry 启动后不可热重载；修改配置需要重启 Host。
- 尚无按 `purpose`（主 Agent、标题、摘要、Subagent）选择模型。
- Capability 目前由 Host/Tool Readiness 管理，除 Reasoning 外尚未注册模型级 Tools、Vision、
  Tokenizer 和最大输出能力。
- 模型列表来自显式配置，不主动探测 `/v1/models`；这样可避免把偶然出现的服务当成稳定产品路由。

## 验收

1. 同一 Runtime 注册两个 Provider，连续两个 Turn 选择不同路由并得到对应 Adapter 的输出。
2. 两个 `request/header` 分别记录公共路由身份，而不是 Adapter 的上游模型名。
3. Web Provider/Model 目录包含全部路由且保持顺序。
4. 未注册模型选择在持久化和 Prompt Admission 之前失败。
5. 配置拒绝重复路由、未知 Adapter、缺失 Context Window、未注册默认路由和缺失的凭据环境变量。
6. 单接口环境变量启动方式保持兼容。
7. Web 只展示当前精确模型声明的推理等级；未知等级在 Session Event 持久化和 Provider I/O 前失败。
8. Adapter 将公共 Effort ID 映射为模型自己的请求 Fragment，且保留字段不可被覆盖。
