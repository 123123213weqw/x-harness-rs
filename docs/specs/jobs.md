# 后台 Job 注册表规范

**Crate：** `xharness-jobs`
**状态：** 进程内通用注册表、Bash Producer 与三个模型控制工具已实现。

## 边界

`xharness-jobs` 不依赖 Bash、PTY、Subagent、Provider 或 Web。它只管理生产者共有的身份、准入、
Owner 隔离、生命周期、未读输出、取消和 Shutdown。`xharness-coding-tools` 是第一个生产者：
`bash(run_in_background=true)` 启动受管 Process，并把控制权原子提交给 Job Registry。

```text
模型 bash(run_in_background=true)
  -> JobRegistry.reserve(owner, kind, label)   # 先占容量，不启动副作用
  -> Platform.spawn(SpawnSpec)                 # Sandbox + Process Group
  -> reservation.commit(pid, cancel_hook)      # 从此 Registry 接管
  -> JobLease.publish_stdout/stderr             # 实时增量
  -> JobLease.finish(outcome)                   # 只允许第一个终态

模型 job_output/job_list/job_kill
  -> 同一个 JobRegistry
  -> owner fence
```

## 生命周期

合法状态为：

```text
running -> completed
running -> killed
running -> failed
running -> stopping -> completed|killed|failed
```

终态 First-wins。Producer 晚到的第二次完成、Shutdown Force-fail 后的完成、并发 Kill 与自然退出
都不能覆盖已经提交的终态。非零退出码属于 `completed`，详细信息为 `exit code: N`；信号退出和
结构化 Cancel 属于 `killed`；Spawn 之后的 Supervisor/I/O/Capture 故障属于 `failed`。

`JobLease` 未 Finish 就 Drop 时强制记为 `failed`，避免 Wait 和 Shutdown 永久挂起。这只表示注册表
无法再证明 Producer 正常，不虚构资源已经安全释放。

## 原子准入

每个 Owner 默认最多 10 个 `running + stopping + reservation`。`reserve()` 在任何副作用之前检查
配置和容量；Reservation Drop 自动回滚，并且不消费公开 `<kind>-N` ID。Producer 成功 Spawn 后
才 `commit()` 分配 ID。Commit 若因 Shutdown 失败，调用方仍拥有 Process，必须 Cancel + Wait。

每个 Owner 默认保留 100 条记录。新注册前只清理该 Owner 最老的终态，绝不为了腾历史容量删除
活跃 Job。Job ID 按 Kind 独立单调递增。

## 访问与输出

ID 可预测，因此边界是 Owner 授权而不是 ID 保密。`get/read/kill/wait/list` 只允许相同 Owner；
未知 ID 和外部 Owner 返回同一个 `unknown job`，防止标签和存在性泄露。

每条 stdout/stderr 默认保留 256 KiB 未读 Tail。Producer 追加原始 bytes，读取按 UTF-8 完整标量
消费；若容量淘汰了旧字节，则下一次读取设置 `truncated`。`read()` 是模型侧单消费 Cursor；
Process 的 `ProcessOutputObserver` 另有非消费绝对 Cursor，二者不能混为一个 UI 观察面。

Registry 的内部 `JobSnapshot` 含 Owner、PID、Output Limit 和 `reported`，但三个模型工具只返回
`PublicJobSnapshot`：`id/kind/label/status/detail/started_at_ms/finished_at_ms`。这样模型能够控制任务，
却看不到跨层授权和通知账本。动态配置必须先走 `JobRegistryConfig::validate()` 或
`JobRegistry::try_new()`；任何零容量都会返回类型化错误，不进入运行期。

## Wait、Kill 与 Shutdown

- Wait 必须有正的有限时限；超时返回实时快照，不是失败，不取消 Job。
- Kill 先调用 Producer 的同步幂等 Cancel Hook，再迁移 `stopping/reported`；Hook 报错时注册表
  完全不变。终态 Kill 返回 `already_finished`。
- Shutdown 停止新 Reservation、清空未提交 Reservation、取消全部活跃 Job，并在全局 Grace 内
  等待。Cancel Hook 异常和超时分别计入报告并 First-win `failed`，错误文案明确“可能仍有 orphan”，
  不声称已经释放资源。
- Started/Stopping/Finished 通过有界 Broadcast 发布；慢订阅者允许收到 Lag，必须重新 List，
  不得把 Event Queue 当权威状态。

Host 的版本化 System Prompt 与 `bash` Tool Description 都注入同一选择规则：长时间非交互命令
使用 `run_in_background=true`，保存 Job ID，继续独立工作，最后用 `job_output` 收集；不得自己拼
`&/nohup/disown/screen/tmux/PTY`。这段跨 Step 规则不是只依赖模型“猜”工具 Schema。

## 持久化边界

当前 Job Registry 是进程内能力，不写 Session JSONL。正常 Shutdown 负责资源收敛；Host 崩溃后
不得自动重放后台 Bash，因为这会重复副作用。未来若增加恢复，只能记录 Outcome Unknown、PID/
Process Identity 和 Orphan Reconciliation 证据，不得凭旧 PID 直接 Kill 新进程。
