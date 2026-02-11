# Shared model settings

The native Host installs a `ModelSettingsBackend` implemented by the reusable
host-app library. Tauri and the Web carrier call the same existing RPCs. There
is no PowerShell settings proxy and no desktop-only provider database.

## User workflow

Open Settings → Models → Add custom provider. Enter a unique provider route,
HTTP(S) base URL, supported protocol and model ID(s). The custom-provider form
creates a credential reference; leaving its key empty keeps that route inactive.
Profiles with no `apiKeyEnv` can use local unauthenticated model servers.
Use HTTPS for remote credentialed services.
Chat completions and Responses are supported; other protocols are not advertised.

The Models fetch action contacts the form's endpoint with a 15-second deadline,
does not follow redirects, and returns at most 512 candidates from a bounded
2 MiB OpenAI-style listing. A saved key is not sent to a different draft URL;
enter the key explicitly when testing a changed endpoint. Manual model entry
remains available when an endpoint has no listing API.

Profiles are committed through the existing revisioned Host control store;
credentials are written separately. The client's partial-success retry flow
handles a profile saved before its key. A missing key leaves the provider
configured but inactive. A credential write prepares the replacement registry
before writing the key and activates it only after successful storage.

Successful changes apply to subsequent turns without restarting the App. Active
turns retain their already-bound provider. Removing a model makes future calls
to its old selection unavailable rather than silently routing them elsewhere.
New sessions choose the configured default when available, otherwise the first
available model, and persist that selection.

## State and security

`--providers-file` remains an imported base layer; user changes are persisted in
the selected `--state-dir` control log. Imported profiles cannot be removed via
the custom-provider delete action; removing user overrides restores their base.
Preserved metadata includes exact-model reasoning, upstream model aliases,
capability probes and token budgets. Explicit context limits are recommended.
When no limit is given for a new model, 32768 is an explicitly non-authoritative
fallback; default output reserve is 4096 and safety margin 1024 tokens. These are
budget assumptions, not claims about an endpoint's actual accepted limits.

Only key references (`apiKeyEnv`) enter settings and control receipts. The
production credential store is Windows Credential Manager, macOS Keychain or
Linux Secret Service via keyring 3.6.3. Credential entries are scoped by canonical
state-directory identity. Keep the same state directory across upgrades; copying
the control log to another machine/directory does not copy the keys. There is no
plaintext fallback. Headless Linux deployments can use environment variables or
provide an unlocked Secret Service. Environment/process credentials take priority
and are read-only in the UI.

Keyring feature selection and platform behavior:
https://docs.rs/keyring/3.6.3/keyring/

The RPC trace records parsed/redacted JSON rather than raw request strings and
omits credential-write payloads. Credentials never enter control receipts or
session logs. Invalid configuration, stale revisions and unavailable credential
storage return errors without applying an uncommitted registry.

## Verification

- `node scripts/test-model-settings-ui.mjs`: runs the actual bundled schema
  implementation against the Rust schema; no replica validator.
- `cargo test -p xharness-host-app --test model_settings`: persistence, invalid
  edits, key storage failure and authenticated HTTP model execution; Windows also
  tests actual credential-store persistence/recreation and cleanup.
- `cargo test -p xharness-host-app --test process_model_settings`: real executable,
  HTTP RPCs, native state directory, process restart and exactly-once replay.
- Full workspace tests and platform installer builds run on GitHub CI. Local
  Rust compilation is prohibited by this repository's AGENTS.md.

Production-provider and packaged-UI acceptance must be reported separately from
these deterministic tests. Passing a mock-provider test is not evidence that a
particular user's API account is valid or that a long coding run was completed.

## 会话内模型控制（2026-09-07）

Web 和 Tauri 共用 `ui/dist`，输入区只保留模型选择按钮。点击后在同一菜单提供
「模型」「思考强度」「上下文容量」，各自进入二级页面，不再外置重复按钮。
复用上游 ModelSelect、ModelDirectory、`session.models`、`session.selectModel`；没有新增
桌面专用配置库，也不使用 localStorage 保存选择。

- 思考档位仅来自当前 Provider 的精确模型声明；没有声明就不提供思考菜单，不伪造通用档位。
- 上下文输入是 **Token 整数**。使用后端返回的 `contextWindow` 作为有效上限，展示
  `contextWindowSource`，绝不在前端写死 32K/128K/1M。上限未知时说明原因并禁用保存。
- 保存完整当前选择；修改上下文不改变思考档位，修改思考不改变已选择的上下文。
- 切换模型清除旧表单，使用目标模型的上限和默认思考档位；不把旧模型的软预算带过去。
- 主机持久化后才更新显示；刷新、Host 重连后从主机回读。运行中的请求沿用创建时的配置，
  后续请求使用新设置。把窗口调得过小仍可能触发 Token Budget Guard，不能保证任意小窗口可运行。
- 严格校验正整数、安全整数和上界；返回上级/点外部/Escape 不保存（Escape 先返回上级，再次关闭菜单）。网络错误保留旧值并支持重试，
  过期异步响应和组件卸载不得覆盖新状态。

### 原因与构建约束

此前不仅没有上下文调节控件，上游 client-connection 的解析 Schema 还会丢掉
`contextWindowTokens`、`contextWindow` 和能力来源；仅增按钮无法解决。
`scripts/patch-model-controls.mjs` 为这两处提供失败即中止的构建适配，
`ui/overrides/model-controls.js` 保存产品组件源码。assemble/rebuild 自动应用适配，
生成文件、客户端图 revision 和 HTML 内联图同步更新；不维护伪装最新的 sourcemap。

### 回归入口

- `node scripts/test-model-controls.mjs`：真实打包 Schema、RPC 透传、正负边界、错误和竞争。
- `UI_TEST_DEPS=/path/to/deps UI_TEST_BROWSER=chromium node scripts/test-model-controls-browser.mjs`
- 同一浏览器测试使用 `UI_TEST_BROWSER=webkit` 验证 macOS WebView 同类引擎。
- 远程 Rust：`web_model_catalog_exposes_and_selects_multiple_runtime_routes` 覆盖大小模型切换，
  `permission_command_and_receipt_survive_a_host_restart` 同时验证思考与自定义上下文恢复。
- 桌面打包检查比对模型控件、连接协议、client-graph 和 index.html，防止 App 携带旧 UI。

代码接入、浏览器回归通过不等于已经更新用户安装包；实际安装验收单独记录。
