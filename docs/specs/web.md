# Web Runtime 规范

**Crate：** `xharness-web`
**状态：** Fetch Runtime 和可插拔 Search 已实现；内置 Exa Adapter。

## Search 契约

`SearchProvider` 必须显式注入并具有稳定 Provider ID。未配置时 Search 必须返回
`SearchUnavailable`；Runtime 禁止伪造本地搜索或暗中选择凭据。Query 不能为空。结果数
默认 8，并限制在 1–20。归一化结果包含 Title、URL、Snippet 和可选 Publish Date。

## Fetch 契约

Fetch 接收一个最长 2048 Byte 的匿名 HTTP(S) URL。禁止发送 Cookie、环境 Authorization
或 Host Credential。Redirect 手工处理，默认最多 5 次，只允许相同 Scheme/Host/Port
Origin；跨 Origin Redirect 返回结构化拒绝。

每次 Fetch Hop 前必须检查 DNS 结果；除非显式 `allow_private_networks`，否则拒绝 Local/
Private/Reserved Address。IPv4-mapped IPv6 必须应用 IPv4 Policy。只支持 Text/HTML；HTML
转换成 Markdown，Script/Style 不作为活跃内容暴露。

默认预算：30 秒、5 MiB Wire Bytes、100,000 个解码字符。Wire Content 超限直接拒绝；
Decoded Text 截断必须报告。非 2xx 状态是结构化 `FetchResponse`，不一定是 Transport Error。

## 取消与错误

Cancellation 必须中断 Search/Fetch，并返回 Cancellation Error。非法 URL/Scheme、Private
Target、DNS、Redirect、Content Type、Size、Timeout、Provider、Transport 等失败必须可区分。

## 当前限制

- DNS 校验结果与实际连接地址尚未加密绑定；DNS Rebinding 加固列为 P0。
- HTML 转换确定，但不是完整 Article/Readability Engine。
- 尚无带登录态 Browser、JavaScript 执行、Robots Policy、Download/Blob Store、Citation
  Object Model 或 Search Cache。
- 内置 Search Adapter 目前只有 Exa。

## 验收标准

测试必须覆盖显式 Provider 要求、结果归一化、同 Origin Redirect、Private Target 拒绝、
有界 HTML-to-Markdown、Content Limit、Cancellation 以及 Mapped/Private Address 分类。
