# XHarness 总任务清单

**基线日期：** 2026-08-20
**完成规则：** 只有实现、规范、测试和用户文档全部落地，任务才算完成。ID 永久稳定，
Commit、Issue、PR 应引用这些 ID。

## 已完成基础能力

- [x] `DONE-01` Provider-neutral 流式 Loop 与多 Step 工具执行。
- [x] `DONE-02` Chat Completions 和 Responses SSE Adapter。
- [x] `DONE-03` 运行时 Steering、Injection、Pause/Resume、Cancel、Approval。
- [x] `DONE-04` Append-only 强类型 Session Log 和内存 CAS Store。
- [x] `DONE-05` 跨进程加锁、可恢复崩溃尾部的 JSONL Store。
- [x] `DONE-06` 正式 Tool Registry、Schema 校验、Middleware 和 Policy。
- [x] `DONE-07` 直接 Argv Subprocess Runtime、有界输出与清理。
- [x] `DONE-08` Linux/macOS Workspace FS 与 Observation CAS。
- [x] `DONE-09` Linux Bubblewrap、macOS Seatbelt 和平台抽象。
- [x] `DONE-10` 按 Owner 隔离的持久 PTY Runtime。
- [x] `DONE-11` 匿名有界 Web Fetch 和可插拔 Search。
- [x] `DONE-12` 标准 14 个 Coding Tool。
- [x] `DONE-13` 真实 V100 Qwen 工具 Loop：模型 → 审批 → 写入 → 重放 → 最终回答。
- [x] `DONE-14` 每 Crate 规范和总路线图。
- [x] `DONE-15` Web 线协议第一阶段：52 RPC、四象限信封、Mux/Host Frame、HTTP、
  下行 WebSocket、`/api/respond`、Export/Static 路由骨架。
- [x] `DONE-16` Web Host 基线：52 RPC 全部有状态行为；真实 Loop Turn、14 个原生工具、
  审批响应、Mux/Host 事件投影、JSON Export 和 Loopback Server Binary 全部接通。

## P0 — 可日常使用的本地 Coding Agent

- [ ] `P0-01` **轻量 CLI。** 实现 `xharness run`、Provider/Model/Base URL 参数、
  Workspace/Policy 选择、流式 Text/Reasoning 渲染、审批提示、Ctrl-C Cancel、Exit Code 和
  `config dump`。
  **验收：** Linux 和 macOS 都能用一条命令运行真实 V100 测试任务。

- [ ] `P0-02` **持久长生命周期 Agent 层。** 新增 `xharness-agent`：Agent、Turn、Step、
  Durable Inbox Message ID、Claim/Ack、Next-turn/Next-step 语义、Single-writer Session
  Lease 和重启续跑。
  **验收：** 输入被接受后到下次 Request 之间崩溃不能丢输入，也不能重复 Tool Side Effect。

- [ ] `P0-03` **端到端统一使用 `xharness-tools`。** 从 Core 删除重复的 Scheduling/Approval，
  淘汰兼容 `xharness-core::ToolSpec`。同一个 Execution ID 必须贯穿 Journal、Approval、
  Middleware、Event 和 Result。

- [ ] `P0-04` **Provider Call ID 映射。** 分别保存内部 Execution ID 和 Provider Native
  Call ID。修复 Responses Opaque Item Replay，确保 `function_call_output.call_id` 匹配
  Provider Item，同时审计事件保留稳定 Namespaced ID。

- [ ] `P0-05` **有界事件投递。** 用 Append-only、按 Byte 计量的 Journal 和非阻塞
  Subscription 替换无界 Loop Event Channel，并提供明确 Lag/Resume Cursor。忽略事件的
  Host 不能 OOM，也不能阻塞 `result()`。

- [ ] `P0-06` **结构化 Shutdown 和 Quiescence。** 用 Scope 管理 Provider/Tool/Process
  Task；Cancel 必须 Signal 并 Join。定义超过有界 Grace 后的 Forced-cleanup 终态。
  **测试：** Runtime Shutdown、Handler Abort、Descendant、受限工具 Result 不能早于进程死亡。

- [ ] `P0-07` **macOS 原生运行验证。** 在真实 Apple Silicon Mac 上运行 FS Race、Seatbelt、
  PTY Lifecycle、Web TLS、Live Loop，并打包/签名 CLI。仅 Cross Compilation 不算完成。

