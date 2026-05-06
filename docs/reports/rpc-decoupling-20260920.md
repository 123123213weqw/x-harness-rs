# Host RPC 全量解耦验收（2026-09-20）

## 结果

源代码阶段已完成：固定 RPC 契约、8 个纯 Processor、统一 EventGateway、Session/Turn Facade，以及
Commands、Host、Interaction、Export、Dynamic 兼容适配器均已分层。`rpc.rs` 不再包含
`impl BasicHost` 领域 Handler；源码门禁会阻止该结构回流。

## 可回滚提交

- `c647379`：冻结 52 个固定 RPC 的类型契约；
- `ab289f4` ～ `8bd0f4d`：Workspace、Settings、Preset、Credential、Model、Subagent、Goal Processor；
- `999ccfe`：统一 EventGateway；
- `e2d5369`：Session、Lifecycle 与 Turn 适配器；
- `e024fd7`：总 Dispatcher 收口为 Transport，并拆出 Commands/Host/Interaction/Export/Dynamic。

## 远程回归证据

- EventGateway full：`20260920T124851Z-8bd0f4d0a329-dirty`，12/12；
- Session/Turn full：`20260920T130611Z-999ccfee7c9e-dirty`，12/12；
- Dispatcher 收口 full：`20260920T131350Z-e2d5369fd2bc-dirty`，12/12；
- Wire 收口 quick：`20260920T131716Z-e024fd732319-dirty`，10/10。
- 最终全量验收：`20260920T131845Z-e024fd732319-dirty`，12/12（含 Workspace 全测试与
  Clippy `-D warnings`）。

所有 Rust 编译、测试与 Clippy 都在 `WZU_Server` 执行；本机只运行 `cargo fmt`。尚未推送分支，
因此 GitHub 的 Windows/macOS/Linux 跨平台 CI 与合并门禁仍保持未完成状态。
