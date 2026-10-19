# Web Runtime specification

**Crate:** `xharness-web`
**Status:** Anonymous fetch and pluggable search are implemented. DeepSeek is the only built-in search adapter.

## Search contract

The model-facing tool remains `web_search(query, limit)` and returns
`{provider, query, results: [{title, url, snippet, published_date?}]}`. The result
limit defaults to 8 and is clamped to 1–20. `SearchProvider` remains the runtime
boundary; it is explicitly injected and never fabricates a local search engine.
Its additive `available()` readiness port defaults to true for existing providers.

### DeepSeek transport

The native Host calls the [DeepSeek Search API](https://api-docs.deepseek.com/api/search/)
at the fixed `https://api.deepseek.com/v1/tools/search` endpoint. Requests contain
only `query`, `count`, and `need_content: false`; no chat history, original user
prompt, auxiliary model call, or selected chat-model credential is sent. Queries
must be nonblank and at most 128 Unicode characters; oversized queries are
rejected rather than silently truncated.

Results retain provider order. Each `snippet` contains the provider's summary,
falling back to its snippet when the summary is blank, capped at 1,000 Unicode
characters. Titles are capped at 500 characters; URLs must be anonymous HTTP(S)
and at most 2,048 bytes. Optional dates are bounded to 64 bytes. Missing/malformed
`results`, invalid rows, and responses larger than 512 KiB fail explicitly; an
empty result array is a valid successful search, not a provider failure.

The adapter shares a connection pool, forbids redirects, uses a 10-second connect
timeout, and bounds the entire call (including response reads and retry waits) to
30 seconds. Cancellation interrupts all those stages. Transport failures and
HTTP 408/429/5xx get at most three total attempts, with bounded backoff and numeric
`Retry-After` respected within the overall deadline. Other HTTP errors fail
without retries. Error bodies are not reflected into tool results or diagnostics.
Search is an independently metered API, not an entitlement to free chat tokens.

### Settings, credentials, and model independence

The durable `web-search-deepseek` namespace accepts only `enabled` (default true)
and `apiKeyEnv` (default `DEEPSEEK_API_KEY`). The existing plugin-settings card
exposes an enable switch and write-only key control; it has no provider selector,
custom endpoint, or per-model search configuration. Settings use the existing
revision-fenced control log; the key uses the native credential store, never the
settings document, receipt, prompt, or diagnostic log. Environment credentials
are read-only in the UI. Finder/Explorer launches retain the existing private
`secrets/DEEPSEEK_API_KEY` loading convention even without `providers.json`.

Each search snapshots current settings and its explicit credential reference,
resolving the environment first, then the OS credential store. The selected chat
model is irrelevant: any tool-capable model can call the same search tool. A
missing key, disabled setting, or invalid configuration hides `web_search` on the
next Agent turn. Already-exposed calls recheck configuration and fail unavailable
when disabled; an already-started request finishes against its original snapshot.
Readiness is local and never probes the network or delays Host Ready with HTTP.

Credential changes emit `credentials/updated`. When no configured model references
a key, native writes touch only the credential store, not model discovery or
registry activation. A shared model/search reference retains registry-aware
validation. Backends that do not support this optional fast path keep the existing
behavior. Literal keys never ride the credential response.

Exa is removed. `EXA_API_KEY` is explicitly rejected as a search reference and is
never silently reinterpreted as a DeepSeek key. Restored legacy display fields
(`baseURL`, `maxUses`, literal `apiKey`) are omitted from the active projection;
the original durable log is not rewritten. Invalid legacy references disable
search rather than selecting a different account. Static schemas are rebuilt on
receipt replay, preserving secret-field validation and exactly-once revision
semantics.

## Fetch contract (unchanged)


Fetch 接收一个最长 2048 Byte 的匿名 HTTP(S) URL。禁止发送 Cookie、环境 Authorization
或 Host Credential。Redirect 手工处理，默认最多 5 次，只允许相同 Scheme/Host/Port
Origin；跨 Origin Redirect 返回结构化拒绝。

每次 Fetch Hop 前必须检查 DNS 结果；除非显式 `allow_private_networks`，否则拒绝 Local/
Private/Reserved Address。IPv4-mapped IPv6 必须应用 IPv4 Policy。只支持 Text/HTML；HTML
转换成 Markdown，Script/Style 不作为活跃内容暴露。

macOS 上 Clash/Surge 一类 TUN 的 Fake-IP DNS 会为公共域名返回 RFC 2544 的
`198.18.0.0/15`。这不能简单加入公共地址白名单：Host 必须对**域名**使用加密公共 DNS 再验证
真实 A/AAAA，随后通过 HTTP Client 的 Resolve Override 把连接固定到已验证地址，同时保留原始
Host/TLS SNI。直接请求 `198.18.0.0/15` IP、公共 DNS 返回私网地址或验证失败仍必须拒绝。
普通公共系统解析同样固定连接地址；每个 Redirect Hop 重新解析、校验和固定，避免 DNS Rebinding。

`web_fetch` 是 Host 内的受控匿名网络能力，不经 `bash`/PTY 的进程沙箱，因此 Workspace-write
与 Danger-full-access 下行为一致。权限预设只改变进程/文件能力，不能关闭 Fetch 的 SSRF 防线；
Workspace-write 下 Bash 网络仍保持隔离。

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

- 当前是确定性抽取式 Reader Summary，不做生成式改写；复杂站点的主正文识别仍不是完整
  Article/Readability Engine。
- 尚无带登录态 Browser、JavaScript 执行、Robots Policy、Download/Blob Store、Citation
  Object Model 或 Search Cache。
- DeepSeek is the only built-in search adapter; the DeepSeek Fetch API is not used. Existing anonymous fetch behavior is unchanged.

## 验收标准

测试必须覆盖显式 Provider 要求、结果归一化、同 Origin Redirect、Private Target 拒绝、
有界 HTML-to-Markdown、Script/Style 去除、Focus 选段、8,000 字符上限、Content Limit、
Cancellation 以及 Mapped/Private Address 分类。
