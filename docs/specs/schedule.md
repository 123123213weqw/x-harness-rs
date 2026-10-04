# Durable Automation

**Crate:** `xharness-schedule`
**Model interface:** one `automation` tool. Existing Schedule journals remain readable.

## Semantics

`mode=reminder` presents a saved reminder; `mode=task` executes a task the user
explicitly requested to run later. Omitting mode means reminder. Old records
without `automation` metadata always retain reminder/current-chat semantics;
reading or upgrading the application never converts them to executable tasks.
A model may not create tasks merely because it received a webpage or another
agent's suggestion. The tool description requires an originating user request.
Task content enters the normal **user** role, not system instructions, and does
not bypass the source chat's approval/sandbox policy.

`target=current_chat` (default) follows up at the existing chat's idle boundary.
`target=new_chat` creates one independent conversation per run, using the source
workspace, model and permission. This is not a child Agent: it has independent
history and no delegation/join semantics. Its durable origin links to the source.
No model-controlled session-id parameter is accepted.

Long-running commands that should start now still use `bash`/`job_*`. Never use
sleep, nohup, Shell `&`, PTYs or frontend polling to emulate a future timer.

## One closed tool

| action | Fields | Meaning |
|---|---|---|
| create | prompt; one time selector; optional mode, target, idempotency_key | Persist a rule before returning its id |
| update | id; changed prompt/mode/target/time fields | Omitted fields retain their values; omitting time retains the phase |
| list | none | Active and paused rules in this exact chat |
| view | id | Definition, lifecycle and most recent 50 run receipts/outcomes, including finished/deleted rules |
| pause / resume | id | Disable/enable future triggers; does not cancel an admitted run |
| delete | id | Remove future triggers, preserving run/history facts; unknown/inactive returns deleted=false |

Action-specific deserialization rejects unrelated fields, unknown actions,
caller-selected ownership and empty updates. API adapters bind the owner chat
outside arguments and share `ScheduleManager::execute` with the model adapter.
New requests project only this tool; `schedule_create/list/delete` are not
registered in production. Test-only old adapters exercise journal compatibility.
Deployments with an explicit tool allowlist must replace the old names with
`automation`; the default unrestricted catalogue needs no configuration change.

Time selectors preserve the existing validated implementation:

- positive `after_seconds`;
- `at`: explicit-offset RFC3339, or `{date,time,time_zone}` with UTC/IANA zone;
- `every_seconds >= 300`, fixed-phase intervals, not a cron/calendar RRULE.

DST gaps fail; ambiguous local times choose the first occurrence. Only one time
selector is allowed. A time edit must be future-dated. Resume of an overdue rule
keeps its original phase and catches up once at the next safe boundary.

Create uses an owner-scoped stable key and a digest of the original command.
Repeating the same key and command returns the existing rule, even after edits,
delete or completion. Reusing a key for a different command fails. Without an
explicit key, the tool execution id is the key; a *new* invocation is a new
operation, not a guaranteed retry. Clients retrying create should retain a key.
An uncertain flush returns an explicit persistence-uncertain result; inspect
list/view before relying on it. Once mutation admission starts, the durability
barrier is allowed to finish even if its consumer is cancelled.

## Ownership and durable run ledger

The existing session event log remains the only source of truth. No new Agent
loop, global shell cron or private UI scheduler is introduced.

```text
create/update/delete -> Session CAS append -> flush -> notify timer projection

due -> wait for idle / check source -> reserve_run (stable run + occurrence)
    -> Host prepare target (if independent chat)
    -> subscribe BEFORE inbox admission -> maintenance_followup
    -> run receipt -> ordinary Runtime execution and Host live projection

view -> reservation/receipt in source + ordinary turn facts in target
```

`reserve_run` pins the exact occurrence and deterministic target id **before**
calling the Agent. If the Host crashes or preparation fails for several periods,
recovery first reconciles that reservation. The same stable inbox id proves
admission after a crash between inbox flush and receipt flush. Retry writes the
receipt, never re-executes known-admitted work. Reservation identities are unique
and a run receipt must match its reservation. While reservation reconciliation
is pending, mutations return `run_preparing` rather than changing its task or
retargeting an already-admitted run.

A receipt is **admission**, not completion. Run state is reconstructed from the
target journal, not generated text or an in-memory callback:
`preparing / queued / running / completed / failed / cancelled / interrupted /
incomplete / unavailable`. Completed means the ordinary model turn completed;
it does not prove every business objective was achieved. Missing/unreadable
outcomes are unavailable, never fabricated success.

A given automation does not start another run while its previous run is
nonterminal, even when that run is in another chat. Other due rules may proceed.
An independent task is not starved by a busy current-chat rule; the timer waits
for either current-chat idleness or the next independent deadline. Settlement
of a previously admitted independent run is rechecked at most every 30 seconds
while overdue, rather than replaying its potentially large journal each second.
Missed periods collapse to the latest occurrence, without a backlog storm.
Paused rules have no timer, but remain in list/projection. Source archive,
deletion or dispatch pause blocks future admission. Unarchive/explicit resume
restores eligibility; it does not replay known-delivered work. Pausing/deleting
future triggers and stopping an active target chat are distinct operations.

