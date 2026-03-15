# 输入 Usage 归一化（Issue #58）

## 语义

内部 `TokenUsage` 的 input/cache_read/cache_write 为互斥桶；总输入为三者之和。Anthropic 缓存文档明确其 `input_tokens` 不包含缓存读取/写入：https://platform.claude.com/docs/en/build-with-claude/prompt-caching 。本功能只兼容 OpenAI 协议网关返回的该形状 usage，不新增 Anthropic Messages 协议支持。

- 标准 OpenAI 总量包含缓存：扣除读写缓存得到普通输入。
- Anthropic 分项：普通输入保留，缓存读取来自 cache_read_input_tokens，写入来自 cache_creation_input_tokens；3+2000+1000=3003，不能再次扣减。
- aggregate cache_creation 与其 5m/1h 明细不重复相加。
- 输出/reasoning 归一化保持不变。

## 可覆盖的网关规则

Provider 部署文件字段 `usage_input_semantics`；可编辑 Provider 设置字段 `usageInputSemantics`。可选值：

- `auto`（默认）：具有有效 input_tokens 和至少一个有效 Anthropic 缓存字段，且没有标准 OpenAI/DeepSeek 输入标记时，按非缓存输入解释；存在 prompt_tokens、input/prompt_tokens_details 或标准缓存别名时，保留总量语义和标准字段优先级。
- `total_includes_cache`：显式声明 input/prompt 为总量；标准缓存字段优先，缺失时可使用 Anthropic 缓存别名。
- `uncached_input`：显式声明 input_tokens 是普通输入；Anthropic 缓存字段优先，缺失时使用标准别名。

Auto 是已知形状的兼容规则，不可能识别任意网关改变后的真实语义。例如网关把 input_tokens 改成总量却只保留 Anthropic 字段，必须配置 total_includes_cache；混合字段却采用分项语义时必须配置 uncached_input。未知配置值拒绝，不静默降级。字段别名只取一个，不相加；有效 0 保留其优先级。

## 作用范围

归一化后的 Completed usage 同时进入 Host 统计和 Provider 校准。校准是当前 Provider 实例内存数据，新进程或设置重新激活创建新实例并重置，不迁移旧的错误样本。已经打开的流按创建时配置完成，不在流中改变口径。

旧对话 usage 已归一化并持久化，没有足够原始字段可靠逆推；不自动改写旧记录。新统计不会追溯修正旧累计总数。未增加网络请求，不改 Token Guard、上下文裁剪或工具结果。

## 验收

两种协议通过真实 SSE parser 的单字节分片，覆盖原始 Anthropic、只读/只写缓存、零值/缺失/无效字段、标准 OpenAI/Responses/DeepSeek、混合别名、显式覆盖及嵌套明细不双计。真实本地 HTTP mock 覆盖生产 Provider 与 Host 设置到 Adapter 的接线；不冒充真实 Anthropic 付费端点验收。

### 2026-09-12 远程结果

WZU_Server：Provider 协议 22 项、Host App 单元 25 项、模型设置 7 项、Host 单元 101 项，共 155 项通过；Clippy `-D warnings` 通过。矩阵包含 14 种输入形状 × 两种协议；Provider 与 Host 配置使用真实本地 HTTP mock。旧解析函数返回 `[0,0,1000]`，新增测试失败；修复版返回 `[3,2000,1000]`，同一测试通过。没有执行本机 Rust 编译。
