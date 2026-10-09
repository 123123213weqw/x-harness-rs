# llama.cpp / vLLM 本地推理控制

## 接入范围

复用现有 OpenAI Chat Completions provider、设置 RPC、会话档位选择和 request patch。
不修改 Agent loop，不按引擎或模型名称猜能力；不修改运行中的模型服务。
普通 `/models` 只有模型 ID 时，不能据此知道思考开关或原生强度。

## 模型设置

在提供方的模型展开区域选择「思考配置方案」，再点「应用方案」，最后保存提供方。
仅选择方案不会修改模型；应用只替换该模型的 reasoning 配置，保留上下文、图片能力、
upstream ID 和其他自定义字段。已有自定义配置默认保持不变，取消编辑不会保存。
只对 `openai-completions` 展示这些方案，其他协议仍走原有配置。

| 方案 | 会话选项 | 实际请求字段 | 适用条件 |
| --- | --- | --- | --- |
| enable_thinking 模板开关 | off / on | `chat_template_kwargs.enable_thinking` 布尔值 | llama.cpp / vLLM 的实际聊天模板支持该参数，例如兼容的 Qwen3 模板 |
| thinking 模板开关 | off / on | `chat_template_kwargs.thinking` 布尔值 | vLLM 中采用此参数的模板，例如 DeepSeek V3.1 |
| 原生强度 | low / medium / high | `reasoning_effort` 字符串 | 模型及部署模板明确支持这些档位，例如兼容的 gpt-oss 部署 |
| 禁用自定义控制 | 无 | `reasoning: null`，不添加推理字段 | 只隐藏自定义档位，不强制模型停止思考 |

开关不是强度；不同服务的 token 预算也不是原生强度，不能一律伪装成 low/medium/high。
服务接受请求字段，不等于模板确实执行了它；部署验收要检查实际生成行为。
如模板的默认行为或档位不同，使用现有显式 reasoning 配置，而不是套用此方案。
本轮没有添加数值推理预算编辑器或自动探测生成请求。

## 文件配置

仓库 `config/providers.local-reasoning.example.json` 给出上述映射及本地 endpoint 示例。
它不是已安装模型目录：只保留实际部署的模型，替换 `upstream_model`、地址及容量限制，
调整 default 指向保留的模型。示例没有凭据，不会自动导入或修改用户配置。
使用原有 providers.json 导入/启动配置路径即可，Host 仍投影同一 reasoning 目录。

## 流式输出

Chat Completions 按 `reasoning_content`、`reasoning` 顺序读取首个非空字符串。
旧字段为 null、空串或非字符串时，回退到新版字段；两者都有内容时不拼接、不重复计数。
正文、工具、usage 处理不变。是否返回 reasoning 正文与是否支持调节强度分别处理。

## 回归验收

- TS：配置方案与 JSON 示例一致，未知方案/协议不改配置，无 any/类型断言。
- 浏览器：显式应用、只读、删除重排、协议切换、字段保留，以及原有提供方保存/失败重试。
- Rust HTTP fixture：每个默认值和档位的真实请求字段、消息和工具保留，流式别名回退。
- Host：示例导入、设置 RPC、会话选择及重启恢复。
- HTTP fixture 不是实际模型能力验收；没有部署的 vLLM 不宣称已经实机验证。

## 服务端参考

- [llama.cpp server 文档](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)：模板参数、reasoning_effort 和 reasoning 格式。
- [vLLM reasoning outputs](https://docs.vllm.ai/en/stable/features/reasoning_outputs/)：各模型模板开关及 reasoning 输出字段。

服务端版本、模型模板与解析器配置均可能改变，具体字段以部署版本文档为准。