The Host adapter creates independent chats through existing session lifecycle
and policy composition. It holds a weak Host reference; Runtime shutdown stops
all timer owners. Host must be running: this feature cannot wake a powered-off
machine or promise offline real-time execution. A process restart reconstructs
rules and run outcomes from durable journals. Unknown side-effect outcomes stay
in ordinary Runtime recovery/approval handling, not unconditional task replay.

Fork/edit copies managed automation history but does not rearm its source's
automations. The fork can create its own source-scoped rules after its origin
marker; inherited definitions are inspectable as `inherited`, not executable.
Legacy reminder-only journals keep their previous fork behaviour.

## Projection and UI boundary

The existing `schedules` projection includes explicit mode, target and paused
metadata; the current Automation overview and chat catalogue read that same
projection. Cold event folding understands update/reservation/run facts, and
never advances the phase on reservation alone. No frontend timer runs tasks.
The isolated Scheduled design preview is still only a preview: its full
create/edit/detail UI is not made production by this backend/tool change.

## Acceptance

- one production tool, closed per-action arguments, source-bound ids;
- 32 concurrent creates with one key persist one definition; conflicting reuse
  and replay after deletion do not create work;
- legacy reminders never upgrade implicitly, and preserve phase across edits;
- paused/overdue/resume reconstruction; invalid times/frequency/targets;
- current-chat busy/idle admission without steering or premature reservation;
- fork/edit preserves history without duplicating managed executable schedules;
- preparation failure spanning multiple periods; immutable reservation recovery;
- independent run overlap prevention and latest-only catch-up;
- admission-before-receipt crash reconciles without a second model invocation;
- model rejection is failed, not completed;
- real Host live projection, independent policy inheritance and JSONL reopen;
- hot/cold UI projection preserves metadata and updates phases only on receipt.

Offline fixtures use a scripted model with the real Schedule/Agent/Host/JSONL
paths. They do not establish real DeepSeek tool-selection quality, native OS
wake support, or a universal exactly-once guarantee for external side effects.

### Automation result cards

The Schedule UI owns the `automation` entry in Tool's existing keyed
`tool.call.toolview` slot. Create/update/view results show a compact saved-task
card; list shows up to 20 rows, while raw arguments and results stay in collapsed
Details. Partial or malformed results remain inspectable. A domain `{code,
message}` rejection is a failure even when the tool transport succeeded.

The creation receipt is historical, not a live status source. Mounted cards read
`automation/manage` through Connection's generic RPC channel and refresh on the
existing `schedules` projection. Their initial receipt is explicitly marked as
historical until readback succeeds. Timer state and latest run outcome are
separate: `finished` does not mean a queued/running task completed. Backend run
receipts, not model prose or a missing schedule, determine completion.

`automation/manage` accepts `{sessionId, command}`. The Host validates the closed
request, fences session deletion, and delegates to the Runtime's Schedule manager.
Only list/view/pause/resume/delete are mounted for cards; chat creation/editing
still uses the single tool. Pause/resume/delete publish the existing authoritative
projection after durable Schedule execution. Archived chats cannot resume timers.
No new timer implementation, model call, or arbitrary owner ID is introduced.

Controls remain disabled without authoritative readback. Deletion has an inline
confirmation and removes future triggers, not chat history or an already admitted
run. Mutations are same-render single-flight; a failed/ambiguous request triggers
readback rather than optimistic success. Unmount aborts reads and fences late
replies. Hidden pages do not issue status reads. Active runs poll at 5 seconds;
future triggers wait until due (with a maximum one-hour check), and terminal or
paused records do not poll. Projection changes and card mutations invalidate
mounted views. Reads and mutations have a 15-second client deadline. Status reads retry
without calling the model; mutations never automatically retry and instead
read back the authoritative state after a failure or timeout.


## PR #223 回归修复：预备任务隔离与控制语义

- 目标会话创建失败按 **run_id** 单独退避：1、2、4、8、16、30 秒，最高 30 秒；不会不断选择队首的失败任务阻挡其他已到期任务。退避从失败返回时开始计时，目标创建最长等待 30 秒。
- 预备中的同一 occurrence 不重复预留、不更换目标 ID；重启可重新尝试，但不会新增一份任务。
- Pause/Resume 使用专用 `SetPaused` 控制事件，仅改暂停标志，不借用受限的定义 Update；Session 校验与 Schedule 回放共用这项语义。Pause 保留未入队的预留，暂停时不执行；Resume 沿用同一预留。Delete 可以取消尚未入队的预留，取消记录由原始 ReserveRun + Delete 日志恢复，View 仍显示 cancelled 收据。
- 控制操作必须先对账：先落盘已知 Run 收据；重启丢失内存标记时，查询目标持久 inbox。已入队就补齐 Run，不能伪装成取消。查询失败时返回存储错误，不猜测“尚未执行”。
- Update 不改写预备中的不可变 occurrence；可以先删除未入队任务再建立新规则。Pause/Delete 不终止已入队的运行。
- 前后端实时通知和 session.list 共用同一个严格 origin Schema，允许 subagent、fork、automation 及旧数据缺省值；未知值仍拒绝。Rust 真 Host 测试可导出 automation 消息，交给生产 WebSocket/HTTP 解码路径验收。
- 回归覆盖永久失败不饥饿、退避不热轮询、独立健康任务、暂停/恢复/重启、删除取消与收据保留、入队后收据缺失时对账不重执行。
