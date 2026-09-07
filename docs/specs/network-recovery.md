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
| provider_retry_budget_ms | 60000 | 从首个可重试故障到重新产生输出的恢复期限 |

退避基数按 2 倍增长，抖动后限制本地上限，再与 Retry-After 取大值。
Retry-After 超过本地上限时不能截短；若无法在剩余期限中等完，立即报告恢复预算不足。
支持秒数与 HTTP-date，过去日期为零，非法值忽略，极大整数饱和处理，不溢出。
配置验证拒绝零基数/零期限、上限小于基数、超过一天的期限或本地上限、超过 100% 抖动。
不基于错误文字猜测平台档位，不修改 Provider 生成参数。

## 状态时序

1. 本步骤尚未产生文本、思考或工具参数 Delta，且故障可重试、次数尚有剩余。
2. 关闭旧响应并取消其请求 token。
3. Flush `llm/retry`（真实 delayMs、Retry-After、requestId、错误诊断）；UI 展示等待。
4. 等待同时处理取消、暂停和 Steering；取消/Steering 不发出虚假的 retry-started。
5. 等待完、仍在期限内且未取消，Flush `llm/retry-started`，再发起新请求。
6. 等待首响应/流心跳也受恢复期限约束；收到任意模型 Delta 后，不再拿恢复期限截断正常长生成。

暂停会阻止新请求，恢复时检查期限；暂停等待用户不等于正在自动重试。
重试 ID 在同一步稳定，attempt 递增；终态由既有 Session/Host 投影关闭等待状态。
默认仍不是“无损断点续传”，底层 API 未提供此保证。

## 部分输出后的显式恢复

- 有 Delta 后遇到故障，不自动重试，不把两次生成逐字拼接。
- 已有正文/思考保存为 `interrupted=true` 的 assistant/message，进入权威 Session 日志。
- 本轮未确认的 Tool Calls 与 opaque provider items 不写入可重放模型消息、不执行；原始碎片审计仍保留。
- 只有工具参数、没有正文/思考时不插入空 assistant，但错误仍提示本轮中断。
- 前端显示中断与可能额外计费提示。用户通过原有输入框发送“继续”，形成新的 User Message / Turn。
- 新 Turn 恢复已落盘的上下文，不重复执行先前已完成的工具。模型可在新 Turn 自行重新决定工具，
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
- 权威 Session：中断内容持久化，并用同一会话新 Turn 恢复，确认无孤立工具调用。
- 真实 HTTP：429 秒数等待、Request ID、响应头/正文恢复期限、收包诊断、成功恢复后的长流不被恢复期限误杀。
- 真实 TLS：临时自签证书加入**测试客户端**信任库，Python TLS 服务器直接关闭 FD 不发送 close_notify。
  输出前恢复、部分输出不重试、协议完成后不误报；生产 Client 配置不变。
- 原有测试继续保护：任意 Delta 不重试、完成事件优先、半截工具不执行、已完成工具不重复执行、
  用户取消/消费者退出、Unicode/SSE 网络分片。

TLS 夹具需要 Unix + Python 3 + OpenSSL/LibreSSL（测试使用独立证书配置），在远程 Linux 执行；
Windows 的 HTTP/Loop 测试保留，物理 Wi-Fi、运营商/代理变化、正式整包更新单独验收。
所有 Rust 编译、测试、Clippy 在 WZU_Server 或 GitHub CI，不在本机编译。
