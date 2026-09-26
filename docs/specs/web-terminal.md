# Web Terminal（`/api/terminal/*`）

Web 产品内嵌的交互式终端面板。对话页头部「终端」按钮或 `Cmd/Ctrl + \`` 开关底部
Dock，可在浏览器里直接使用宿主机 shell，与 agent 共享同一台机器与工作区。

## 契约边界

终端是 XHarness 自有扩展面，**不在** `xharness-api` 冻结的 52 个上游 RPC 方法
目录内。路由实现于独立 crate `xharness-web-terminal`（DTO + `xharness-terminal`
调用 + 环境构造），经 `web_router_full` 的通用扩展插槽合入 `/api`，与其它
`/api` 路由共享同一层 `require_ready`、请求体上限与桌面 Token 鉴权中间件——
`xharness-server` 不因此获得任何新 crate 依赖（架构基线见
`config/architecture-dependencies.json`）。上游契约测试（52 方法精确匹配）不受
影响；`/api/terminal/bogus` 等未知名落到动态路由，返回传输层 404。

所有 Web 终端归属固定 owner `web`（`xharness-web-terminal/src/lib.rs`），与未来
agent 自有终端隔离。会话存活于 Host 进程内：刷新页面后 `terminal.list` 恢复
tab，`terminal.read` 从 cursor 0 重放滚动缓冲。

## 方法（全部 POST，JSON，plain envelope）

| 路由 | 请求 | 响应 |
| --- | --- | --- |
| `/api/terminal/open` | `{name, cols?, rows?, program?, args?, cwd?, env?}` | `{ok, terminal}` |
| `/api/terminal/send` | `{name, input}` | `{ok, written}` |
| `/api/terminal/read` | `{name, cursor?}` | `{ok, read}`，其中 `read.content_base64` 是原始 PTY 字节 |
| `/api/terminal/resize` | `{name, cols, rows}` | `{ok}` |
| `/api/terminal/signal` | `{name, signal}` | `{ok}` |
| `/api/terminal/close` | `{name}` | `{ok, read}` |
| `/api/terminal/list` | `{}` | `{ok, terminals}` |

错误统一为 `{ok:false, error:{code, message}}`；`TerminalError` 到 HTTP 状态的
映射见 `terminal_error`。`open` 省略 `program` 时使用 `$SHELL` → `/bin/bash` →
`/bin/sh`（Windows：`pwsh.exe`）。环境为安全继承子集（`PATH`/`HOME`/`USER`/
`LOGNAME`/`SHELL`/`LANG`/`LC_*`/`TMPDIR`/`COLORTERM`）加请求项，`TERM` 固定
`xterm-256color`；注册表以 `env_clear` 方式派生，所以不能漏带。输入单次上限
256 KiB，`args` 上限 64 个。

## 传输模型：游标轮询，不是推送

`xharness-terminal` 的 `read_raw` 是字节游标式（cursor → Base64 编码的增量字节 + 新 cursor +
运行状态）。前端把字节直接交给 xterm，避免网络分片切开 UTF-8 字符后出现乱码。客户端自适应轮询：活跃 tab 输出活跃期 45ms、空闲 250ms，后台 tab
1.5s；断线退避 0.8s→6.4s 后从原 cursor 续读。选择不加 WS 推送通道的原因：复用
现有 unary 鉴权与请求体上限、零改动冻结的 mux/host 事件流；如延迟不可接受，
后续可在同名方法后加推送通道，客户端无感迁移。关闭 Dock 或卸载页面时停止轮询，
重开后从保存的 cursor 续读。

## 所有权与关闭

`TerminalRegistry` 由 `xharness-host-app` 构造：注册表本体与生命周期归组合根
（符合"原生 OS 组合在 host-app"的分层），HTTP 面由 `xharness-web-terminal`
提供、经 `web_router_full` 的扩展插槽注入。结构化关闭顺序：Agent 退出 →
`runtime.shutdown` → `terminal_registry.shutdown()`，PTY 清理失败记入
`cleanup_errors`。

## 前端

`ui/plugins/@xlang/xharness-client-ui-terminal`：入口在
`conversation.session.header.actions` 槽位；xterm.js 5.5.0 以 vendored UMD
随插件分发（不入模块图，同 `desktop/updater.js` 先例）；每个 tab 持久化自己的
xterm 实例与 DOM 容器，切换 tab 只迁移 DOM 节点以保留滚动回溯；主题色从
`--dsw-alias-*` 设计令牌解析（canvas 归一化为 rgba）。Dock 高度持久化在
`localStorage`。交互模式与主题解析改写自 Apache-2.0 的 zai-org/ZCode 终端面板，
署名见 `THIRD_PARTY_NOTICES.md`。

## 已知边界（2026-09-26 首版）

- Windows 上 `resize` 返回 501（ConPTY 初始尺寸已接通，动态 resize 待
  `xharness-win32` 提供 `ResizePseudoConsole` 句柄）。
- 多浏览器标签页同时打开时共享同一批终端（单 owner），输出会双写渲染。
- 滚动缓冲默认 1 MiB/10k 行，超出后 `truncated_before_cursor` 提示截断。
