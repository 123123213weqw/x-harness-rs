# 模型请求断网持续恢复（2026-10-01）

## 目标与职责

暂时断网不是用户任务失败：运行中的 Loop 保留上下文、等待再连接，用户仍可停止、暂停、Steer。
Provider 提供结构化失败证据；Core 的独立 `retry` 策略模块选择有限重试或持续网络等待；Runner 负责取消令牌、睡眠与控制通道；Host/UI 复用现有持久 `llm/retry` / `llm/retry-started`，不复制状态机。
不依赖外部前端源码，不同步上游。

## 默认行为

- `network_wait_enabled=true`；只有 `retryable=true`、无 HTTP 状态、有已知传输诊断的错误进入持续等待。
- 支持 `connection/connect_or_headers/idle_timeout/response_body/body/transport`。没有结构化证据的普通错误不能靠文字猜测断网。
- 等待不被原 `provider_retries=2` / `provider_retry_budget_ms=60000` 截断；采用 500ms 起指数退避、±20% 抖动，上限 `network_wait_max_delay_ms=30000`。
- 退避指数属于运行级连接失败序列，跨越部分输出续接及新的模型步骤；收到 delta、暂停/恢复、NextStep 排队消息都不重置。完整模型响应或已接受的 Steer / InterruptModel 才重置。journal 的 attempt 仍按每个 retryId 单独递增，不拿全局退避序号充当持久尝试编号。
- 429/408/5xx 保持原有次数及期限；Retry-After 不可截短。401/403/参数/协议错误不进入持续等待。
- Provider 从 typed error cause 识别无效证书、证书缺失、TLS 不兼容、明确的永久 peer Alert（协议版本、证书/鉴权、协商配置拒绝）及请求构建错误；显式检查 io::Error 内层，避免 source() 跳过 rustls 叶子错误。不靠本地化字符串判断、不禁 TLS 验证。InternalError、CloseNotify、UserCanceled、未知 Alert / EOF 不被一概判成永久故障。
- 各网络尝试仍有 Provider 请求头与流闲置超时；持续恢复不设置健康生成的总时间限制。
- 关闭 `network_wait_enabled` 可以显式回到原有有界策略。

## 副作用边界

1. 无可见输出的失败，关闭旧响应、丢弃私有工具参数前缀，使用同一请求再尝试。
2. 有已提交输出的传输失败，将部分正文/思考持久化；残缺工具调用丢弃，不执行；新模型步骤附加既有临时续接说明。
3. 续接不是字节断点续传，可能产生额外计费。已完成的工具结果不重复执行。显式步骤/累计输出预算仍生效。
4. 等待与新请求期间复用控制通道。取消/Steer 不发出虚假 retry-started；暂停时不发请求。

## 协议与 UI

- 网络等待：`llm/retry.mode=always`，省略 `maxRetries`，policyKey=`xharness:network-wait`。
- 有限重试：`mode=normal`、有效 maxRetries。
- 网络/有限、请求重试/部分输出续接分别有独立 retryId；避免同一个 journal owner 变更或 attempt 不连续。
- Core ModelRetry 的 max_retries 变为 Option；None 不伪装成极大数字。Host 明确映射到已有协议。
- UI 显示“连接中断，等待恢复”、下一次请求倒计时；started/取消/正常轮结束仍遵守已有生命周期。
- 每次调度在请求前 flush 至 journal；可恢复历史展示，但不声称 OS 进程退出后连接能无损恢复。

## 本次验收与后续

回归覆盖：跨越短预算/次数仍恢复；退避上限；HTTP/网络混合链；多次部分输出及碎片不执行；跨步骤退避、完整响应/Steer 重置及 Pause/NextStep 不重置；暂停/取消/Steer；持久日志完整 restore 校验；真实 HTTP Chat/Responses 断连与闲置超时；TLS 永久失败分类（含 io 包装）及真实 Chat/Responses TLS ProtocolVersion 拒绝只请求一次；UI 模式、倒计时和关闭状态。

仍待单独实施：跨平台网络变化通知提前唤醒、UI 总等待时间；重启后未完成普通任务的自动恢复（现有 Host 未对一般进行中轮提供全量自动续接，本次不能以“有 journal”代替这个能力）；请求 token-count 等旁路网络故障恢复。

## 验收记录

- V100 源码同步路径：`~/codex-build/x-harness-rs-network-wait/`；同步排除 .git、target、node_modules、环境/密钥/Cookie 文件。
- `cargo test --locked -p xharness-core -p xharness-provider-openai -p xharness-host --all-targets`：413 项通过、5 项既有测试忽略。
- 同范围 `cargo clippy --locked ... --all-targets -- -D warnings` 通过；完整输出返回本机 `/tmp/xharness-pr186-fix-regression.log`。
- Node：network-wait-ui、namespace/hash、retry-turn、atomic-history、live-answer、assistant、scroll-follow 通过；WebKit 历史缓存 32 项检查通过。
- 未调用真实付费模型；真实网络测试是本地故障 HTTP/TLS fixture，不是修改用户系统网络的实验。未发布、替换或重启用户软件。
