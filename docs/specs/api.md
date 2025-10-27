# Web 线协议规范

**Crate：** `xharness-api`
**状态：** 传输契约已实现；全部业务方法已在 `xharness-host` 中具备基础有状态实现。
**兼容快照：** `deepseek-harness@141eb6fef8`。

## 目标

把浏览器与 Host 的边界冻结下来，使 Rust Agent 内部可以独立演进。现有 DeepSeek
Harness Web 客户端必须能够继续使用自己的原生协议，而后端可以逐个业务域替换。
内部的 Loop、Session、Tool、Provider 类型禁止直接序列化到该边界。

## RPC 方法目录

`RpcMethod::ALL` 必须恰好包含上游 52 个 unary RPC：

- 12 个 `session.*`
- 4 个 `subagent.*`
- 5 个 `host.*`
- 7 个 `workspace.*`
- 1 个 `skill.*`
- 6 个 `agentPreset.*`
- 6 个 `goal.*`
- 5 个 `settings.*`
- 3 个 `credentials.*`
- 3 个 `llm.*`

未知方法字符串不可分发。数组顺序必须与上游 `RpcMethodMap` 完全一致，并通过测试
验证没有重复项。

## 四象限信封

协议包含四种 JSON 消息和一种非消息回执：

```text
ClientRequest  {type:"client-request", rpcId, method, payload}
ServerResponse {type:"server-response", rpcId, result}
ServerRequest  {type:"server-request", rpcId, method, payload}
ClientResponse {type:"client-response", rpcId, result}
RpcReceipt     {accepted:true} | {accepted:false, reason}
```

发起方生成 `rpcId`，响应必须原样回显。`RpcResult` 只能是
`{ok:true,value?}` 或 `{ok:false,error}`。必须校验布尔判别字段，并拒绝同时出现相互
矛盾的 value/error 槽位。

`RpcErrorCode` 与上游封闭错误码集合保持一致。业务失败禁止创造前端 Schema 不接受的
新错误码。

## 下行事件帧

`MuxFrame` 覆盖 Session 事件/订阅、审批、问题、队列、Job、投影和流错误。
`HostFrame` 覆盖 Session 生命周期/状态、Agent 错误、Workspace/Archive 快照、转发的
Host 事件和流错误。序列化时必须把 payload 的 `type` 复制到外层
`ServerRequest.method`。

审批/问题请求使用服务端生成的稳定 RPC ID，以便 `/api/respond` 关联响应。纯推送帧
每次使用新的关联 ID。

## Backend 接口

`ApiBackend` 负责 unary 调用、客户端响应、Session 导出和两条事件流。它接收原始
`rpcId`、解析后的 `RpcMethod`、JSON payload 和取消令牌。保留原始 ID 可以让业务层
把它作为幂等/乐观消息来源，而不是再生成不相关的 ID。

这是兼容分发接口，不是最终业务 API。各业务域应当在不改变线协议形状的前提下，逐步
把手工校验的 payload 迁移成强类型 Request DTO。

## 版本策略

上游客户端和 Host 一起发布，因此没有声明协议版本。Rust Host 与单独更新的 Web dist
没有这个假设，所以代码和测试必须记录精确的上游 Git revision。修改兼容 revision 前，
必须先比较方法名、错误码、Schema 和事件 frame union。

上下文预算、Prompt 注入和动态工具投影是 Rust Runtime 行为，不得为了修复它们随意新增 RPC。
平台 Readiness 优先通过现有 `host.describe`/Host Event 的兼容 payload 投影；若上游封闭 Schema
无法承载，必须先更新兼容快照与双端测试，不能只改 Rust 一侧。

## 当前限制

- 很多业务 payload 仍是手工校验的 `serde_json::Value`，还未生成 Rust DTO。
- 尚无 Rust/TypeScript Schema 自动生成流程。
- 兼容性固定在一个上游 revision，尚无运行时协议协商。

## 验收标准

测试必须验证全部 52 个有序方法、唯一性和解析，验证四象限 JSON、严格的
result/receipt 判别字段、封闭错误码拼写，以及代表性的 Mux/Host 判别字段和
camelCase 字段。
Host 兼容测试还应证明 Context/Sandbox 业务失败以关联 Session 的事件或封闭业务错误呈现，
不会被误写成未知路由或畸形传输。
