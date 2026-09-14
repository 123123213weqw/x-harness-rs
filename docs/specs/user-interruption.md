# 用户主动中断的模型上下文标记

日期：2026-09-14。

## 目的

让模型知道上一轮是用户主动停止，而不是从残缺输出猜测。只记录真实控制事件；
不改变任务优先级、不要求恢复旧工作、不改 Compact、不增加工具或审批。

## 链路

`session.cancel` → `LoopCommand::InterruptByUser` → Durable Agent → Core。
内部关闭、父任务取消、普通 `Cancel`、消费者退出继续使用原取消路径。
普通 `Steer` 只转向模型，不产生“用户停止上一轮”标记。

Core 只有接受显式用户停止并以 Cancelled 结束时，才写入
`turn/end.reason.kind = user_interrupted`。UI 仍投影为 cancelled，Goal 按原用户取消语义处理。
不在停止按钮点击时直接追加普通用户消息。

Session 的模型消息投影遇到这个结束事件，先归并工具结果，再生成一条 user-role 上下文标记：

```text
<turn_aborted>
The user intentionally interrupted the previous turn. Some operations may have partially executed, and background tasks may still be running.
</turn_aborted>
```

该标记属于运行时事实，不是用户新发言，不改变系统指令。位置在上一轮结果之后、
下一条用户消息之前。实时结果和历史恢复复用同一个生成函数，ID 为 turn-aborted-{turn}。
不额外持久化第二份普通用户消息，因此每次 derive/reload 不会增加副本。
非 Journal 的嵌入式 Loop 使用 run ID 生成标记 ID，避免多次中断共用 ID。
工具批次被打断且尚未提交完整结果时，在结束事件前复用 outcome_unknown_recovery
补齐缺失结果；没有可靠结果就记录未知，不伪造成功，避免中断标记拆开工具调用/结果。

## 边界

- 完成后/空闲时重复停止不添加标记；无法接受的终态竞态不伪造成功中断。
- 网络错误、模型超时、步数限制、进程恢复的 Interrupted 和内部 Cancelled 都不注入。
- 命令可能部分执行、后台 Job 可能仍运行；不宣称回滚或清理成功。
- 保持原工具结果配对和实际取消流程，不增加执行版本系统。
- 旧日志未记录取消来源，不能安全反推用户意图，不回填标记。
- 新增 reason 枚举是持久格式扩展：读取新版日志需新版后端，旧版回退可能无法识别。
- 中断结束事件落盘失败时按原 journal 错误路径处理，不宣称已持久化；崩溃发生在
  结束事件提交之前，恢复只报告未知中断，不猜测来源。

## 验证

Core：显式停止、普通取消、网络失败、Steering，跨轮请求顺序与无重复标记。
Session：日志序列化/恢复后模型消息一致。
Durable Agent：命令透传、流释放、空闲重复停止无副本。
不把提示接线测试称为真实模型的服从性验证。

## 实测发现的日志并发边界

自动标题的 `session/title` 和 `xharness/title-generation` 都是 Host 元数据，
允许在活跃 Loop 期间更新日志版本；两者均不进入模型消息。Core 冲突重载白名单
必须同时接纳标题及其 Pending / Retry / Completed / Exhausted 状态，
不能只允许标题文本而拒绝生成状态；其他未授权的模型历史写入仍然拒绝。
