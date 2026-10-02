# 后台 Job 完成后续跑规范

后台 Job 的“生产过程”和 Agent 的“当前轮执行”分离。模型可以继续做独立工作，也可以注册完成回执、结束当前轮，让同一会话在 Job 结束后续跑。定时 Automation、子 Agent 和持久终端不因此换成新的执行器。

## 正式链路

```text
bash(run_in_background=true)
  → JobRegistry 管理生产者
job_output(action=defer, continuation=依赖步骤)
  → Session 追加 Registered 并 flush
  → 立即返回，模型结束当前轮或继续独立工作
JobLease.finish(completed / failed / killed)
  → Controller 保存有界终态快照，追加 Settled 并 flush
  → BasicHost 的原会话 Admission
  → 原 Durable Inbox（source.kind = job-settlement）
  → 原 Durable Agent / Loop / ToolExecutor
  → 追加 Delivered
```

NativeToolFactory 在创建工具执行器之前绑定 Controller；Host App 在配置、Hosted 执行许可就绪之后启动监听，在历史恢复完成之后恢复订阅。嵌入方显式启用同一接口，未绑定时不向模型广告不可用的 action。

## 工具接口

```json
{"job_id":"返回的完整不透明 ID","action":"defer","continuation":"成功后运行验证；失败则报告错误"}
```

- 注册不等待生产者。`Registered/Settled` 表示回执尚未确认投递；`Delivered` 表示已入队，不表示依赖步骤已经执行成功。
- 同一 Job、同一 continuation 重复注册幂等；不同 continuation 拒绝覆盖。
- `action=cancel_defer` 只取消尚未投递的订阅，不停止 Job。已入 Inbox 的回执返回 `already_delivered`，不会谎称可以撤回。
- 取消的订阅不自动重新启用；需要停止生产者时仍调用 `job_kill`。
- action 不能混用 `cursor/wait/timeout_ms`；`continuation` 只允许用于 defer。
- 原来的读输出与 `wait=true` 保持独立语义：短依赖可以有界等待，超时返回 running，而不是成功；不要 defer 后再无理由等待。

## 持久化与去重

- 中性端口位于 xharness-jobs；版本化事实位于 xharness-session；Host Controller 管理 outbox，Core 不依赖 Native 生产者。
- `job/continuation` 是控制面事实，不进入模型对话正文；原始历史不改写。
- 状态只能 `Registered → Settled → Delivered`，或 `Registered/Settled → Cancelled`。身份、note 和已存在的终态快照不可变。
- 每个 owner 最多 64 个未投递订阅，note 最多 2048 UTF-8 字节，单条持久记录最多 128 KiB。
- 回执 ID 由 owner 和 Job ID 生成。检查历史上的 Inbox 插入事实，而不是只检查当前队列：即使回执已经被 claim，重试也不会重复投递。
- Admission 已持久化而 Delivered 写入失败时，恢复只补确认，不重复执行回执。这是逻辑投递去重，不是所有外部副作用的 exactly-once 保证。
- 新 Registry 使用新的 UUID generation 加单调计数生成 Job ID，旧订阅不能绑定重启后的新进程。对话 fork 不继承后台生产者订阅。

## 停止和失败边界

- 会话正在运行：回执排入 next-turn，不启动第二个同会话模型轮。
- 用户停止：回执保留，但不自行解除 `dispatch_paused`。
- 最近一轮非正常结束且整个待处理队列没有新的用户输入：Job/子 Agent 完成回执不能单独触发续跑；Goal 的授权重试与普通消息仍走原策略。Host Admission 与 Actor claim 两处检查，覆盖回执在失败前已经排队的竞争窗口。
- 真实压缩没有缩减源历史、导致预算失败时，反复完成回执不能再次触发同一个压缩失败循环。用户明确发新消息仍可解除暂停。
- failed、killed、interrupted 都不是成功。缺失原 Registry 时保存 interrupted，明确副作用未知；不自动重放 Bash，不凭旧 PID 操作新进程。

## 输出和监听

完成注入只含 Job ID、状态和 continuation，不把完整日志再塞入上下文。持久快照最多各保留 8192 字节 stdout/stderr，按 UTF-8 边界截取尾部，携带截断标记；detail 最多 512 字节。

活 Registry 的 Cursor 读法不变。仅有持久快照时 `archived=true`、`cursor_supported=false`、`next_cursor=null`；带 Cursor 请求拒绝，省略 Cursor 才能读取，避免伪造增量日志。

Finished 通知触发所属订阅会话的状态对账。Broadcast Lag 后重新对账；30 秒兜底仅检查 outbox 状态，不进行模型轮询。启动使用源指纹匹配的 idle catalogue 跳过闲置历史；未知或过期 catalogue 必须完整读取。

Shutdown 先停止回执投递并有界等待监听器，再终止生产者，最后保存终态。监听 Join 与每次检查点保存各最多等待 2 秒；超时返回错误，仍继续收敛生产者，不谎称已经保存成功。该功能没有把进程内 Registry 改成常驻进程服务，正常关闭也不会保留 Bash 跨 Host 存活。

## 验收

回归使用真实 NativeToolFactory、JSONL Session、Durable Agent、Host Admission 和原工具执行器；模型行为与预算故障使用明确标注的 Scripted Provider。另有显式 opt-in 的官方 DeepSeek 测试，完整走相同链路。

复现入口：`scripts/run-deepseek-job-continuation-live.py`。脚本先 rsync，再在 WZU_Server 编译；API Key 通过 SSH stdin 进入远程测试进程环境，不写远程凭据文件。当前运行软件与公开发布不属于这次源码验收。