- [ ] `P0-08` **Web DNS Rebinding 加固。** 每个连接绑定到已验证 Resolve Address，同时
  保留 TLS Host/SNI；Redirect 重新应用 Policy。测试 Rebinding、IPv4-mapped IPv6 和
  Reserved Range。

- [ ] `P0-09` **配置与凭据边界。** 强类型配置文件、环境覆盖、Provider/Search Secret
  Reference、Redacted Debug、Event Log 禁止 Secret、文件权限校验。不做 Plugin/HMR Loader。

- [ ] `P0-10` **真实协议矩阵。** 针对支持端点运行 Chat/Responses 真实 Tool Loop，覆盖
  Reasoning、多并行 Call、Tool Failure、Cancel、Usage、Long Context。保存不含 Secret 的
  可复现 Fixture。

## P1 — Coding 质量与上下文效率

- [ ] `P1-01` **Prompt Registry。** 有序 System Section、Workspace Context、Tool Guidance、
  Variable、Provider-specific Section、确定性 Request Header Capture 和 Prompt Version ID。

- [ ] `P1-02` **LLM/Provider Registry。** 按 Provider/Model/Purpose 路由，把 Prepared Call
  绑定到一个注册 Adapter，暴露 Reasoning/Max-token 控制，并在不猜协议的情况下发现模型能力。

- [ ] `P1-03` **Token Meter 与 Context Policy。** Provider-aware Token Estimate、最大输入
  Guard、确定性 Tool Output Reduce、Surface Replace，以及不修改原 Event Log 的可选 Summary。

- [ ] `P1-04` **动态 Tool Projection。** 每个 Profile/Step 只发送相关工具，同时保持 Schema
  稳定。与始终发送 14 工具比较 Token/Cache 消耗和工具选择质量。

- [ ] `P1-05` **更完整的 Tool Description。** 增加何时用、何时不用、前置条件、输出语义、
  `bash` 与 Terminal 选择指导；使用固定工具选择数据集评估。

- [ ] `P1-06` **扩展 FS Tool。** 增加目录创建/列表、安全 Delete/Move/Copy、Binary/Image
  Read、Unified Diff/Patch、按行读取和显式 Spill Reference；继续保持 Observation CAS 和审批。

- [ ] `P1-07` **后台 Job。** One-shot Bash `run_in_background`、Owner-scoped Job Registry、
  Status/Read/Cancel、有界 Spill、重启后 Outcome 语义和 Process-tree 清理。

- [ ] `P1-08` **补全 Terminal 协议。** Resize、OSC 133 Prompt Marker、Foreground-pgid/
  Read-state Observation、Active-send 互斥，以及明确 Settle Reason：`stdin_read`、
  `inferred_idle`、`timeout`、`session_exit`。

- [ ] `P1-09` **多模态 Message 与 Attachment。** 强类型 Text/Image/File Block、内容寻址
  Blob Store、Image Metadata/Budget、Provider Encoding，用持久 Reference 替代内联大数据。

- [ ] `P1-10` **Web 质量。** 更多 Search Provider、稳定 Source/Citation Object、内容去重、
  更好的正文提取、Cache，以及作为独立高信任 Capability 的可选登录态 Browser。

- [ ] `P1-11` **Session Branch 与 Projection。** 从 Revision Fork、不可变 Ancestry、命名
  Branch、Inspect/Query API、Compaction Surface Event、确定性 Transcript Export/Import。

- [ ] `P1-12` **资源 Policy。** CPU/Memory/File/Process/Output Quota、Per-tool Policy、
  条件允许时接 Linux cgroup v2，并让 Quota Failure 可观测。

## P2 — Host、API 与 UI

- [ ] `P2-01` **持久 Agent-backed Web API。** Carrier、52 方法目录、内存 CRUD、Start/
  Steer/Cancel/Approve、History Projection、Optional Capability Response 和 Export Body 已完成。
  下一步用持久 Agent/Session/Inbox Store 替换 `BasicHost` 内存，增加 Health/Readiness，同时
  保持冻结的线协议。

