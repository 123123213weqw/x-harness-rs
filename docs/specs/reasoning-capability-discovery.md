# 推理能力发现、配置与恢复

状态：源代码实现；不会自动替换已安装的软件。

## 分层

1. Provider 能力层获取原生档位与请求映射；不把所有模型强制归入 low/medium/high。
2. Host 将来源、有效档位和默认档位投影到 `session.models`。
3. UI 使用同一目录生成选择项；用户选择仍存于原会话模型选择中。
4. OpenAI-compatible 适配器根据已验证的 request patch 构造请求。UI 不接触请求 patch。

能力与请求中返回的 reasoning 正文是两件事：本文实现前者，不通过是否返回思考文字判断能否调节强度。

## 解析顺序

显式模型配置（包括 `reasoning: null`）→ 配置的能力接口/其上次有效缓存 → 精确官方 endpoint+模型+协议的内置能力表 → unknown。

`null` 表示禁用该模型的自定义强度控制与自动补全，并非强制模型停止思考。要关闭思考，选择厂商支持的 off 档及其真实请求映射。

未知不等于不支持；只有明确档位才能发送对应字段。第三方代理不因为模型名相似就继承官方字段。能力获取不消耗生成请求，也不猜测探测 URL。

## 配置能力接口

Provider 下可选 `reasoningDiscovery`：

```json
{
  "url": "https://gateway.example/capabilities",
  "modelsPointer": "/data",
  "idPointer": "/id",
  "effortsPointer": "/supported_efforts",
  "defaultEffortPointer": "/default_effort",
  "requestTemplate": {"reasoning": {"effort": "$effort"}},
  "ttlSeconds": 3600
}
```

例：服务端 `data` 数组包含 `{"id":"model-a","supported_efforts":["brief","deep"],"default_effort":"brief"}`，生成两档原生映射。只替换值恰好等于 `$effort` 的字符串，不替换字段名。

另一种接口直接返回完整 profile：不设置 effortsPointer/requestTemplate，默认读取各模型 `/reasoning`，形如：

```json
{"default_effort":"deep","efforts":[{"id":"deep","name":"深入","request_patch":{"thinking":{"level":7}}}]}
```

`profilePointer` 可修改。JSON pointer 相对每个模型对象，modelsPointer 相对整个响应。没有统一的通用 reasoning 元数据标准，普通 `/models` 只返回 ID 时不会凭空发现档位。

## 获取、失败与缓存

- 配置生效/恢复时按 TTL 获取；菜单“刷新模型能力”通过 `session.models(refreshCapabilities=true)` 强制刷新。
- GET、同源、禁止重定向；凭据只发给相同 origin，不发送聊天内容。
- 单次获取最多 5 秒；一次配置准备的发现总预算 10 秒。
- 响应 2 MiB、512 个模型、单个 profile 32 KiB；拒绝空档位、重复 ID、非法默认值、覆盖保留请求字段等映射。
- 超时、错误、部分无效数据保留上次有效能力并标记 stale；无缓存则 unknown。
- 缓存与用户配置分离，文件 `reasoning-capabilities.json`；身份包含 endpoint、协议、发现配置和凭据摘要，最多 128 条/2 MiB，不保存 API key 原文。
- 用户编辑 models 数组时，只为同 provider、endpoint、协议、模型及 upstream ID 补回缺失能力字段；明确 null、删除模型、切换 endpoint 不继承。

## UI 和边界

复用现有二级模型菜单；显示能力来源/未知/上次有效能力和刷新入口。Web 与桌面共用生成资源，仍需重新构建/发布客户端才能让已安装软件生效。

刷新不修改用户选择，不暗中替换失效档位；模型选择仍由现有路由校验处理。未知模型不展示虚构强度列表。

## 验收

- 任意原生档位/嵌套字段映射与保留字段拒绝。
- 真实本地 HTTP fixture 的 TTL、强制刷新、503、缓存重启、凭据与协议隔离。
- Host RPC 从 brief 更新到 deep，再遇到失败保留 deep。
- 编辑配置/重启恢复不丢档位；明确禁用和模型切换。
- 实际打包 JS 的 schema、刷新 flag、重复补丁、菜单保存/刷新/切换/键盘/错误恢复。

## 后续（不宣称已支持）

原生 Anthropic 等非 OpenAI-compatible 传输、连续数值预算编辑器、更多经过验证的厂商能力端点适配、跨平台发布后实机验证。当前只提供显式接口配置与现有兼容传输的动态档位映射，不进行付费生成探测。
