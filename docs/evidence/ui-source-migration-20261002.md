# 全量前端源码迁移：最终验收记录

## 固定范围

- 行为基线：已合并 `master` 的 `a613970c78a36a024de56100078323df25b96004`。
- 52 个原有 ModuleLoader 模块、平台与四个桌面脚本改为本仓库 TS/TSX 源码；另有 1 个内部 Plugin API helper。
- 保留 ModuleLoader、Host 协议、持久化键、Tauri 加载路径及当前主分支已合并功能；不带入未合并的 Local/Cloud Runtime 或插件目录 WIP。
- `ui/reference/master-a613970/` 是独立、固定 Hash 的旧实现，只用于差分测试，生产构建禁止读取。
- canonical `ui/dist` 已用整图构建替换并通过源文件新鲜度检查。未替换正在运行的软件、未重启 Host、未部署、未发布安装包。

## 根 Agent 独立复跑

| 门禁 | 结果 | 证明范围 |
| --- | --- | --- |
| 真实 SDK 严格编译、AST/TypeChecker、Builder、Plugin API、桌面脚本和冻结基线 | 115 / 115 通过 | 自有闭包拒绝显式/推断 `any`、普通/双重/非空断言和抑制指令；真实第三方源码、版本、许可及 Hash 固定 |
| 干净隔离完整构建 | 15 / 15 通过 | 无 dist、reference、legacy、外部仓库和历史补丁链；离线锁定依赖、重复字节一致、错误/损坏输入保留旧产物、源码修改进入新字节 |
| 整张实际应用图启动 | source/frozen × Chromium/WebKit，4 / 4 通过 | 真正的 Core/Loader/React 单例、全部模块注册；首次页面、Providers、模型/思考强度/上下文入口及 High→Off 操作 |
| 整图首帧图片 | 两引擎各一对，字节一致 | Chromium SHA `07dd3bb9e5c17bc837326e05f07b2a5eb8a5892f7605c5e9c62bdfc2f561f2d0`；WebKit SHA `87fc4d930435ae3e5efb447615db69d97dd39c0a379bf845960abc9236c01583` |
| canonical Node 页面/交互门禁 | 60 个入口最终通过 | 首次 58/60，修复 Message Edit 与 Compact 的旧测试提取器后，最后整轮 59/60；剩余 BrandHeadline 的旧路径 fixture 修复并单独通过，原断言未删 |
| 原生 Host wire → TS 解码 | WZU_Server 上 Plugin wire 和 Goal remotes 各 1 个 Rust 集成测试通过，真实 JSON 解码通过 | Plugin：13 个原生响应、11 个 UI 端点、2 个错误；Goal：6 个真实 HTTP 响应；网络安装仅使用一个明确标记的 serde DTO fixture，不声称公网安装验收 |
| Unix 更新验收隔离器 | 43 / 43 通过 | 旧/新编译器的精确单一 timer anchor；缺失/重复 anchor 拒绝，不修改生产更新器 |

根最终机器收据：[全量门禁](ui-source-final-gates-master-a613970.json)。其中 canonical 浏览器原入口最终 55/55：首次 46/55，九个旧提取器/patch fixture 失败修正后分别重跑通过；保留首次失败而不覆盖。附件、编辑、checkpoint、directory/audit 的新增实际平台 A/B 另见域收据。

完整标准域收据见：

- [平台](platform-source-master-a613970.md)、[Foundation](foundation-source-master-a613970.md)
- [Views](views-source-master-a613970.md)、[Conversation](conversation-source-master-a613970.md)
- [Plugin wire](plugin-wire-master-a613970.md)、[审批浏览器矩阵](approval-source-master-a613970.json)

各域的机器收据保留源码/产物/日志 Hash、source/frozen、浏览器及断言计数。首次失败不是通过项；修复后的独立复跑与首次失败分别留痕。

## 发现并修复的真实兼容问题

- AtomicHistory 恢复本地 stable business data 复用、Location 重绑定及失败事务回滚。
- Core Slot 的原始 label thunk / inject 契约；Runner 不用分别内联的类 `instanceof` 判断服务身份。
- Commands 注册阶段不提前读取尚未注入的 remote；实际 dispatch 才验证使用的方法。
- Cordis 卡片沿用旧 expanded/source 存储键与 callId，虚拟列表重挂载保留独立展开状态。最终补查还发现 Computer 卡片漏接相同 bridge，现已复用现有 adapter 恢复 `computer:` + callId 的持久展开座位；不是另建一套状态 Map。
- 完整 Layout workspace pane、scrim、dock/native 控制器、恢复和尺寸/位置边界与原实现一致。
- 删除迁移 helper 对未合并插件目录端点/字段的猜测；未知接口保持原拒绝，不能伪造成功。

