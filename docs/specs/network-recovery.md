# 模型网络恢复增强（2026-09-07）

## 范围与分层

仅增强模型生成请求：Provider 负责识别 HTTP/连接/响应体故障与结构化证据；
Core 负责是否重试、等待、终态和历史；Host 复用 Session 重试事件及既有前端倒计时。
不改全局网络，不关闭 TLS 校验，不增加无限重试，不重放工具副作用。
Token Count、Capability Probe、Web Fetch 是独立请求链路，不套用这里的次数。

## 默认参数（LoopConfig）

| 字段 | 默认 | 含义 |
|---|---:|---|
| provider_retries | 2 | 初次请求之外最多再请求两次 |
| provider_retry_base_delay_ms | 500 | 首次退避基数 |
| provider_retry_max_delay_ms | 8000 | 本地指数退避上限 |
| provider_retry_jitter_percent | 20 | 基于 Run/Step/Attempt 分散的 ±20% 抖动 |
| provider_retry_budget_ms | 60000 | 从首个可重试故障到再次产生输出的恢复期限；部分输出后的自动续接沿用同一期限 |

退避基数按 2 倍增长，抖动后限制本地上限，再与 Retry-After 取大值。
Retry-After 超过本地上限时不能截短；若无法在剩余期限中等完，立即报告恢复预算不足。
支持秒数与 HTTP-date，过去日期为零，非法值忽略，极大整数饱和处理，不溢出。
配置验证拒绝零基数/零期限、上限小于基数、超过一天的期限或本地上限、超过 100% 抖动。
不基于错误文字猜测平台档位，不修改 Provider 生成参数。

## 状态时序

1. 本步骤尚未提交非空正文/思考，也尚未提交工具参数碎片；故障可重试且次数尚有剩余。
2. 关闭旧响应并取消其请求 token。
3. Flush `llm/retry`（真实 delayMs、Retry-After、requestId、错误诊断）；UI 展示等待。
4. 等待同时处理取消、暂停和 Steering；取消/Steering 不发出虚假的 retry-started。
5. 等待完、仍在期限内且未取消，Flush `llm/retry-started`，再发起新请求。
6. 等待首响应/流心跳也受恢复期限约束；一旦提交模型输出，不再拿恢复期限截断正常长生成。

空正文/思考 Delta 不构成提交。工具参数碎片在每次尝试中先私有暂存；如果完成事件到达，
或后续出现非空正文/思考，按原顺序投影、落账并关闭该次请求的重试窗口。暂存上限为
256 KiB，达到上限就先提交碎片并关闭重试窗口，避免无界内存。未提交的碎片在网络故障、
取消或 Steering 时丢弃；即使 JSON 参数看似完整，收到 Provider 完成事件以前也不得执行工具。

暂停会阻止新请求，恢复时检查期限；暂停等待用户不等于正在自动重试。
重试 ID 在同一步稳定，attempt 递增；终态由既有 Session/Host 投影关闭等待状态。
默认仍不是“无损断点续传”，底层 API 未提供此保证。

## 部分输出后的有界自动续接

- 已提交输出后遇到明确的连接、超时或响应体传输故障，不重放原请求；在同一用户 Turn 内保存部分输出，退避后发起新的模型步骤，并附带不进入会话历史的续接说明。最多额外续接 `provider_retries` 次，连续故障共享 `provider_retry_budget_ms` 期限；成功的模型响应重置故障次数。续接是新的生成、可能额外计费，不是字节级无损恢复。
- 已有正文/思考保存为 `interrupted=true` 的 assistant/message，进入权威 Session 日志。
- 本轮未确认的 Tool Calls 与 opaque provider items 不写入可重放模型消息、不执行；已提交的碎片审计保留，未提交的尝试碎片丢弃。
- 只有已提交的工具参数、没有正文/思考时不插入空 assistant；续接模型可重新发出完整调用，但原碎片不执行。
- 复用 `llm/retry` 与 `llm/retry-started` 投影显示等待；等待阶段仍接受取消、暂停与 Steering。Steering 后按用户新指令继续，不再注入旧续接提示。
- HTTP 状态失败、协议失败、不可重试错误、次数或期限耗尽时仍失败；保留部分历史并明确提示用户可手动继续，而不是无限循环。
- 续接保留已完成工具的历史，不由框架重放工具执行。模型可在新步骤自行重新决定工具，
  这不等于框架替任意有副作用操作提供端到端 exactly-once 保证。
- 不创建第二套恢复调度器、会话队列或工具注册接口。

## 轻量诊断

ProviderError 携带 route（仅 scheme/host/port）、错误阶段、elapsedMs、receivedChunks、
receivedBytes、lastChunkAgoMs、protocolCompleted，以及受长度/字符约束的 requestId。
进入既有失败/重试持久事件；关闭完整 Debug Trace 时仍可排查。
不新增每块持久化事件，不把请求内容、工具参数、URL 密码/path/query 写入新增诊断元数据。
底层故障原文与有限长度 HTTP 错误体沿用已有策略；不要把新增元数据的脱敏范围误说成任意上游响应都无敏感内容。
诊断协议状态在失败路径为 false：Completed 一旦到达就停止读流，不再生成传输失败。

## 自动测试与边界

- Core：指数/抖动边界、溢出、Retry-After 超预算、等待取消、暂停/恢复、Steering。
- 权威 Session：网络短断时中断内容持久化、同一 Turn 自动续接；耗尽时仍可由用户新 Turn 恢复，确认无孤立工具调用。
- 真实 HTTP：429 秒数等待、Request ID、响应头/正文恢复期限、收包诊断、成功恢复后的长流不被恢复期限误杀。
- 真实 TLS：临时自签证书加入**测试客户端**信任库，Python TLS 服务器直接关闭 FD 不发送 close_notify。
  输出前原请求恢复、部分输出新步骤续接、协议完成后不误报；生产 Client 配置不变。
- 回归测试继续保护：已提交输出不重放原请求、完成事件优先、半截工具不执行、已完成工具不重复执行、
  用户取消/消费者退出、Unicode/SSE 网络分片。

TLS 夹具需要 Unix + Python 3 + OpenSSL/LibreSSL（测试使用独立证书配置），在远程 Linux 执行；
Windows 的 HTTP/Loop 测试保留，物理 Wi-Fi、运营商/代理变化、正式整包更新单独验收。
所有 Rust 编译、测试、Clippy 在 WZU_Server 或 GitHub CI，不在本机编译。
