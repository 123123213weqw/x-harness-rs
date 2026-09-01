# DeepSeek Harness 兼容矩阵

**冻结上游：** `deepseek-harness@141eb6fef8`  
**生成方式：** `scripts/sync_upstream_catalog.py`，只读静态抽取。

## 汇总

| 目录 | 上游数量 | Rust 已覆盖 | 说明 |
| --- | ---: | ---: | --- |
| 固定 RPC | 52 | 52 | 名称 exact，业务语义仍按方法验收 |
| 动态 Typert RPC | 26 | 2 | 端点由 Service Namespace + Remote Method 组成 |
| Mux Frame | 10 | 10 | 判别字段名称 exact，业务字段另测 |
| Host Frame | 10 | 10 | 判别字段名称 exact，业务字段另测 |
| Forwarded Host Event | 11 | 1 | Frame 通用形状已支持，生产者逐项迁移 |
| Session Event | 48 | 25 | 未覆盖事件进入稳定 TODO |
| 静态 Literal Tool | 53 | 14 | 动态 Tool 另行人工审计 |
| Prompt Component | 37 | — | Section/Context/Tool Provider/Variable 分开记录 |
| Settings Namespace | 5 | 1 | Rust 当前仅有产品启动所需基线 |
| Service Definition | 69 | — | 68 个静态 Key，Rust 用 Trait/Registry 等价替代 |
| Service Provision | 18 | — | ctx.provide 组合点保留表达式和来源 |

## 固定 RPC

| 上游方法 | Rust | 等级 |
| --- | --- | --- |
| `session.list` | 是 | `partial` |
| `session.search` | 是 | `partial` |
| `session.create` | 是 | `partial` |
| `session.history` | 是 | `partial` |
| `session.models` | 是 | `partial` |
| `session.selectModel` | 是 | `partial` |
| `session.rename` | 是 | `partial` |
| `session.fork` | 是 | `partial` |
| `session.prompt` | 是 | `partial` |
| `session.attachment` | 是 | `partial` |
| `session.updateQueue` | 是 | `partial` |
| `session.cancel` | 是 | `partial` |
| `subagent.list` | 是 | `partial` |
| `subagent.history` | 是 | `partial` |
| `subagent.prompt` | 是 | `partial` |
| `subagent.interrupt` | 是 | `partial` |
| `host.describe` | 是 | `partial` |
| `host.pickDirectory` | 是 | `partial` |
| `host.listDirectory` | 是 | `partial` |
| `host.createDirectory` | 是 | `partial` |
| `host.openPath` | 是 | `partial` |
| `workspace.list` | 是 | `partial` |
| `workspace.create` | 是 | `partial` |
| `workspace.rename` | 是 | `partial` |
| `workspace.delete` | 是 | `partial` |
| `workspace.insertBefore` | 是 | `partial` |
| `workspace.insertSessionBefore` | 是 | `partial` |
| `workspace.archiveSession` | 是 | `partial` |
| `skill.list` | 是 | `partial` |
| `agentPreset.list` | 是 | `partial` |
| `agentPreset.select` | 是 | `partial` |
| `agentPreset.read` | 是 | `partial` |
| `agentPreset.copy` | 是 | `partial` |
| `agentPreset.openDocument` | 是 | `partial` |
| `agentPreset.remove` | 是 | `partial` |
| `goal.create` | 是 | `partial` |
| `goal.edit` | 是 | `partial` |
| `goal.pause` | 是 | `partial` |
| `goal.resume` | 是 | `partial` |
| `goal.complete` | 是 | `partial` |
| `goal.clear` | 是 | `partial` |
| `settings.describe` | 是 | `partial` |
| `settings.openDocument` | 是 | `partial` |
| `settings.update` | 是 | `partial` |
| `settings.replace` | 是 | `partial` |
| `settings.mutate` | 是 | `partial` |
| `credentials.describe` | 是 | `partial` |
| `credentials.set` | 是 | `partial` |
| `credentials.unset` | 是 | `partial` |
| `llm.providers` | 是 | `partial` |
| `llm.models` | 是 | `partial` |
| `llm.discoverModels` | 是 | `partial` |

## 动态 Typert RPC

