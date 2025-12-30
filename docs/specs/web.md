# Web Runtime 规范

**Crate：** `xharness-web`
**状态：** Fetch Runtime 和可插拔 Search 已实现；内置 Exa Adapter。

## Search 契约

`SearchProvider` 必须显式注入并具有稳定 Provider ID。未配置时 Search 必须返回
`SearchUnavailable`；Runtime 禁止伪造本地搜索或暗中选择凭据。Query 不能为空。结果数
默认 8，并限制在 1–20。归一化结果包含 Title、URL、Snippet 和可选 Publish Date。

Host 已知没有 Search Provider 时，下一模型请求不应继续投影 `web_search`；`web_fetch` 是否
可用独立判断。动态移除工具不改变 Registry 中的稳定定义，也不得把 Search 凭据写进 Prompt。

## Fetch 契约

Fetch 接收一个最长 2048 Byte 的匿名 HTTP(S) URL。禁止发送 Cookie、环境 Authorization
或 Host Credential。Redirect 手工处理，默认最多 5 次，只允许相同 Scheme/Host/Port
Origin；跨 Origin Redirect 返回结构化拒绝。

每次 Fetch Hop 前必须检查 DNS 结果；除非显式 `allow_private_networks`，否则拒绝 Local/
Private/Reserved Address。IPv4-mapped IPv6 必须应用 IPv4 Policy。只支持 Text/HTML；HTML
转换成 Markdown，Script/Style 不作为活跃内容暴露。

默认预算：30 秒、5 MiB Wire Bytes、**8,000 个模型可见字符**。Wire Content 超限直接拒绝；
但 Wire 上限不能直接当成模型上下文预算。HTML 在 Markdown 转换前必须移除 Script、Style、
NoScript、Template、SVG、Canvas 和 IFrame 等高噪声区域，再执行确定性的
`reader-extractive/v1` 分块、去重和相关性排序。`web_fetch.focus` 可选，只参与本地段落排名，
不会发送给目标网站，也不会触发第二次模型调用。

`FetchResponse` 必须报告 `bytes_read`、规范化 Reader Source 的 `source_chars`、实际返回的
`extracted_chars`、`summary_strategy` 和 `truncated`。摘要超过预算时优先保留标题、章节、表格/
列表、页面前部及命中 Focus 的段落，并附稳定的选段统计；禁止把 100 KiB JavaScript、导航或
整页动态状态直接写回模型。非 2xx 状态是结构化 `FetchResponse`，不一定是 Transport Error。

## 取消与错误

Cancellation 必须中断 Search/Fetch，并返回 Cancellation Error。非法 URL/Scheme、Private
Target、DNS、Redirect、Content Type、Size、Timeout、Provider、Transport 等失败必须可区分。

## 当前限制

- DNS 校验结果与实际连接地址尚未加密绑定；DNS Rebinding 加固列为 P0。
- 当前是确定性抽取式 Reader Summary，不做生成式改写；复杂站点的主正文识别仍不是完整
  Article/Readability Engine。
- 尚无带登录态 Browser、JavaScript 执行、Robots Policy、Download/Blob Store、Citation
  Object Model 或 Search Cache。
- 内置 Search Adapter 目前只有 Exa。

## 验收标准

测试必须覆盖显式 Provider 要求、结果归一化、同 Origin Redirect、Private Target 拒绝、
有界 HTML-to-Markdown、Script/Style 去除、Focus 选段、8,000 字符上限、Content Limit、
Cancellation 以及 Mapped/Private Address 分类。
