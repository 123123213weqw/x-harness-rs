# 4080 Qwen Compaction 消融证据（2026-08-25）

## 环境

- GPU：RTX 4080 16 GiB
- 模型：Qwen3.8-27B，`Q3_K_M` GGUF
- 推理：llama.cpp CUDA，32,768 服务端窗口，MTP Draft，Q4 KV Cache
- Harness 逻辑窗口：16,384 Token
- 输出预留：768 Token
- 安全余量：256 Token
- 摘要输出上限：1,024 Token（保留默认阈值/比例，但为 16K 烟测收紧默认 8,192 上限）
- 驱动：`scripts/compaction-ablation.py`
- 任务：第一轮写入三个精确事实和 500 行填充；第二轮追加 200 行填充并要求逐字回忆三个事实。

## 四组配置

| 组 | 配置 | Compact 次数 | 精确事实命中 | 终态 |
|---|---|---:|---:|---|
| `disabled` | 完全不安装 Compaction Runtime | 0 | 3/3 | completed |
| `overflow_only` | `auto=false`，只允许硬超窗恢复 | 0 | 3/3 | completed |
| `auto_default` | 80% 触发，保留最近 16% | 1 | 3/3 | completed |
| `auto_aggressive` | 70% 触发，保留最近 8% | 1 | 3/3 | completed |

四组 Host 都正常结构化退出，没有 Forced Kill 或业务错误。完整机器可读结果见
[`summary.json`](summary.json)，输入形状见 [`task.json`](task.json)。远端原始 History、Debug Trace 和
Session JSONL 保存在：

```text
/home/wzu/codex-run/xharness-compaction-ablation/full-20260825-165510/
```

把互斥的 `input_tokens + cache_read_tokens + cache_write_tokens` 相加，第二个正常回答请求的完整
Prompt 从非 Auto 组的 13,734/13,954 Token 降到 Auto 组的 5,377/5,471 Token，约减少 61%。该数字
只描述 Compact 后的最终回答请求；摘要辅助请求本身的 Token 和耗时不能从这两行中扣除。

## 解释边界

这是一轮功能烟测，不是最终性能结论。四组顺序复用同一个 llama.cpp 进程，Prefix/KV Cache 热度和
模型采样长度不同，因此单次延迟、`cache_read_tokens` 和输出 Token 不能直接归因于 Compact 策略。
当前证据可以证明：真正的关闭组没有触发 Compact；两个 Auto 组各完成一次 Durable Surface Replace；
在该任务上压缩前后均保留了三个目标事实。正式质量/性能结论仍需多任务、多随机种子、轮换执行顺序，
并在每组之间重启或清空推理端 Prefix Cache。
