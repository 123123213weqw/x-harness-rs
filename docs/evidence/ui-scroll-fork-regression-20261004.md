# 滚动、Fork 网络契约与 Linux WebKit 验收（2026-10-04）

## 范围

- 分支：`refactor/generated-turn-end-contract-20261004`；已同步公开仓库 master `acf74b5`。
- 本批包含此前完成的 turn/end 生成契约，以及本次三个已核实的遗留问题；不是全协议重构完成。
- 不发布、安装、替换或重启桌面/独立 Web；不改变聊天文件、工具执行、模型配置或密钥。

## 修复与边界

### 1. 被动 user/steering 到达不等于本地发送意图

删除 ChatView 按新增用户节点/steering 快照强制到底部的分支。
只有已经跟随底部，或者用户在当前会话明确发送/回到底部，才恢复跟随。

会话内 `ChatScrollMemory` 复用原滚动书签接口，增加可选跟随订阅；InputHub 在真实本地
提交通过空内容/编辑门禁之后、发送 RPC 之前同步通知一次。隐藏视图仅清除该会话旧书签。
用户在 RPC 等待期间重新上滑后，迟到成功、拒绝、持久用户回声和 steering 到达都不能
再次发出跟随意图。一次提交即使之后被拒绝，也不会在异步结算时抢回滚动位置。

订阅按会话隔离并在视图/插件释放时清理，处理重入取消；UI 监听器异常不改变发送是否执行。
明确回到底部同时清除旧分页和折叠锚点，避免旧锚点反向覆盖新的用户意图。

### 2. Fork 不只在创建通知中丢失

生产 host/session-added 和 session.list 两个 decoder 原先都只允许 subagent。
两处现在共用 subagent/fork 来源 schema，旧消息不带 origin 继续兼容；未知/空/错误类型
仍拒绝，不是删除校验或改为任意字符串。

Rust 专用测试实际调用 Host SessionFork/SessionList 并读取 event_gateway 发布：首个用户
消息之前、第二个用户消息之前、最后完成轮之后三种切点。原始 JSON 不手动改写，直接
进入生产 WebApiClient 的 WebSocket 与 HTTP 解码器。还保留空白 fork、父子关系、旧缺省
来源、subagent 和非法来源回归；不使用 FixtureApiClient 绕过网络验证。

### 3. Linux WebKit 不支持 overflow-anchor 时仍需补偿

仅 computed overflowAnchor 明确为 auto 时交由原生锚定；缺属性、空值、none 都使用
现有可见消息及屏幕内偏移补偿。补偿读取 ChatView 实时跟随所有权，不靠当前位置猜测用户
意图，不重新启用底部跟随，也不让支持 auto 的浏览器受到双重补偿。

既有 V100 失败证据 `docs/evidence/ui-source-v100-browser-matrix-20261003.json` 保留；
不修改冻结旧实现，不把旧版矩阵伪装为当时全绿。新增缺属性分支测试还断言该属性确实
为 undefined。真实 Linux WebKit 的展开、锚点、焦点/选区、首挂载和宽度重排重新通过。

## 回归结果

| 门禁 | 本轮结果 |
| --- | --- |
| WZU_Server 根 Workspace `cargo test --locked --workspace --all-targets` | 未过滤 harness 1135 passed / 15 ignored / 0 failed；另有 4 次子进程过滤探针通过，共 1139 次通过执行 |
| 远程 `cargo fmt --all --check` / `cargo clippy --locked --workspace --all-targets -- -D warnings` | 通过 |
| 实际 Rust Fork/Terminal 导出专用测试 | 各 1 passed；不计为额外唯一测试；Terminal 生成物 --check 与新导出一致 |
| 本机原 56 条门禁命令 | 全部退出 0；Node reporter 568 passed / 0 failed / 0 skipped，另含直接断言脚本与 5 项 Python 架构单测 |
| 新增 scroll memory/InputHub 与 fork wire Node 回归 | 5 项通过；InputHub 内含 queue/steer × 成功/拒绝四个异步竞态；本机及 Linux 使用真实 Fork 输出通过 |
| Chromium/WebKit 实际 ChatView | 被动用户/steering、跨会话、本地发送、迟到回声、真实 wheel、键盘、touch、scrollbar、缩高与流式增高通过 |
| Chromium/WebKit 窗口化 | 默认和强制缺 overflowAnchor 均通过；350 行 fixture 首次重节点挂载 0，宽度重排峰值 1，展开/焦点/选区状态保留 |
| V100 真 Linux WebKit | 默认及强制缺属性窗口化、ChatView 意图/测高回归通过；最终分支再次验收 |
| 既有整轮常驻/折叠与消息定位 | 两浏览器通过；7 durable 终态 × live/history × 3 种工具结果，共 84 个真实终态 DOM 窗口 |
| 严格 TS / Plugin API / 干净独立构建 / 已提交 UI 一致性 | 通过；53 模块、165 资源；包括 master 既有 UI 改动，不用旧包覆盖新源码 |

本机与 CI 同为 Playwright 1.61.1 / React 18.3.1；Rust 仅在远程独立目录编译，
执行前同步未提交源码并排除 .git/target/node_modules/.env*/密钥及敏感文件。
没有调用付费模型，这些是协议与 UI 行为回归，不是模型能力实验。

固定 100ms 的首次布局采样在并行负载下曾过早断言，测试改为现有有上限的稳定几何采样，
仍断言相同底部间隙，保留超时和样本诊断；没有强制点击、重试至绿或跳过失败断言。
350 行 DOM/JS 统计不代表实际桌面物理内存或 Windows 原生内存安全证明。

## 完整输出

- `/tmp/xh-leftover-remote-rust-20261004.log`
- `/tmp/xh-leftover-full-node-20261004.log`
- `/tmp/xh-wire-local-regression-20261004.sh`（56 条命令）
- `/tmp/xh-leftover-real-wire-unit-20261004.log`
- `/tmp/xh-leftover-portable-unit-20261004.log`
- `/tmp/xh-leftover-browser-chromium-20261004.log`
- `/tmp/xh-leftover-browser-webkit-20261004.log`
- `/tmp/xh-leftover-final-browser-serial-20261004.log`
- `/tmp/xh-leftover-linux-webkit-20261004.log`
- `/tmp/xh-leftover-final-linux-webkit-20261004.log`
- `/tmp/xh-leftover-final-linux-gestures-20261004.log`
- `/tmp/xh-leftover-fork-wire-20261004.json` / `/tmp/xh-leftover-terminal-final-20261004/`

这些是开发验收证据，不打进产品安装包。GitHub 当前 PR 跨平台 CI 必须另行全绿才能合并；
不以 Linux 根 Workspace 回归替代 Windows/macOS 原生 cfg 测试和安装包验收。
