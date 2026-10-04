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

## 补充：左侧消息定位栏与主动上滑分页（同日）

软件与 master 均仍将 MessageRail 放在 right:8px；之前确认的 left:8px 与右工作区展开隐藏
仅留在旧工作目录的未提交文件中，并不包含在本批最初两个提交。正式 MessageRail.css
现已补回该设计，复用 AppFrame 的 data-xhworkspace-open 状态，不新增面板状态或事件。

维护的 message-rail 浏览器回归现在检查相对当前对话左边距 8px、实际消息定位，以及
1500px dock/850px drawer 两种布局的真实工作区打开/关闭；两个标签仅关闭一个仍隐藏，
全部关闭恢复可点击定位，隐藏期间已加载消息数不变。两本机浏览器通过，严格 TS、构建
与生成 UI 一致性通过。补充仅修改 UI/CSS/测试，不替换软件。

历史首次打开已由 Session.open() 自动请求最近 50 条；loadOlder() 保持单页、串行门禁、
代际校验与无进展检测，仍是唯一的数据、错误和恢复所有者。用户确认的是“只见最近一部分”，
不是首屏加载失败；现在复用该接口与原来的可见消息/屏幕内偏移锚点，上滑接近顶部
（最多 240px 或半个视口）自动取一页，手动加载及失败重试继续保留。

`HistoryPageIntent` 只拥有 UI 请求准入：同步锁在 RPC/React 发布前生效；一次上滑意图
最多准入一页。分页完成、消息到达、窗口测高及被动位置变化不会继续排空历史；下滑、
消息定位、整轮展开与回到底部取消未花费的旧意图。Promise 成功、拒绝、旧同步 provider
无操作都释放锁；ready/error/busy/EOF/following 检查与原 Session 串行门禁并存。
生产 apply 不再丢掉 loadOlder() 的 Promise，slot 保持旧同步 provider 的源码兼容。
不新增 tool，不改变 RPC、历史格式、PAGE_MESSAGES、缓存容量及窗口化策略。

实际 ChatView 验收覆盖：刷新只开 50 条尾部、不自动请求早页；上滑近顶部自动加载；
连续输入及手动/自动重试共享单飞；请求期间继续阅读，安装 50 条早页后保持同一消息
及偏移（误差不超过 2px）；到达不续请求；网络失败不进入自动重试环，按钮仍可重试；
EOF 不继续请求。完整 shell 的消息定位测试使用真实 native wheel 自动分页，不再点击
Load earlier 代替自动入口，并检查生产 apply 的接线、左侧位置和工作区显隐。

首次打开仍只加载最近 50 条；内存中的视图切换保留锚点，但整个页面刷新不持久化已经
载入的早页范围。这是按需分页，不是全历史自动下载，也没有删除或压缩聊天内容。

原生 WebKit 首个 wheel 用例曾在只等定位栏出现时超时；现等待首次 open 和实际尾部
稳定（有截止时间），而非固定 sleep、强制点击或重试至绿。最终 native 自动分页测试
连续三次通过。Linux 较早 WebKit 将末尾装饰 SVG 序列化为 innerText 的换行；完整 footer
文本比较仅 trim 首尾空白，仍精确校验完整文字和时长、全部终态/折叠/锚点断言，修正后
Linux 回归通过。该修正不改产品内容，也不吞掉未知错误文本。

另一次 Linux（Playwright 1.59.1）完整 fold 验收在选区/焦点保护后的 live-summary 可见等待
出现 10s 超时；没有将它归因于新分页或凭猜测修改产品算法。用例新增真实高度、焦点和
Range 诊断，随后三次完整 fold 用例通过，但这不证明异常已消失。保留失败输出和
`UI-LINUX-FOLD-FLAKE-01` 待查，不增加 timeout、重试包装或删除断言。

本补充实际新源码在 V100 上的 class/ChatView 自动分页、生产 shell 左侧栏及默认/缺
overflowAnchor 的窗口化均通过。远程源码/用例 SHA256 与本机一致；本机 Playwright
1.61.1 与 CI 相同，V100 额外覆盖 1.59.1 的实际 Linux WebKit，不将它伪称为同版本 CI。

本补充最终全量重跑：原 56 条门禁均退出 0（568 Node reporter passes / 0 failed /
0 skipped，另 5 项 Python 架构测试）；加上 scroll memory/fork/gate 九项，共 577 Node
passes。Chromium/WebKit 的 ChatView 分页/消息定位、默认/缺属性窗口化、完整折叠及
84 个真实终态 DOM 窗口全部通过。Rust 源码在本补充未修改，沿用前述远程 Rust 验收，
没有本机 Rust 编译；完整 Linux 额外矩阵仍包含上述待查超时，不能称作全部稳定。

- `/tmp/xh-rail-history-native-paging-20261004.log`：三次完整 native 自动分页/左侧栏验收。
- `/tmp/xh-rail-history-local-regression-20261004.log`：本补充全量门禁与两浏览器输出。
- `/tmp/xh-rail-history-linux-final-20261004.log`：最终源码 SHA256、四项 gate 回归、实际
  Linux 分页/左侧栏/两种窗口化通过及 fold 超时原文（非全绿）。
- `/tmp/xh-rail-history-linux-turn-process-20261004.log`：修正换行后完整 42 终态窗口通过。
- `/tmp/xh-rail-history-linux-fold-stability-20261004.log`：带失败诊断后的三次完整 fold
  用例通过，不替代失败记录。

### 推送前主分支集成复验

以上补充分页提交为 `073c4c0`。推送前主分支新合入 #218（`03b067b`，AI 代审），
通过 `ebf8120` 合并源代码：保留其审批字段、权限项及配对投影，三处生成元数据冲突
只经完整源码组装解决，不用 ours/theirs 的旧 dist 覆盖组合源码。

- 组合源码严格 TS、53 模块/165 资源构建与一致性检查通过。
- gate/scroll/fork、完整 Conversation、Compact/Retry 差分、历史回滚共 34 Node 测试
  通过，权限选择直接断言通过；Chromium/WebKit 的自动分页、左侧定位/工作区显隐、
  上游审批卡片及整轮/工具折叠重新通过，另含 84 个真实终态 DOM 窗口。
- 重新同步合并源码至 WZU_Server 后，根 workspace fmt、all-targets test、Clippy
  `-D warnings` 均通过：未过滤 harness 1156 passed / 15 ignored / 0 failed，另 4 次
  子进程过滤探针通过（1160 次通过执行）。Rust 编译全在远程，不使用本机 Rust 构建。
- 完整输出：`/tmp/xh-rail-history-master-integrated-ui-20261004.log`、
  `/tmp/xh-rail-history-master-integrated-rust-20261004.log`。

这些是开发验收证据，不打进产品安装包。GitHub 当前 PR 跨平台 CI 必须另行全绿才能合并；
不以 Linux 根 Workspace 回归替代 Windows/macOS 原生 cfg 测试和安装包验收。
