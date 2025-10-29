# Web 服务承载层规范

**Crate：** `xharness-server`
**状态：** 物理传输层已实现并连接基础业务 Backend；部署信任策略尚未完成。

## 路由

- `POST /api/<RpcMethod>`：接收 `ClientRequest`，返回 `ServerResponse`。
- `POST /api/respond`：接收 `ClientResponse`，返回 `RpcReceipt`。
- `GET /api/events.mux`：升级为 Mux WebSocket。
- `GET /api/events.host`：升级为 Host WebSocket。
- `GET|HEAD /api/session.export?sessionId=...`：下载 Backend 提供的 Session；带
  Content-Type 和附件文件名。Session 不存在返回 404，其他导出失败返回 500。
- 其他非 API 路径可以从配置的 Web dist 目录提供静态文件，并用 `index.html` 作为
  SPA fallback。

## Unary HTTP 语义

POST 只接受 `application/json`，否则返回 415。畸形 JSON 是传输层 400；未知方法路径
是 404。JSON 信封合法但结构错误，或 path/method 不匹配时，HTTP 仍返回 200，内部返回
带关联 ID 的 `bad-request` 业务结果。其他业务失败也保持 HTTP 200。请求体默认上限
160 MiB，与上游图片信封策略保持一致。

请求 Future 持有取消令牌；传输 Future 被 drop 时令牌必须取消。业务实现必须把取消
传递到 Agent、Provider 和存储操作。

## WebSocket 语义

两条 Socket 都只允许服务端向浏览器下行。每个文本帧必须是一个完整
`ServerRequest`。Ping/Pong 只属于传输控制。浏览器发送 Text/Binary 业务数据属于
协议错误，应关闭连接；上行 RPC 和回答全部使用 HTTP。事件流结束后关闭 Socket。
断线重连和历史基线恢复属于客户端/Agent Backend。

Provider 的 Context 400、Sandbox Unavailable 和 Tool Failure 都是已经接受 Prompt 后产生的
Agent 业务事件，传输层禁止把它们伪装成本路由的 HTTP 400。反过来，畸形 JSON/Content-Type
仍只属于传输错误，两类错误必须可诊断地区分。

## 静态资源与生命周期

`web_router` 可以挂载已经构建好的 Web dist，客户端路由 fallback 到 dist 的
`index.html`。`serve` 接收调用方创建的 TCP listener 和 shutdown Future；关闭必须是
graceful，并等待活跃连接收尾。

## 当前限制

- 尚无 Host/Origin/DNS-rebinding 防线和远程认证；完成前生产组合必须只绑定 loopback。
- 尚无 TLS、压缩、缓存头、CSP 或静态资源嵌入配置。
- 通用信封之外的 API body 目前由业务适配器手工校验，还不是从上游 TypeScript 生成。

## 验收标准

测试必须 POST 全部 52 个方法，验证 method/path 不匹配和传输状态边界，覆盖
`/api/respond`，证明两条 WebSocket 路径存在，完成真实 WebSocket 握手并收到正确的
`server-request`，拒绝浏览器上行业务帧，并覆盖成功和不存在两种 Session 导出路径。

发布级断线测试必须位于真实 Web 与 Host 之间的可中断 TCP Carrier 上。Carrier 恢复后客户端必须
重新完成双 WebSocket + `host.describe` 握手并重新拉取运行时基线。测试至少跨过 retry #8，防止把
有限重试次数、旧连接 Generation 或仅恢复静态页面误判为“自动重连”。
