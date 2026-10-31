# 长历史性能、单任务恢复与侧栏页面保活

## 范围

本次是三个增量能力，不替换 Host、会话日志或原生浏览器授权体系。没有引入通用 MCP Apps guest 宿主，也不改变上下文 token 估算/压缩算法。

## 1. 长历史流式渲染

- `ChatNodeStore.structureVersion` 只在节点种类、可见性、位置、锚点等结构元数据变化时递增；全文替换始终失效。
- `ChatFlow` 记忆化整个键控结构列表。正文/状态更新仍通过节点自己的订阅渲染，不为每一帧重新构建全部历史 JSX。
- 结构版本为可选字段；旧插件未提供时保留原有保守失效路径。
- 原有窗口化、工具等待固定挂载、滚动锚点、过程折叠和完整数据保留继续生效。不截断日志，也不把进行中的工具折叠成已完成。
- 这不是整个流式链路 O(1) 的承诺；节点选择器、时间线元数据等仍有独立成本。

### 性能门禁

`test-turn-process-browser.mjs` 使用实际源码编译的 ChatView、节点存储及窗口行，在 Chromium 和 WebKit 检查：

| 历史轮数 | 结构行数 | 连续流式帧 | 完整结构列表重建 | 实测重型挂载行 |
| --- | --- | --- | --- | --- |
| 2,000 | 4,002 | 120 | 0 | 15 |
| 5,000 | 10,002 | 120 | 0 | 15 |

门禁要求重型挂载少于 100 行、结构版本不变、末帧正文可见、历史行数完整。测量的是确定性结构/挂载指标，不宣称跨机器绝对耗时提升。

## 2. 显式单任务恢复

入口：会话标题栏「恢复任务」，或输入 `/reload`，均无参数/附件。

### 安全边界

1. Host 先完成已有关闭状态对账，再取得该会话的输入准入锁。
2. Host 投影必须空闲、队列为空，运行时必须明确观察到 Idle。正在执行、结果未知、能力不支持时明确拒绝。
3. 运行时持有本会话输入准入，向已有 durable actor 发送 `RestartIdle`。actor 自己再次验证没有未结束的 turn；活动循环直接返回 Busy。
4. supervisor join 前一 worker、释放旧 reservation，保持 activation/订阅身份，创建新 generation。只有新 worker 初始化并发布 Ready 后才回 ACK。
5. 有意替换不唤醒 durable 输入，也不重放待处理 compact；用户需另外显式发起后续动作。
6. Host 同步权威状态，写入现有 CommandRun/CommandDone 成功回执。UI 只有成功回执与完整历史重同步均完成才显示恢复成功/清除旧错误；历史读取期间出现的新错误按 generation 保留（即使错误文本相同）。

不重启 Host，不改变其他会话，不清除历史或草稿，不自动重发 prompt/tool，不把未知结果宣称为成功。运行状态继续由原日志/driver 发布者维护；恢复不会额外发送一条伪造的 idle 去覆盖已经开始的新回合。10 秒内没有完成会返回明确错误；这不证明后台操作被撤销，重试前应刷新状态。

**V1 不提供强制终止活跃/卡住工具的恢复。** 请先用现有停止操作等待结束，并处理排队输入；结果仍未知时拒绝恢复。未实现该能力的 AgentRuntime 默认失败，不回退成全局重启。并发命令不保证合并为一次成功回执。

### 覆盖

- actor 连续三次替换：generation 递增，历史不变，原 durable 输入不被唤醒；显式下一输入只执行一次。
- 另一正在生成的会话 generation/流不变；对活动会话自身恢复返回 Busy，不取消它。
- 实际 DurableLoopAgentRuntime：只替换目标 worker，不回收会话工具，不改历史。
- Host：非法参数、忙碌、未知观察、Ready 失败不生成成功回执；等待 Ready 不阻塞另一会话读历史。
- 前端：双击锁、错误可见、切换会话/unmount 后迟到结果隔离、草稿不变、失败不清旧错误、不重发 prompt。

## 3. 有界侧栏页面保活

只缓存**已访问**的文件预览和已完成模型打开握手的浏览器页面的 renderer 子树：

- 全部会话共用最多 **4 个**页面席位；隐藏满 **5 分钟**回收，采用最近访问淘汰。
- 可见页面不因 TTL 回收；从可见变隐藏时才开始计时。显式关闭或删除原 item 立即卸载。
- 文件页切换/收起后保留缩放、源码/预览、对象 URL 和 iframe 状态；卸载/刷新/换文件依然中止读取、释放对象 URL。
- `(owner session, item id)` 是身份。后台读取完成更新原 owner，不把结果发到当前会话；已关闭的 tab 不会被迟到更新复活。
- 隐藏页同时使用 hidden、aria-hidden、inert 和 display:none，不能获焦或被点击。
- 工具详情不参加缓存。未完成的模型浏览器打开握手只在可见时挂载；隐藏立即按原契约取消/清理。握手完成时保持同一子树，避免反复挂载影响原生 lease。

**renderer 保活不等于后台浏览器控制授权。** 原生 WebView 的可见性/owner/origin 授权仍由原生命周期管理；隐藏停止租约和可见性绑定，不新增后台操作权限。原生 guest 生命周期仍由原生 tab 管理，renderer 的 4 页/5 分钟预算不宣称限制所有原生 WebView 数量或销毁它们。

因此，这一改动减少切换重载，但不能直接解决“模型操控网页时必须保持可见”的现有授权要求。

### 覆盖

- 纯规划测试：访问才挂载、跨会话同 ID 隔离、长时间可见后计时、精确过期、LRU、显式关闭、工具/临时打开排除。
- Chromium/WebKit 实际 WorkspacePane：输入状态与挂载次数保留、后台完成归属、不可交互隐藏、5 分钟实际卸载、最多 4 席位。
- 全 owned UI 文件预览：Markdown/数学/相对图片、图片缩放与同 URL 复用、切换保留、显式关闭 blob 清理、PDF 生命周期、HTML sandbox 无外联。
- 继续执行已有浏览器布局、原生生命周期、模型握手与 transcript 窗口化回归。原生 macOS/Windows 完整壳构建由相应 CI 门禁覆盖，不把 headless mock 结果当作真实平台验收。

## 验证命令

Rust 只在同步当前源码后的 `WZU_Server:~/codex-build/x-harness-rs/` 执行：

```sh
cargo test --locked -p xharness-agent -p xharness-host
cargo clippy --locked -p xharness-agent -p xharness-host --all-targets -- -D warnings
```

本地可执行 `cargo fmt --all -- --check`、UI 源码严格编译、上述 Node 测试以及 Python 架构/冻结变异测试（Python >= 3.10）。新恢复边界继承现有 unsafe 与可恢复错误门禁；提交前在远程隔离副本运行实际 Clippy 编译器负例变异，并验证恢复后的正例。替换启动失败再重试的验收还确保 no-replay 屏障持续到新 worker 真正 Ready。

本次验证与最终源码摘要绑定见 [validation.json](../evidence/session-resilience-20261031/validation.json)。
