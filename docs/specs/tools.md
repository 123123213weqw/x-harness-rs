# 工具注册与执行管线规范

**Crate：** `xharness-tools`
**状态：** 正式工具运行时已实现；Core Adapter 仍是临时兼容桥。

## Registry 契约

`ToolRegistry` 以唯一非空名称持有不可变 `ToolSpec`。注册时必须验证 Input/Output Schema
都是 JSON Object，并原子拒绝重复名称。`definitions()` 必须为模型请求返回确定性列表。

Spec 包含模型可见定义、Handler、Timeout、Concurrency Mode、Approval Requirement 和
可选 Resource-key Resolver。未声明并发的工具默认 `Exclusive`；并行必须显式开启。

Registry 中存在工具不等于每次模型请求都必须发送它。Host/Prompt 层根据 Profile 与
Capability 产生本 Step 的 Definition Projection；投影保持名称/Schema 稳定，并参与整体 Token
预算。工具 Description 属于协议原生 Tool Definition，不是 System Prompt。

## 执行管线

每次 `ToolExecutor::execute` 都绑定一个 `execution_id`：Agent/Core 已经把 Tool Call 持久落账时，
调用方必须传入该 Durable ID；独立嵌入且没有上层 Journal 时，Executor 才生成进程内唯一 ID。
同一个值必须原样进入 Middleware、Approval、Handler、Observer 和最终 Result。执行顺序如下：

```text
查找 -> 解析 JSON Object -> Schema 校验
  -> pre middleware
  -> 单调 guard
  -> fail-closed 审批
  -> 并发 gate -> host lifecycle started ack
  -> around middleware -> handler
  -> post middleware -> finalize middleware
  -> observer
```

所有失败都必须成为值（`ToolResult`/`ToolFailure`），不能变成未控制的 Loop Panic。
Handler 和 Middleware Panic 必须在各自信任边界捕获。

## Policy 语义

Guard 状态单调：后续阶段可以把 `allow` 收紧为 `ask` 或 `deny`，禁止放宽已经存在的
限制。Approval 缺失、出错、Panic、超时或取消时必须 fail closed。Finalizer 禁止把拒绝
或执行失败改成成功。

默认审批 Deadline 为 5 分钟，零 Deadline 非法。审批必须按 Execution ID 关联，不能只
使用 Provider Call ID。

## 并发与取消

- `Parallel`：工具层不串行。
- `Keyed`：相同资源键串行，不同键可以重叠。
- `Exclusive`：等待所有活跃 Call，然后独占执行。
- Keyed Resolver 得到空键时，按调用方契约安全失败或降级。
- Request Cancellation 必须传播到 Handler Token。
- Timeout/Cancel 后，在 Executor 返回失败前必须提供有界清理时间。

`ToolBatchRun` 是多调用唯一正式调度器。它按模型原始顺序解释 Barrier、按 Batch 配置限制总并发，
完成事件按真实完成顺序发布，最终结果按原始 `order` 返回。Core/Agent 不得复制这些调度规则。
Batch Handle 被 Cancel 或 Drop 时必须向全部 Call Token 广播取消；宿主仍应读取最终 Result，确认
Handler 清理完成后才能发布整个 Run 的终态。

`ToolLifecycle::started` 位于审批和并发准入之后、Handler 之前。宿主利用该 Awaitable Ack 持久化
和投影副作用开始边界；Error 或 Panic 必须阻止 Handler 执行，不能降级为仅观察型通知。

## 当前限制

- JSON Schema 只实现实用的首版子集，不覆盖完整生态。
- 持久 Tool Call 记账由 Session/Core 负责，不属于本 Crate。
- Core 到正式 Runtime 的迁移桥已经传递 Durable Execution ID，但 Core 仍重复执行一层
  Scheduling/Approval/Timeout；删除重复管线后才能淘汰兼容 `xharness-core::ToolSpec`。
- Result Spill-to-disk 和 Output Schema Enforcement 尚未实现。
- Host 已按 Platform/Search/Terminal Readiness 生成 Definition Projection；Profile/Step 级策略
  与投影审计仍待完整实现。

## 验收标准

测试必须覆盖重复/非法定义、畸形/Schema 非法参数、精确 Pipeline 顺序、单调 Guard、
Approval Unavailable/Denied/Pending/Cancelled、每个 Middleware Panic、Handler Timeout/
Panic、安全的默认 Exclusive、Keyed 重叠/串行、Batch 并发上限/Barrier/完成与重放顺序、
Lifecycle Ack fail closed，以及 Finalizer 禁止提权。
