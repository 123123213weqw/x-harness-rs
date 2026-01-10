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

