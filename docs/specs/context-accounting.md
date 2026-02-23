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
5. 即使降级，也必须执行 `输入 + 输出预留 + 安全边界 <= 有效上下文容量`。估算不是精确保证；服务端拒绝仍走已有有界 overflow/Compact 恢复，不绕过预算。

## 本地校准

- 首次使用按完整编码请求的 UTF-8 内容与协议结构保守计量，不固定除以 4。
- 特征分为普通 ASCII、工具/结构化 ASCII、非 ASCII、协议开销和图片预算。
- 每个配置作用域最多保存 32 个数字样本，最多 64 个作用域；不保存提示词和密钥，不落盘。重启或新 Provider 实例冷启动。
- 当前请求与样本大小相差不超过 2 倍，字符/结构分布距离小于 0.30，至少 8 个相似样本才校准。
- 校准取相似样本中最大实际 token/特征单位比率，再乘 1.25，加 256 token。结果标记 `calibrated`，**不是统计置信区间，也不是精确 tokenizer**。
- 重复请求指纹不重复学习。发现实际值突破估算，立即清除该作用域；服务端 context overflow 清空当前 Adapter 校准。
- 图片请求不参与文本校准，沿用独立图片估算；新分布、新工具 schema、新模型/端点/推理配置重新预热。不会把文本压缩比套用到图片。
- 请求前估算和响应后的观察分别扫描完整请求；无额外远程模型摘要调用。

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