- [ ] `P2-02` **流式传输增强。** 提供带 Cursor Resume、Lag Detection、Reconnect 和
  Per-session Multiplexing 的 WebSocket/SSE 下行事件流。

- [ ] `P2-03` **Web UI 完整投影。** 继续把 DeepSeek Harness UI 作为 Client Projection：
  Session、流式 Reasoning/Text、Tool Card、Approval、Terminal、File、Web Source、Usage、
  Recovery State。

- [ ] `P2-04` **Host 认证与授权。** 默认仅本地；远程使用 Bearer/Session Auth、Workspace/
  Owner 隔离、CSRF/Origin Policy、Audit Log 和显式 Network Exposure。

- [ ] `P2-05` **可观测性。** 结构化 Tracing、Per-step Latency/TTFT/TPOT、Tool Duration、
  Retry/Cancel Reason、Token/Cache Accounting、OpenTelemetry 接口和 Secret-safe Diagnostic Bundle。

- [ ] `P2-06` **Settings 与 Profile。** Versioned YAML/TOML Profile、有序 Patch Layer、
  Validation/Dump、Migration，以及 Model/Tool/Policy Preset。

## P2 — 生态能力

- [ ] `P2-07` **MCP Client。** Stdio/HTTP Transport、Lifecycle、Capability/Schema Import、
  Cancellation、Approval/Policy Mapping、Namespace 和 Credential Isolation。

- [ ] `P2-08` **Skills。** 发现/加载有版本的 Instruction Package，显式 Scope 和 Token
  Budget；在 Request Header 中记录选中的 Skill Version。

- [ ] `P2-09` **LSP 集成。** Owner-scoped Language Server、Diagnostic、Definition/
  Reference/Symbol Tool、Restart/Backoff、有界输出和 Workspace Policy。

- [ ] `P2-10` **Git 工具。** 安全直接 Argv 的 Status/Diff/Log、Mutation Approval、
  Worktree Awareness，并禁止隐式 Push/转发 Credential。

- [ ] `P2-11` **本地代码索引。** Ignore-aware 增量 Search/Index 和确定性 Reference；必须
  与公共 Web Search 分开。

## P3 — 多 Agent 与 Workflow

- [ ] `P3-01` **Subagent。** 命名 Child Activation、独立 Tool/Provider/Profile Scope、
  Parent-child Event Link、独立 Cancel、Continuation 和有界并发。必须建立在持久 Agent/
  Inbox 上，不能直接塞进 `LoopRun`。

- [ ] `P3-02` **Workflow Graph。** 强类型 Sequential/Parallel/Join/Condition Node、
  Checkpointed Execution、Idempotency Key、Replay Inspection 和 Manual Gate。

- [ ] `P3-03` **Scheduler/Automation。** 持久 Timer、Wakeup、Recurring Job、Missed-run
  Policy、Owner Permission 和可观测执行历史。

- [ ] `P3-04` **远程执行。** 显式 Remote Platform Interface、Workspace Sync/内容寻址、
  Policy/Capability Attestation；受限远端不可意外回退为本地 Full Access。

## 持续发布门禁

- [ ] `REL-01` 每次变更在 Linux 对整个 Workspace 执行 Fmt、`check --all-targets`、Test、
  Clippy `-D warnings`。
- [ ] `REL-02` macOS 原生 CI，覆盖 Sandbox/PTY/FS 集成测试。
- [ ] `REL-03` SSE、JSONL Crash Tail、Event Lifecycle、Tool-call Assembly、Path Resolve、
  Schema Input 的 Property/Fuzz Test。
- [ ] `REL-04` 每个 Durability Barrier 和 Tool Side-effect Boundary 的 Fault Injection。
- [ ] `REL-05` TTFT Overhead、Event Throughput、JSONL Growth、Tool Scheduling、Long Context、
  PTY Scrollback、Web Extraction Benchmark。
- [ ] `REL-06` Semver/API Audit：Non-exhaustive Extensible Type、Builder、Deprecation Window、
  Changelog、Reproducible Lockfile、SBOM、License、Signed Artifact。
- [ ] `REL-07` Security Regression：Symlink Race、Sandbox Escape、Process Descendant、SSRF/
  Rebinding、Credential Leak、Approval Fail-open、Log Corruption、Cross-owner Access。
