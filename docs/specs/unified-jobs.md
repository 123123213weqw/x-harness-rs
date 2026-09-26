# Job 执行身份、状态协议与共用 UI（v1）

## 范围

统一**后台进程**和**定时 Agent 的执行投影**，不把每个短工具调用都改造成 Job。
不重写 Agent Loop、Schedule 定时器、进程监督器；创建仍走原 Bash/automation 工具。

## 身份

- 进程：`kind + Registry generation(UUID v4) + counter`，返回值是 opaque ID。
- 每次 Registry 创建新的 generation，旧 ID、旧 cursor、旧数字短名不能解析成新 producer。
- 定时执行：复用日志中已持久化的 occurrence/input ID；不同执行不能共享最新结果别名。
- 所有查询、输出、取消都按 source session 绑定；不接收 caller 提供的 PID、owner 或任意目标 session。
- 这解决身份复用，不承诺 Host 重启后恢复原进程或保留其全部输出。

## 两类状态

- Plan：scheduled / overdue / paused / finished / deleted / inherited / inactive。
- Run：preparing / queued / running / waiting / stopping / completed / failed /
  cancelled / interrupted / incomplete / unavailable。
- trigger finished、工具调用成功、取消请求 accepted，均不等于 Run completed。
- 保留 incomplete 与 interrupted 的区别；未知 driver 状态映射 unavailable，禁止猜测成功。
- 未知的 Agent 实际开始/结束时间为 null；触发相位放 scheduledAtMs，不伪造 startedAtMs。
- 计划 nextAt 是保存的调度相位，必须结合 PlanState 使用；finished/deleted 不意味着还会再次触发。

## 查询与控制

Host 动态 RPC：`job/manage`，使用现有 `/api` 传输。

```json
{"sessionId":"source-session","command":{"action":"list"}}
```

- list：version=1、sessionId、plans、runs；查询至多 50 个最近计划，每个计划复用原有界运行回执。
- output：typed process reference + 可选 cursor；输出有界、非消费式、严格校验 cursor 身份。
- cancel_run：当前仅 process；返回 accepted，最终状态由 producer 结算，不乐观标完成。
- pause_plan / resume_plan / cancel_future：只控制未来触发，复用 Schedule CAS/flush 屏障。
- archived source 不允许 resume_plan；未知/外部 reference 失败关闭。
- Agent 精确取消与 stdout 不支持时，capability=false；不退化为取消整个会话。
  Agent 执行可从任务中心打开原目标聊天。

Rust DTO 位于 `xharness-jobs::protocol`，与 TS 生产 parser 共用 `fixtures/job-contract-v1.json` 回归。
v1 使用显式版本，不自动从历史工具文本推断当前状态，也不自动回退协议。

## UI

- Connection 提供唯一 JobClient；Bash、job 工具卡片、automation 卡片、工作中心“执行”页共用它。
- 同一 session 同时最多一个 catalog 请求，多个卡片不制造各自的后台模型轮询。
- 当前实现为有界 RPC 刷新，不是 SSE 事件推送；活跃执行约 1.5s、活动计划/错误约 15s。
- document 隐藏暂停读；最后一个订阅退出中止读、停止 timer；连接变化清空旧 generation 视图。
- seq、AbortSignal、owner 校验拒绝过时回包；监听者异常不打断其他投影。
- 取消本次执行与取消未来触发使用不同按钮；确认取消未来时说明已运行任务不受影响。
- 狭义进程卡片不展示其他计划或其他执行；运行 ID 放详情，不堆砌在默认摘要。
- 共用黑白灰/错误状态主题 Token；输出/名称仅作为文本展示，不解释 HTML。

## 兼容与非目标

- 原 job_output/job_list/job_kill、automation/manage 继续可用；原 JSON status 字段不改名。
- job_id 格式不再是 kind-数字：调用方必须使用返回的完整 opaque ID。
- 不新增模型 Loop；正常会话恢复与已授权定时执行仍受原生命周期控制。
- 未做完成事件→持久化 Inbox 自动唤醒桥，也不因 UI 查询自动重放副作用。
- 暂无进程运行记录跨 Host 持久化、Agent 按 occurrence 精确取消、catalog 分页、统一创建 Schema。
- 不替换或重启已安装应用；不以 UI 刷新声称模型 decode、TTFT 或吞吐提升。

## 必须回归

generation/旧 cursor/无短名别名、owner 隔离、原生 Factory 与工具共用 Registry、
取消 ack 非完成、未来触发与当前执行互不误伤、Plan finished 不代表 Run completed、
时间字段真实性、Rust/TS 同一 fixture、旧工具兼容、断线/卸载/迟到回包、请求合并、
双击控制、HTML 转义、窄屏、键盘导航、深浅色和静态构建一致性。
