# Context History Pruning P0 消融证据

**日期：** 2026-09-02  
**实现：** `context-history-pruning/v2`  
**编译与测试主机：** `WZU_Server`（Linux，Release 优化构建）

## 问题

历史 Assistant Tool Call 会把已经成功写入磁盘的完整 `write.content`、`edit.old/new` 和旧 Turn
reasoning 在每个后续模型 Step 重新发送。Tool Result Pruner 只能治理 `role=tool` 的结果，不能
处理这些更大的 Assistant 字段。

## A/B Fixture

正式 Rust 集成测试：

```text
crates/xharness-context/tests/multi_tool_ablation.rs
```

构造 32 个已经成功闭合的 `write` Tool Call：

- 每个文件参数 16 KiB；
- 每个 Assistant reasoning 2 KiB；
- 同时保留 provider-neutral Tool Call 和 Responses `function_call`；
- 每个调用具有匹配的 `ok=true` Tool Result；
- 最后追加一个新的 User Message，使前 32 个 Turn 成为已完成历史。

比较 `IdentityContextPolicy` 与 `ToolResultPruningContextPolicy`，每个 Policy 重复准备 100 次。

## Release 结果

远程命令：

```bash
cargo test -p xharness-context --test multi_tool_ablation --release -- --nocapture
```

结果：

| 指标 | Identity | P0 Projection | 变化 |
|---|---:|---:|---:|
| Provider-neutral 消息 JSON | 1,136,998 Byte | 42,150 Byte | **-96.29%** |
| 保守输入估算 | 1,138,088 | 43,240 | **-96.20%** |
| 100 次 Prepare | 15.893 ms | 363.913 ms | +348.020 ms |
| 单次 Prepare | 0.159 ms | 3.639 ms | **+3.480 ms** |

结论：P0 并不会让纯 ContextPolicy CPU 更快，因为它需要解析 JSON、计算 SHA-256 并构造一次性
Surface；但 32 次大型 Tool Call 下额外 CPU 只有约 3.5 ms，而送入 Token Count、网络和模型
Prefill 的消息体减少约 1.095 MiB。Tool Call 越多，绝对节省近似线性增长，因此端到端路径预期
更快；真实 Provider TTFT/Prefill 仍需独立 A/B，不能用本实验直接宣称。

## 当前真实会话重放估算

对 `session-1788306871730-694` 最后一个 Request Header 的 40 条 `input` 执行同规则的只读参考
投影，不修改 Session：

| 指标 | 原始 | 投影后 | 变化 |
|---|---:|---:|---:|
| 消息 JSON | 90,363 Byte | 35,699 Byte | **-60.49%** |
| 成功大型文件调用 | 3 | 3 | 拓扑不变 |
| 移除旧 reasoning | 12,244 字符 | — | — |
| 移除 Tool Argument | 34,916 字符 | — | — |
| 参考投影耗时 | — | median 0.233 ms / p95 0.682 ms | Python 参考实现 |

该数字只说明当前会话形态的请求体收益；正式 Rust 结果以上述 Release Fixture 为准。

## 稳定性门禁

已经验证：

- 32 个 Tool Call 和 32 个 Tool Result 数量、顺序、Provider Call ID 全部保持；
- 连续两次投影逐字相同；
- 投影后的历史参数仍是合法 JSON；
- 失败、未完成、坏 JSON 和小参数不会被投影；
- 当前 User Turn reasoning 保留；旧 Turn plaintext reasoning 清空；
- Responses 已知 `function_call.arguments` 与 Chat Tool Call 同步；opaque reasoning item 保留；
- Chat/Responses 线协议都保留同一 `call_id → function_call_output` 拓扑；
- 原始 Session Message 不修改。

远程门禁：

```text
cargo test --workspace                                           PASS
cargo check --workspace --all-targets                            PASS
cargo clippy --workspace --all-targets -- -D warnings            PASS
cargo test -p xharness-context --all-targets -- --nocapture      PASS
cargo test -p xharness-provider-openai --test protocol ...       PASS
```

## 未完成的真实性能结论

`REL-05` 继续负责真实 Provider A/B，至少记录：

- 相同模型、相同最终 User Prompt、交替执行顺序和多个 Seed；
- Provider 原生 Input Token Count；
- TTFT、Prefill、总请求时间、Cache Read/Write；
- Tool 选择正确率、Call/Result 续接成功率和最终任务完成率；
- 1/4/8/16/32 个 Tool Call 的扩展曲线。

只有该矩阵通过后，才能确认远端模型端到端速度和质量收益；当前 P0 已确认的是请求体显著缩小、
投影确定且协议拓扑稳定。