| 上游端点 | Rust | 等级 |
| --- | --- | --- |
| `commands/execute` | 是 | `partial` |
| `commands/list` | 是 | `partial` |
| `dynamicCordisRunner/getClientCode` | 否 | `planned` |
| `dynamicCordisRunner/inventory` | 否 | `planned` |
| `dynamicCordisRunner/invoke` | 否 | `planned` |
| `dynamicCordisRunner/reportClientGuardFailure` | 否 | `planned` |
| `dynamicCordisRunner/reportRenderFailure` | 否 | `planned` |
| `dynamicCordisRunner/resolveInspectQuery` | 否 | `planned` |
| `dynamicCordisRunner/resolveRequestRun` | 否 | `planned` |
| `dynamicCordisRunner/runHostHalf` | 否 | `planned` |
| `dynamicCordisRunner/settleUserRun` | 否 | `planned` |
| `dynamicCordisRunner/stopFromPanel` | 否 | `planned` |
| `dynamicCordisRunner/syncInspectManifest` | 否 | `planned` |
| `dynamicCordisRunner/undefineFromPanel` | 否 | `planned` |
| `fileReferences/list` | 否 | `planned` |
| `goals/clear` | 否 | `planned` |
| `goals/complete` | 否 | `planned` |
| `goals/create` | 否 | `planned` |
| `goals/edit` | 否 | `planned` |
| `goals/pause` | 否 | `planned` |
| `goals/resume` | 否 | `planned` |
| `messageFeedback/delete` | 否 | `planned` |
| `messageFeedback/list` | 否 | `planned` |
| `messageFeedback/put` | 否 | `planned` |
| `pluginInventory/list` | 否 | `planned` |
| `sessionReferenceResolver/candidates` | 否 | `planned` |

## Mux Frame

| 判别值 | Rust 强类型 Frame | 等级 |
| --- | --- | --- |
| `session/event` | 是 | `behavioral` |
| `session/subscribed` | 是 | `behavioral` |
| `approval/requested` | 是 | `behavioral` |
| `approval/resolved` | 是 | `behavioral` |
| `question/requested` | 是 | `behavioral` |
| `question/resolved` | 是 | `behavioral` |
| `session/queue` | 是 | `behavioral` |
| `session/jobs` | 是 | `behavioral` |
| `session/projection` | 是 | `behavioral` |
| `stream/error` | 是 | `behavioral` |

## Host Frame

| 判别值 | Rust 强类型 Frame | 等级 |
| --- | --- | --- |
| `host/session-added` | 是 | `behavioral` |
| `host/session-removed` | 是 | `behavioral` |
| `host/session-status` | 是 | `behavioral` |
| `host/agent-error` | 是 | `behavioral` |
| `host/workspace-changed` | 是 | `behavioral` |
| `host/workspace-removed` | 是 | `behavioral` |
| `host/workspace-order-changed` | 是 | `behavioral` |
| `host/archived-sessions-changed` | 是 | `behavioral` |
| `host/remote-event` | 是 | `behavioral` |
| `stream/error` | 是 | `behavioral` |

## Forwarded Host Event

`host/remote-event` 的通用 Frame 已实现；下表表示 Rust Host 是否已有对应生产者。

| 事件 | Rust 生产者 | 等级 |
| --- | --- | --- |
| `agent-preset/selected` | 是 | `partial` |
| `commands/change` | 否 | `planned` |
| `credentials/updated` | 否 | `planned` |
| `cordis/request-run` | 否 | `planned` |
| `cordis/request-run-resolved` | 否 | `planned` |
| `cordis/dynamic-package` | 否 | `planned` |
| `cordis/dynamic-retract` | 否 | `planned` |
| `cordis/inspect-query` | 否 | `planned` |
| `cordis/inspect-query-resolved` | 否 | `planned` |
| `llm/adapters-updated` | 否 | `planned` |
| `settings/document-updated` | 是 | `partial` |

## Session Event

Rust Session 已持久化 Compact Start/Summary/Checkpoint Replace/End，并由正式 Host 自动触发与
投影到 Web；Prune 事件词汇已冻结，但生产 Tool Result Replacement 尚未接线，所以仍是 partial。

| 上游事件 | Rust 强类型事件 | 等级 |
| --- | --- | --- |
| `agent-preset/selected` | 是 | `partial` |
| `agent/inbox/spliced` | 是 | `partial` |
| `approval/asked` | 是 | `partial` |
| `approval/decided` | 是 | `partial` |
| `approval/policy` | 是 | `partial` |
| `assistant/chunk` | 是 | `partial` |
| `assistant/message` | 是 | `partial` |
| `command/done` | 是 | `partial` |
| `command/run` | 是 | `partial` |
| `compaction/end` | 是 | `partial` |
| `compaction/prune` | 是 | `partial` |
| `compaction/start` | 是 | `partial` |
| `compaction/summary` | 是 | `partial` |
| `feedback/record` | 否 | `planned` |
| `goal/change` | 是 | `partial` |
| `hook/invoked` | 否 | `planned` |
| `hook/result` | 否 | `planned` |
| `llm/retry` | 是 | `partial` |
| `llm/retry-started` | 是 | `partial` |
| `permission/preset` | 是 | `partial` |
| `plan/mode` | 是 | `partial` |
| `request/context` | 是 | `full` |
| `request/header` | 是 | `partial` |
| `sandbox/mode` | 是 | `partial` |
| `schedule/change` | 否 | `planned` |
| `session/end-seed` | 是 | `partial` |
| `session/title` | 是 | `partial` |
| `session/title-llm-request` | 否 | `planned` |
| `step/end` | 是 | `partial` |
| `step/start` | 是 | `partial` |
| `subagent/descriptor` | 否 | `planned` |
| `team/member` | 否 | `planned` |
| `team/message/delivered` | 否 | `planned` |
| `team/message/queued` | 否 | `planned` |
| `team/task` | 否 | `planned` |
| `todo/write` | 否 | `planned` |
| `tool-workflow/agent-end` | 否 | `planned` |
| `tool-workflow/agent-start` | 否 | `planned` |
| `tool-workflow/run-end` | 否 | `planned` |
| `tool-workflow/run-start` | 否 | `planned` |
| `tool/call` | 是 | `partial` |
| `tool/code-dispatch` | 否 | `planned` |
| `tool/code-dispatch-start` | 否 | `planned` |
| `tool/result` | 是 | `partial` |
| `turn/end` | 是 | `partial` |
| `turn/start` | 是 | `partial` |
| `user/message` | 是 | `partial` |
| `web/deepseek-search-llm-request` | 否 | `planned` |

