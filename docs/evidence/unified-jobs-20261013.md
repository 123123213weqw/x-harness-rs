# Job 身份、状态协议与 UI 接入验收（2026-10-13）

## 已实现

- 后台进程 ID 增加 Registry generation（UUID v4）；旧 ID、旧 cursor 和旧数字短名不再命中新 producer。
- 新增 producer-neutral v1 Plan/Run DTO；不把触发结束、工具完成或取消请求回执当成执行完成。
- 保留 incomplete / interrupted / failed / cancelled 的不同含义；未知状态 unavailable。
- `job/manage` 统一 owner 范围的 catalog、输出、process cancel_run 与计划控制，复用原生工厂 Registry 和原 Schedule。
- 后台 Bash、job 工具、automation 卡片和工作中心第三个“执行”页共用 JobClient/RunPanel。
- 同连接、同 session 合并请求；断线、退订、隐藏页面停止持续刷新，退订释放 catalog 内容，迟到回包不串到新 scope。
- 运行 ID 放详情、共用主题 Token；狭义 process 卡片不混入其他计划与执行。
- 原工具、原 automation/manage 保持兼容；创建入口未改成新工具，也没有重写主 Loop。

## 源码与完整输出

- 开发分支：`feat/unified-job-runs-20261013`。
- 基线：master `164301a497cea55b9efa7b12330dde314ca05a73`，继承消融实验本地提交 `1928a92d`。
- 规格：[unified-jobs.md](../specs/unified-jobs.md)。
- 源码与生成物哈希：[source-manifest.json](unified-jobs-20261013/source-manifest.json)。
- 最终 Rust 输出：[remote-tests-20261013T041932Z.log](unified-jobs-20261013/remote-tests-20261013T041932Z.log)。
- Node：[node-contracts.log](unified-jobs-20261013/node-contracts.log)、[旧卡片](unified-jobs-20261013/legacy-card.log)、[旧导航](unified-jobs-20261013/legacy-navigation.log)、[CI 分片](unified-jobs-20261013/ci-plan.log)。
- 浏览器：[Chromium](unified-jobs-20261013/browser-chromium.log)、[WebKit](unified-jobs-20261013/browser-webkit.log)。
- 构建：[ui-build.log](unified-jobs-20261013/ui-build.log)。

## 结果

### Rust：WZU_Server / Linux

| 范围 | 通过 | 忽略 |
|---|---:|---:|
| Host 单元与集成 | 318 | 6 |
| Jobs | 16 | 0 |
| Schedule（含 17 项消融回归） | 39 | 0 |
| Coding tools | 35 | 7 |
| Native Host app lib | 95 | 1 |
| **合计** | **503** | **14** |

0 失败；忽略项是既有诊断/真实模型/可选压力场景，不算通过。
`cargo check -p xharness-host-app` 与相关五个 crate 的严格 Clippy（all-targets / -D warnings）通过。
全部 Rust 编译/检查/测试都在远端进行，本机仅格式化。

新增重点回归：generation 与旧 cursor、owner 隔离、真实 NativeFactory 共用 Registry、取消 ack 不是 completed、
未来触发与执行互不误伤、Plan finished 不伪造 Agent 成功或实际开始时间、Rust DTO / TS parser 同一 v1 fixture。

### Node / TS / 浏览器

- 新协议/共享 client：11 项；旧 automation card：12 项；旧 navigation：8 项；CI 分片契约：14 项。**45 项全通过**。
- Chromium / WebKit 各完成共用 process/Agent 面板、控制范围、工具历史不覆盖实际状态、旧 ID、
  HTML 转义、同渲染双击、深/浅色、窄屏、键盘导航与卸载场景。
- 完整严格源码编译，57 modules / 190 assets 构建与全字节一致性检查通过；不是只跑 plugin-api tsc。
- 新 Node 测试和两引擎浏览器测试加入原 CI 分片计划，保留冻结的 290 条覆盖基线。

截图为隔离 fixture，不含个人聊天、真实任务或真实模型请求：
[深色](unified-jobs-20261013/jobs-chromium-dark.png)、[浅色](unified-jobs-20261013/jobs-chromium-light.png)、[WebKit 窄屏](unified-jobs-20261013/jobs-webkit-mobile.png)。

## 验证中处理的构建问题

1. 最初同步过滤 `*credentials*` 误排除了源码 `rpc/credentials.rs`；改为精确排除认证文件。
   Host 的 include_str 规格输入也需要同步，现只排除报告/打包资源，不排除 docs/specs。
2. 共用旧 target 曾读到其他源码版本的 API metadata，报不存在于当前源码的 SessionImport 枚举。
   使用本功能隔离 target，后续仍复用该目录的增量缓存及 Cargo registry 缓存，不改其他任务缓存。
3. 新 CSS 依赖需要旧卡片 fixture 使用与生产一致的 CSS text loader；保留旧生命周期断言，未删测试。

失败尝试日志保留在 evidence 目录；以上问题不冒充产品运行失败，最终验收以最后一轮完整输出为准。

## 明确尚未完成

- **没有部署、重启或替换正在使用的安装版**，没有推送 PR 或运行 GitHub CI。
- 定时 Agent 的按 occurrence 精确取消尚未开放；capability=false，不危险地退化为停止整个会话。
- 进程退出后按原 Registry 窗口保留输出；不承诺 Host 重启后恢复原进程或原 stdout。
- 当前刷新是有界 RPC polling，不是 SSE；没有完成事件→持久化 Inbox 自动唤醒桥。
- catalog 当前有界，未做分页；未测超大历史性能、原生 macOS/Windows 完整应用链路或真实模型选工具 A/B。

下一步：PR 审核/完整 CI、真实安装包接入验收；再按规格增加精确取消、持久化或事件桥，而不是扩大当前补丁的主 Loop 范围。
