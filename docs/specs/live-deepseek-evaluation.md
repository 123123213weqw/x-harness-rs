# DeepSeek Flash 真实 Coding 验收闭环

**涉及层：** Host、Core Loop、Provider、Tool、Session、Debug、Web Projection  
**状态：** 流程已冻结；第一轮 Bash Tool View 回归已完成，真实 Flash Coding Run 待部署后执行。

## 目标

单元测试只能证明局部契约。发布候选还必须让真实 DeepSeek Flash 在 XHarness 内完成可重复的编程
任务，由 Harness 外部验收结果，并把运行中暴露的性能差距和 Bug 变成永久回归。模型的“自称完成”
不算验收通过。

## 五级门禁

1. **确定性回归**：Fmt、Workspace Check/Test、Clippy `-D warnings`；Tool View、Context、Compact、
   Cancel、History/Restart 和权限 Corner Case 必须先用 Fake Provider 固定。
2. **Debug 接口回归**：开启 Full Debug Trace，在临时 Session 执行最小 Tool Loop；校验 Provider
   Request/SSE、Tool Arguments/Result、Session Event、Web Mux、Usage 和错误链完整，且凭据被脱敏。
3. **真实协议冒烟**：调用当前配置的 DeepSeek Flash，完成“读一个文件 → Bash → 返回结论”的最小
   多 Step Loop；不允许人工改写模型 Tool Call。
4. **真实编程任务**：在一次性 Git Workspace 中完成固定任务。任务必须包含读代码、修改至少两个
   文件、执行测试、处理一个预设失败并给出最终摘要；禁止访问生产 Workspace 和凭据。
5. **外部验收与迭代**：由独立脚本/人工检查 Git Diff、测试、约束和副作用；失败先归类、最小复现、
   新增回归，再修改 Runtime/Projection/Prompt，重新从第 1 级开始。

## 第一组固定任务

- **T1 Bash 卡片**：模型调用成功、非零退出、stderr、长输出截断各一次；Live 与刷新后的 History
  都必须可展开，command/cwd/output/exit status 一致。
- **T2 小型 Rust 修复**：给隔离 Fixture 增加一个带错误输入的纯函数及测试；模型必须先读现有 API，
  修改实现和测试，然后调用远端可用的验证命令。XHarness 本仓库仍遵守“Rust 只在 WZU_Server 编译”。
- **T3 恢复**：在 Tool Call 后重启 Host，恢复后不能重复 Side Effect，History 与 View 不变。
- **T4 长上下文**：注入多个大 Tool Result，验证请求前预算、Compact `no_progress` 熔断和事实账本，
  不得出现无限 Read/Grep/Compact 循环。

## 指标与通过阈值

每轮保存 Provider/模型版本、Harness Commit、配置 Hash、任务 Seed 和 Debug Trace ID，并报告：

- TTFT、Decode Token/s、端到端 Wall Time、Provider/Tool/Compact 时间；
- Input/Output/Reasoning/Cache Read/Write Token；
- Tool Call 数、成功/失败/重试率、重复调用和无进展 Step；
- 原始 SSE Delta、下行 Frame、Session JSONL/Debug Blob Byte；
- Context 估算与 Provider Usage 偏差；
- 测试结果、Diff 合规率、重复 Side Effect 数。

正确性硬门槛为：外部测试全过、无越界写/网络、无重复 Side Effect、无丢消息、无未解释错误。性能
比较必须在相同任务、模型、上下文、推理档位和轮换顺序下进行；单轮体感不能宣称优化。候选相对基线
若 TTFT 或端到端 P50 回退超过 10%，或 Tool 失败率上升，必须阻断默认发布并定位。

## 失败分类

- `provider`：HTTP/SSE/能力或限流；
- `model`：生成坏参数、错误工具选择、重复探索；
- `runtime`：调度、取消、状态机、Side Effect、Context/Compact；
- `tool`：参数验证、进程、文件、沙箱、结果结构；
- `projection`：Live/History/View/刷新不一致；
- `performance`：TTFT、吞吐、事件放大、日志/内存增长。

每个 Issue 必须附最小 Session/Trace 证据、预期与实际、根因层、回归测试和修复 Commit。Debug Trace
只用于诊断，API Key、Authorization、Cookie、密码和生产文件内容禁止进入证据仓库。