## 静态 Literal Tool

该表是全仓库静态注册目录，不代表某个 Preset 会同时向模型发送全部工具。

| 工具 | Rust 原生 Tool | 等级 |
| --- | --- | --- |
| `ask_user_question` | 是 | `partial`（公共类型、状态机、Tool Registry；Host/Web 持久接线待完成） |
| `bash` | 是 | `partial` |
| `cordis_define` | 否 | `planned` |
| `cordis_inspect_list` | 否 | `planned` |
| `cordis_inspect_query` | 否 | `planned` |
| `cordis_inspect_self` | 否 | `planned` |
| `cordis_run` | 否 | `planned` |
| `cordis_stop` | 否 | `planned` |
| `cordis_undefine` | 否 | `planned` |
| `create_goal` | 否 | `planned` |
| `edit` | 是 | `partial` |
| `get_goal` | 否 | `planned` |
| `glob` | 是 | `partial` |
| `grep` | 是 | `partial` |
| `interrupt_agent` | 否 | `planned` |
| `job_kill` | 否 | `planned` |
| `job_list` | 否 | `planned` |
| `job_output` | 否 | `planned` |
| `list_agents` | 否 | `planned` |
| `lsp` | 否 | `planned` |
| `pwsh` | 否 | `planned` |
| `ralph` | 否 | `planned` |
| `read` | 是 | `partial` |
| `read_image` | 否 | `planned` |
| `report` | 否 | `planned` |
| `schedule_create` | 否 | `planned` |
| `schedule_delete` | 否 | `planned` |
| `schedule_list` | 否 | `planned` |
| `send_message` | 否 | `planned` |
| `session_event_read` | 否 | `planned` |
| `session_event_search` | 否 | `planned` |
| `session_event_trace` | 否 | `planned` |
| `session_search` | 否 | `planned` |
| `session_trace` | 否 | `planned` |
| `skill` | 否 | `planned` |
| `spawn_teammate` | 否 | `planned` |
| `str_replace_editor` | 否 | `planned` |
| `team_task_create` | 否 | `planned` |
| `team_task_get` | 否 | `planned` |
| `team_task_list` | 否 | `planned` |
| `team_task_update` | 否 | `planned` |
| `terminal_close` | 是 | `partial` |
| `terminal_list` | 是 | `partial` |
| `terminal_open` | 是 | `partial` |
| `terminal_read` | 是 | `partial` |
| `terminal_send` | 是 | `partial` |
| `terminal_signal` | 是 | `partial` |
| `todo_write` | 否 | `planned` |
| `update_goal` | 否 | `planned` |
| `wait_agent` | 否 | `planned` |
| `web_fetch` | 是 | `partial` |
| `web_search` | 是 | `partial` |
| `write` | 是 | `partial` |

## Prompt Component

| 类型 | 上游注册点 | Rust 状态 |
| --- | ---: | --- |
| Section | 28 | `planned` |
| Runtime Context | 3 | `planned` |
| Tool Provider | 2 | `planned` |
| Variable | 4 | `planned` |

每个注册点的名称/表达式、文件和行号位于机器可读 JSON；这里不把 UI Preset 文本误算为运行时 Section。

## Settings Namespace

| 上游 Namespace | Rust | 等级 |
| --- | --- | --- |
| `agent-presets` | 否 | `planned` |
| `locale` | 否 | `planned` |
| `ui-conversation` | 否 | `planned` |
| `ui-onboarding` | 是 | `partial` |
| `ui-theme` | 否 | `planned` |

## Service Definition

Service 是上游 Cordis 组合目录；Rust 是否完成以对应 Trait/Registry 的行为验收为准，
此表不把同名 Class 当作复刻目标。完整 Class、Base、Key 与来源位于机器可读 JSON。

已记录 `69` 个定义，其中 `68` 个是静态 Service Key；动态或缺失 Key 保留原表达式供人工审计。
另记录 `18` 个 `ctx.provide(...)` 组合点。
