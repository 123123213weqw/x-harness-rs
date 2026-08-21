# 核心 Agent Loop 规范

**Crate：** `xharness-core`
**状态：** v0.1 已实现；`ToolSpec` 和快照存储仍是迁移到正式 Agent 层之前的兼容桥。

## 目标

`xharness-core` 执行一个有上限的 Agent Turn：归一化模型流、聚合工具调用、调度工具、
发送有序事件、接收运行时控制，并返回唯一终态 `LoopResult`。它必须与 Provider、UI、
操作系统无关。

## 公开契约

- `LoopEngine::start(LoopRequest) -> LoopRun` 必须立即返回。
- `LoopRun` 必须是 `LoopEvent` 的单消费者流。
- `LoopRun::send(LoopCommand)` 只有在 Runner 接受命令后才能确认；这是“已排队”回执，
  不是持久化回执。
- `LoopRun::cancel()` 必须协作式取消 Provider/Tool 工作。
- `LoopRun::result()` 必须最终且仅进入 `Completed`、`Failed`、`Cancelled`、
  `LimitReached` 之一。
- `LoopRequest::validate()` 必须在任何 Provider、Store、Policy 或 Tool I/O 前失败。

## Step 状态机

```text
从 Session 投影消息
  -> 组装 System Prompt 与本 Step 工具子集
  -> Context Policy 生成模型可见 Surface
  -> 计量 System/消息/工具/模板并预留输出
  -> 超预算则压缩或在本地失败
  -> 启动 Provider 流
  -> 发送 text/reasoning delta
  -> 按 index 聚合 tool-call 碎片
  -> 接收强类型 completion + usage
  -> 原子追加 assistant message
       | 无 call + Stop             -> Completed
       | 有 call + ToolCalls/legacy -> 审批 + 工具批次
       | finish 组合非法            -> Failed
  -> 按原顺序追加工具结果
  -> 下一 Step
```

显式 `Stop` 与工具调用同时出现时必须 fail closed。只有旧 Provider 缺失 finish reason 时，
才可以根据是否存在工具调用推断。`Length`、`ContentFilter`、`Incomplete` 和未知终止原因
禁止报告为完成答案。

## 流式输出与重试

- 文本和思考必须使用不同事件类型、不同消息字段。
- 首次请求失败后默认最多重试两次。
- 仅当本次尝试尚未发送任何模型 delta 时允许重试；输出一旦可见，禁止通过重试复制。
- Usage 必须按完成的 Step 保存，并使用饱和运算累计。
- 即使 Provider 发出空 ID、重复 ID 或跨 Step 复用 ID，内部 Tool Call ID 也必须唯一。
- Context/配置类 4xx 不得重试；请求前预算失败时 Provider Attempt 必须为零。

## 工具批次语义

- 未知工具、畸形/非 Object JSON、Handler 失败、超时和 Panic 必须转为工具结果，禁止
  使 Loop 崩溃。
- `Parallel` 可以并发；`Keyed` 对相同非空资源键串行；空键降级为 `Exclusive`；
  `Exclusive` 是全局屏障。
- 完成事件可以按真实完成顺序发送；写回模型的消息必须保持原始调用顺序。
- 需要审批的工具在收到显式允许命令前禁止启动。
- 取消/超时必须取消 Handler Token，并在 drop Handler Future 前提供有界清理时间。
- 模型可见工具结果默认上限 256 KiB；所有合法配置上限下都必须保持 UTF-8 和 JSON 有效。
- 256 KiB 只是单结果字节上限，不等于上下文安全。多结果、历史、System 与工具定义仍需由
  整体 Token Budget 约束。

## 运行时控制

支持消息注入、Steering、Pause、Resume、Cancel、Approve、Reject。`NextStep` 注入等待
下一个模型边界。Steering 中断当前模型流，把已有部分作为 interrupted assistant 历史
保留，然后继续。Steering 不会中断工具批次，而是推迟到批次边界。

## 持久化

`journal_store` 是权威 append-only 路径，快照 `SessionStore` 只用于 v0 迁移。Journal
模式下必须在对应生命周期边界记录 Request Header、Assistant Chunk/Message、Tool Call
和 Tool Result。已记录 Call 但没有 Result 时，恢复为 `outcome_unknown`，禁止自动重放。

## 默认限制与当前不足

- 默认最多 128 个模型 Step。
- 默认最多 8 个并发工具。
- 默认 `IdentityContextPolicy` 完整重放全部消息，没有 Summary 或 Surface Replace；正式 Host
  安装 Hard Token Guard，超限会本地失败，但不会自动腾出空间。
- 嵌入式 Core 允许宿主不安装 Token Guard；正式 Host 配置模型时缺少窗口会拒绝启动。
- 事件当前使用无界内部 Channel；按字节有界的 Event Journal/Subscription 已列入 TODO。
- `LoopRun` 表示一次 Run，不是带持久 Inbox 的长生命周期 Agent。
- Provider 自有 replay 状态当前仍以 JSON Value 暴露。

完整目标契约见[上下文预算与压缩规范](context.md)。Hard Guard 已封住已知超窗发送路径；在
分页、Reduce 和 Surface Replace 落地前，仍不能宣称长任务能自动连续完成。

## 验收标准

测试必须覆盖普通流、碎片/多工具调用、重试边界、全部 Finish Reason、Usage 累计、审批、
全部并发模式、取消、Steering、Pause/Resume、Step 上限、非法请求前置失败、中断恢复、
重复 Provider ID，以及不消费事件的宿主。
另必须固定重放 `64,196 tokens -> 53,248 context` 样本，断言网络请求前被拦截，并验证三路
并行大 Tool Result 不会绕过整体预算。
