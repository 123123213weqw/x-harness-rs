# 独立前端构建

## 目标

仅凭本仓库和锁定的 npm 开发依赖构建前端。不需要另一个源码目录、不读其他项目的
`node_modules`、不调用其他项目的构建、不运行历史字符串补丁链。
保留现有 ModuleLoader、Host 协议和 Tauri 的 `ui/dist` 消费路径。

```sh
npm ci --prefix ui --ignore-scripts
npm run build --prefix ui
npm run check:build --prefix ui
```

`scripts/rebuild-ui.sh` 只是上述安装与构建的无参数包装器。
`scripts/assemble-static-ui.mjs` 的参数仅为 `--out-dir PATH` 和 `--check`；旧的外部目录参数会明确拒绝。
`UPSTREAM_HARNESS_DIR` 不参与构建。

## 输入与产物

- `ui/modules.json`：显式模块、资产、依赖、输入路径与固定基线 SHA-256。
- `ui/src/modules`：52 个 ModuleLoader 入口的自有 TS/TSX/CSS 源码，严格检查后从显式入口和传递依赖构建；包含当前合并主分支的 Browser、Experience。
- `ui/src/plugin-api`：1 个 TS 模块，从源码编译，不依赖缓存的生成 JS。
- `ui/src/modules/platform`：自有 bootstrap、UI primitives、SlotCore 和 typed preload boot；同一构建器生成 ESM 入口、样式和动态分块，不读取旧平台 bundle。
- `ui/reference/master-a613970`：独立冻结的当前主分支 A/B 测试基线。构建器拒绝读取该目录及其链接别名，不能把测试参考当生产源码。
- `ui/plugins`：旧生成缓存不作为生产业务或平台输入。唯一保留的可执行 JS 分发资源为清单明确声明、固定版本及 Hash 的原版 xterm 5.5.0；旧 UI 对照统一读取 `ui/reference`，不提交重复的 `ui/legacy`。
- `ui/source-vendors.json`：锁定的第三方依赖／真实源码树、版本、许可和 Hash；不将第三方代码冒充业务源码。
- `ui/src/desktop`：四个严格检查的桌面启动／标题栏／更新／品牌动效 TS 脚本，打包后保留原来的 URL 和 native command ABI。
- `ui/src/resources`、`ui/overrides`：显式声明的普通资源、样式和图标；不从未合并 WIP 导入额外功能或图标。

生产清单当前有 53 个模块（52 个 source-module + 1 个内部 plugin-api-ts helper）与 14 个非平台资产。
平台编译器另外生成入口、样式、分块、字体等资产；本次独立平台验收观测为 136 个输出文件，
最终数量以完整构建的 manifest 为准。另生成：

- `client-graph.json`、一致的 HTML boot graph；
- 模块的 SHA-256 revision 和 HTML 预加载／资源缓存键；
- `asset-manifest.json`：产物路径、完整 SHA-256 与字节数（不包含自身，避免循环）；
- `.xharness-ui-output.json`：构建器输出所有权标识。

`external` 是代码到达依赖，`inject` 仍是服务说明，两者不混用。
构建器检测缺依赖、清单模块环、重复模块／目标文件、非法路径、逃逸链接、Hash 漂移和错误注册。模块内部的本地 CommonJS 环使用独立缓存保持原有语义，失败工厂不保留半成品。
禁止把 `ui/dist` 当构建输入；因此删除产物后仍可从输入重新生成。

## 失败与发布边界

构建先在临时目录完成，全部校验成功才替换目标。编译失败、输入损坏或不完整时保留上一份产物。
禁止输出到源码目录；自定义目标必须是新目录或本构建器所有的目录，不覆盖任意用户目录。
重复构建的内容 Hash 与字节应一致。npm 依赖仅用于开发，终端用户不需要 TypeScript 或 npm。
UI 文本的 Git checkout 与 TS 编译输出固定为 LF，避免 Windows 的自动换行转换使基线 Hash 漂移。

这次只改变源码和构建方式，不重启 Host、替换桌面软件或发布安装包。测试基线增加的是
仓库体积，不是运行时额外加载一套 UI；安装包仍只消费 `ui/dist`。

## 单一生产构建链