测试迁移仅替换旧压缩器变量/区域和 `index-*` 假设为 actual artifact + 测试期 AST scope；不新增生产私有 exports。残缺 mock 补成真实已知 Host DTO，而不是降低生产 decoder 或删断言。

## PR CI 首轮与测试入口纠正

[PR #194 的首轮 CI](https://github.com/123123213weqw/x-harness-rs/actions/runs/37015845695) 中，Rust Linux/macOS/Windows、更新契约及额外 GUI/Mirror 门禁通过，但两个 CI job 失败，不能合并：

- Desktop Linux 未安装锁定 TypeScript 工具链，typed Node 测试无法 import；已在该 job 补 `npm ci`，增加覆盖六个 job 的先安装后测试回归，6/6 通过。
- Context job 的 BrandHeadline 正向补丁 fixture 仍读已移除的 `ui/legacy`；改为独立冻结基线（不是新源码/旧模块混合），标题与幂等原断言通过。
- 另外提前复查 Desktop model-settings 测试，改为实际模块 AST scope 和真实 Cordis service lifecycle，保留原 Rust schema 提取与有效值断言；source/frozen 均通过，desktop 三个 Node 门禁串行通过。
- 测试工具的本机路径使用 `fileURLToPath` 而非 URL.pathname，以支持 Windows 和包含空格的目录。

这次纠正未修改生产 UI 源码或构建产物。首轮失败与更正后复跑日志分别记录；必须等待更正提交的新一轮 CI 真正全绿才能合并。

## 第二轮 CI：独立异步链的正确对照

[第二轮 CI](https://github.com/123123213weqw/x-harness-rs/actions/runs/37018400691) 的 Rust 三平台、Linux Desktop 和更新门禁通过，原 Node 回归继续通过。浏览器矩阵的第一项暴露不稳定的测试总序要求：startup 的 `first_frame` 与 updater 的状态检查没有因果依赖，不应要求二者交错位置相同。内容、链内顺序及 UI 完整一致，但总数组顺序不同导致拒绝。

测试不排序、不删原 UI/确认/取消/注入防护/生命周期断言，也不改生产调度。改为精确比较两个因果链的命令、参数、次数和必要先后关系；真实 RAF/Promise 主动覆盖两种合法交错，保留自然加载方式。Chromium/WebKit 各三轮、三调度、两实现，36/36 实际 DOM cases 通过；14 类坏顺序/错误参数/重复或未知命令及错误 UI/lifecycle trace 必须拒绝。更正前 CI 失败与更正后日志各自保留，仍需下一轮完整 CI 全绿。

## Linux 补充验证的布局文本边界

V100 的 Ubuntu 22.04 / Node 20.20.2 / 已缓存 Playwright 1.59.1 用于补充矩阵，不替代 GitHub 最新 Node 22 / Playwright 验收。预先检查浏览器后补齐缺失的 AVIF/GStreamer 测试库；最初浏览器缺失的预检查失败独立保留，不计为产品通过。

其中 Linux WebKit 的 checkpoint 聚合 `innerText` 在两实现均添加布局尾 LF。单独 source/frozen 诊断完整功能 2/2 通过，outerHTML、summary/body 和 raw innerText 均相同；因此测试改为一个展开 details 加两个内容座位的精确 `textContent`，不 trim 数据，也不改生产。Mac 四组合再跑 4/4 通过；原输入、附件、编辑、reasoning、compact、历史失败、权限、审批及 queue 断言保留。

## 明确限制

- 浏览器使用真实平台/组件/SDK，Host/Tauri/外部响应由隔离 fixture 控制；不读取当前用户对话、不调用付费模型。
- 整图测试不拦截 Core 启动；仅使用既有 `?fixture=1` 和静态路由。WebKit 对不存在的可选 HMR SSE 断连与冻结实现相同，单独记录，其他错误不能忽略。
- 类型 decoder 对部分无效 schema 的拒绝比旧实现更严格，合法值、开放事件的 unknown 边界和历史数据仍保持；不宣称 malformed 输入也逐字等价。
- 不声称内存或性能改善：历史缓存复跑观察到 source heap 高于冻结旧实现，JS 发射/vendor 内联亦影响资源大小。应在独立性能工作中衡量，不能把移除 source map 当作 RSS 降低。
- Windows/macOS/Linux 原生安装包实机、权限/系统 WebView、签名/更新仍为独立验收。
- GitHub CI 必须在实际提交后全部通过才能合并；此记录的本地/远程结果不能代替尚未运行的 PR CI。
