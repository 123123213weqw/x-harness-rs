# DeepSeek Harness 兼容矩阵

**冻结上游：** `deepseek-harness@141eb6fef8`  
**生成方式：** `scripts/sync_upstream_catalog.py`，只读静态抽取。

## 汇总

| 目录 | 上游数量 | Rust 已覆盖 | 说明 |
| --- | ---: | ---: | --- |
| 固定 RPC | 52 | 52 | 名称 exact，业务语义仍按方法验收 |
| Session Event | 48 | 12 | 未覆盖事件进入稳定 TODO |
| 静态 Literal Tool | 53 | 14 | 动态 Tool 另行人工审计 |

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

## Session Event

| 上游事件 | Rust 强类型事件 | 等级 |
| --- | --- | --- |
| `agent-preset/selected` | 否 | `planned` |
| `agent/inbox/spliced` | 是 | `partial` |
| `approval/asked` | 否 | `planned` |
| `approval/decided` | 否 | `planned` |
| `approval/policy` | 否 | `planned` |
| `assistant/chunk` | 是 | `partial` |
| `assistant/message` | 是 | `partial` |
| `command/done` | 否 | `planned` |
| `command/run` | 否 | `planned` |
| `compaction/end` | 否 | `planned` |
| `compaction/prune` | 否 | `planned` |
| `compaction/start` | 否 | `planned` |
| `compaction/summary` | 否 | `planned` |
| `feedback/record` | 否 | `planned` |
| `goal/change` | 否 | `planned` |
| `hook/invoked` | 否 | `planned` |
| `hook/result` | 否 | `planned` |
| `llm/retry` | 否 | `planned` |
| `llm/retry-started` | 否 | `planned` |
| `permission/preset` | 否 | `planned` |
| `plan/mode` | 否 | `planned` |
| `request/context` | 否 | `planned` |
| `request/header` | 是 | `partial` |
| `sandbox/mode` | 否 | `planned` |
| `schedule/change` | 否 | `planned` |
| `session/end-seed` | 是 | `partial` |
| `session/title` | 否 | `planned` |
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
| `ask_user_question` | 否 | `planned` |
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