生产清单拒绝 classic-js、旧平台入口及 `frozenOverrides`。自有代码修改进入源码编译；
第三方 React、Markdown、KaTeX、Shiki、Immer、Cordis 等保留真实版本、许可和来源，
不能为通过类型检查修改原库、虚构库签名或把自有业务改名为 vendor。
旧 patch 函数仅可作为兼容行为测试，不在生产构建链执行。

提交与发布以完整构建为准，同时提交输入和 `ui/dist`。`sync-desktop-ui.mjs` 和
`build:plugin-api` 均走整图原子构建；局部脚本不能替代完整构建或改写部分产物掩盖不一致。
CI 先执行 `check:build` 检查已提交产物，再执行构建，防止覆写产物掩盖源码与产物不一致。

## 验收

```sh
node --test scripts/test-standalone-ui-build.mjs
node --test scripts/test-plugin-api.mjs
node --test scripts/test-source-module-builder.mjs
node scripts/test-foundation-source-modules.mjs
node scripts/test-conversation-source.mjs
node scripts/test-product-source-modules.mjs
```

隔离测试只复制所需源码、构建器、显式资产和 npm lock，无 `ui/dist`、无 `ui/legacy`、
无 `ui/reference`、无历史补丁脚本、无外部仓库。
使用先前安装的锁定 npm 缓存执行离线安装，然后构建、重复构建、验证 Hash，注入编译错误、
损坏输入、缺依赖和无效目标，检查上一份产物不变。另验证自有源码修改进入新产物。
浏览器可用 `UI_TEST_DIST` 指向独立生成目录，复用 Chromium/WebKit 的真实模块加载与插件交互回归。
CI 在已有 UI job 执行完整独立构建、一致性检查和隔离测试，再运行现有页面回归，不新增 Rust 编译任务。

## 源码迁移验收原则

- 对比独立冻结旧实现与新源码的公开 ABI、Host 字段、注册／清理、异步竞态和 UI 行为，不使用新构建产物充当自己的黄金基线。
- 老测试中依赖压缩器变量／区域边界的提取方式改为测试专用 AST scope；不增加生产 exports，不切掉函数的真实 import 闭包。
- canonical 产物需先通过严格源码重编字节一致、图 revision 与 HTML preload 检查，再在 Chromium／WebKit 跑原场景。
- 浏览器验收为隔离测试，不访问正在使用的 Host、真实对话或付费模型；不能等同于打包 Windows／macOS 实机验收。
- 当前任务未改变 Host 协议、软件部署或安装包发布；GitHub CI 需提交之后另行确认。

已经完成的独立平台差分证据见 `docs/evidence/platform-source-master-a613970.md`。
完整源码迁移仍以整图严格检查、类型门禁、干净构建和全部行为回归为准；独立平台通过
不表示全部业务模块或桌面打包已经通过。

## 持续验收门禁（不可跳过）

1. 全部实际业务闭包必须使用真实 SDK 严格编译，并清除显式／推断 `any`、普通类型断言、非空断言和抑制指令。外部字段经实际 decoder 后才读取。
2. 持久化、动态服务和开放事件保留旧数据／旧 ABI；不能为了证明类型而丢弃合法历史、换注册身份或偷偷收窄插件能力。
3. 复跑独立平台和全部业务的冻结主分支／源码差分：注册清理、流式、分页、问答、队列、工具、Compact、模型控制及菜单／弹窗叠层。
4. 干净隔离构建、重复构建字节一致、损坏输入保留旧产物、canonical 全套 Node／Chromium／WebKit 门禁通过后再生成提交的 `ui/dist`。
5. Rust Host 真实 wire fixture 在 WZU_Server 执行，源码包含未提交改动；原生 Windows／macOS／Linux 打包实机及发布另行验收。

## 体积口径

整图产物已重建；最新验收见 `docs/evidence/ui-source-migration-20261002.md`。不沿用旧切片的字节数字作为本次结果。
源码发射、vendor 内联和分块策略会影响包大小；移除旧 source map 不表示
WebKit RSS 降低。此阶段首先固定正确性与构建可维护性。
后续共享 vendor、tree shaking 和生产压缩应另做启动／内存 A/B，不能在本次功能迁移中
随意改变 React 单例、schema 身份或公共 ModuleLoader ABI。
