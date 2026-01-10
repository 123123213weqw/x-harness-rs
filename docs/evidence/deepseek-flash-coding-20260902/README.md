# DeepSeek Flash 真实 Coding Run（2026-09-02）

## 环境

- Harness：当前工作树（Bash Tool View 修复后、提交前）
- 编译/执行：`WZU_Server`，Rust 测试二进制
- Provider：DeepSeek Official OpenAI-compatible Chat Completions
- Model：`deepseek-v4-flash`
- 测试：`live_deepseek_flash_repairs_code_and_emits_complete_debug_evidence`
- Debug：Full Trace；API Key 通过 SSH stdin 注入，未写入仓库，Trace 脱敏检查通过

## 真实任务与外部验收

隔离 Workspace 内预置错误的 Python `clamp()` 和不可修改验收测试。模型必须读实现/测试、修复实现、
执行 `python3 test_math_utils.py`，最后由测试进程独立再次运行验收，不能信任模型自报。

实际链路：

```text
read(math_utils.py) ─┐
                     ├─ parallel success
read(test_math_utils.py) ─┘
edit(math_utils.py) -> success
bash(python3 test_math_utils.py) -> exit 0, coding-task-ok
external Command validation -> exit 0
```

- Tool Call：4；成功 4，失败/重试 0；两个 Read 同 Step 并发。
- 模型未修改验收测试；最终实现通过独立运行。
- Full Debug 含 `core/provider.openai/tools/process`，原始 API Key 不存在于 Trace。
- Trace 位置仅作远端诊断：
  `/home/wzu/codex-run/xharness-deepseek-live-debug/trace-1788325503718295-3221335-0/`

## 指标

| 指标 | 结果 |
|---|---:|
| 端到端 Debug Event Wall | 4,310.59 ms |
| Provider Steps | 4 |
| TTFT | 663.27 / 469.55 / 684.73 / 289.48 ms |
| TTFT 平均 | 526.76 ms |
| Output Token | 353 |
| Reasoning Token | 44 |
| Uncached Input Token | 970 |
| Cache Read Token | 7,680 |
| Cache Read 占 Input+Cache Read | 88.79% |
| 加权近似 Decode | 173.18 token/s |
| Tool Wall | Read 6/10 ms、Edit 9 ms、Bash 69 ms |
| 原始 SSE Chunk | 94 |
| Provider Normalized Stream Event | 267 |
| Core Loop Event | 276 |
| Full Debug Event / JSONL | 689 / 370,647 Byte |

逐 Step 数据见 [`summary.json`](summary.json)。Decode 是从首个 normalized delta 到 completed 的
近似值，不等同 Provider 服务端原生 TPOT。

## 第一轮迭代发现

1. 第一次真实任务本身已经完成，但验收脚本错误地搜索带反斜杠的 JSON 字段，误报“缺少 core
   evidence”。直接统计 Trace 得到 `core=286`，定位为测试断言 Bug；修正后相同任务再次运行通过。
2. 4 个模型 Step 产生 94 个网络 Chunk、267 个 normalized Stream Event 和 276 个 Core Event。
   Full Debug 保留每个碎片是预期行为，但普通 Live/Session/Web 路径不得按此粒度永久放大；两级
   Delta Coalescer 和 Tool Arguments 最终结构投影继续由 `P2-02/REL-05` 验收。
3. 本轮不含 Debug-off 对照，因此不能把 4.31 秒当作正常模式性能基线，也不能据此宣称 Debug 无
   开销。下一轮需固定同一任务和模型做轮换 A/B。

## 第二轮：Tool Arguments 持久流合并

针对第一轮发现的碎片放大，Core 在不改变直接嵌入 API 实时语义的前提下，对同一 Turn/Step、同一
Tool Index 且 ID/Name 兼容的相邻 `ToolCallDelta` 做 Durable Checkpoint 内合并。空 ID/Name 与重复
ID/Name 都兼容；冲突的非空身份 Fail-closed 为两条记录，不能静默篡改调用身份。确定性测试同时覆盖
正常碎片、重复身份、冲突身份和最终 JSON 重建。

重新执行同一个 DeepSeek Flash Coding 验收，结果仍通过：

- 4 个 Tool Call 全部成功，外部 Python 验收再次通过；
- Model-facing 实时 `ToolCallDelta` 保持 **110** 条，Direct Embed 的流式进度没有被降级；
- Durable Tool Argument Chunk 从 110 条降至 **5** 条，减少 **95.45%**；两个并行 Read 的碎片交错，
  因而安全结果是 5 条而不是强行压成 4 条；
- Wall 3,717.63 ms，平均 TTFT 347.73 ms，加权近似 Decode 178.18 token/s；
- Full Debug 仍保存 750 条/431,482 Byte 原始跨层证据，这是 Debug 完整性的预期行为，不是普通 Web
  下行量。完整数据见 [`coalesced-summary.json`](coalesced-summary.json)。

第二轮 Wall 比第一轮低约 13.75%，但两次模型正文 Token、网络响应和 Cache 组成不同，**不能**把该
差值归因为 Coalescer。可以严格归因的是同一轮的 110 → 5 Durable Chunk；后续 Debug-off/Full 轮换
A/B 继续由 `REL-05` 完成。
