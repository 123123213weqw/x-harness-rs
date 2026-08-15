# 已审核 PR 组合验收（2026-10-06）

## 已取得证据

- #245 已合入 master：`5fdf54bbbfad4de187f5d1e87f24b394388b5242`。
- 原 #236 导航 12 项测试未覆盖首次 Host pending；新增离线页面／前后导航、首次列表绑定、主动空白页、断线同会话导航、只读标记重挂载，共 16 项通过。
- Unix 验收 Python 48 项通过：原 prepare 真流程在隔离副本成功；已有依赖保字节、缺依赖幂等补充、版本冲突写前拒绝新增覆盖。
- 前端产品模块 23 项、Conversation 20 项、CI 计划及失败关闭 runner 14 项通过；原冻结参考树未更改。
- Chromium／WebKit Automation 导航通过，Chromium 首次 Host 未连接时插件页面可以打开。
- 四个全量前端契约分片通过，共 86 次独立命令；原 CI 290 次调用保留，新增七次，当前计划共 297 次。
- WZU_Server 的 `cargo test --workspace --locked`：1,239 通过、0 失败、19 忽略；未在本机编译 Rust。
- 设置遮罩 Chromium／WebKit 各 50 场景通过；工具参数生成、Code Review／全局助手和浏览器侧栏组合回归均通过。
- 组合 CI 发现 Workspace 独立 fixture 仍监听旧页面事件、Linux 原生 zero-tab fixture 漏交 root inject 的 navigation。两者改为真实 ShellNavigation／Session 订阅端口，不模拟导航或原生浏览器回执。
- 修复后 Workspace Chromium／WebKit 通过；原生 zero-tab 在 WZU_Server 真实 Tauri／WebKitGTK 上 issue、PR、dynamic、game 四项通过，模型请求为零。
- WebKit 插件确认框关闭测试等待实际 DOM 卸载，再验证没有安装副作用；不依赖 React 同步提交或固定 sleep。
- GUI WebView Python 20 项通过，包含原生 fixture 必须提供 service 和消费 root inject 的回归断言。

## 待汇总

组合全量契约分片、浏览器、远程 workspace Rust、GitHub 原生与 required check 以实际候选 SHA 的最终结果为准；本文不将 fixture 通过冒充原生安装验收或推理性能证明。
