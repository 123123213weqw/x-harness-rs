# XHarness Web UI

The Web and Tauri product share the same versioned static UI. All product
modules, the module platform and desktop bridges now build from source in this
repository. No sibling checkout or external upstream directory is required.
The ModuleLoader ABI, Host protocol, storage keys and Tauri loading scheme are
unchanged; the independent reference freezes merged master `a613970` for tests.

## Layout

- `src/modules/`: product-owned TS/TSX modules and platform sources. Genuine
  third-party source packages are retained under verified `vendor/` roots with
  their licenses and provenance, not rewritten as product code.
- `src/plugin-api/`: checked Plugin Center RPC DTOs and decoders.
- `src/desktop/`: desktop/startup/titlebar/updater/brand bridges compiled from TS.
- `modules.json`: the sole production module and static asset input manifest.
- `package.json` / `package-lock.json`: locked **build-only** Node toolchain.
  End users still run the packaged Rust Host and browser/WebView, not npm.
- `dist/`: generated, tracked deployable assets, including the dependency graph,
  HTML preloads, resource hashes, platform chunks and product modules. Refresh
  this directory with source changes; never hand-edit generated bundles.
- `reference/master-a613970/`: immutable test-only old UI. Production builders
  reject `reference` and `dist` as source inputs, including symlink aliases.
- `source-vendors.json` / `platform-npm-provenance.json`: verified package/source
  versions and hashes. The pinned xterm executable/CSS/license are static assets,
  not an untyped product module.
- `overrides/`: declared icons and styles remain static inputs; old replacement
  components and string-patch scripts are not executed by source assembly.

Product ModuleLoader IDs use the `@xharness/` and `@xlang/` namespaces directly.
Original third-party source maps retain their exact provenance. `__DSH_BOOT__`
and `--dsw-*` are preserved protocol/design-system keys, not visible branding.
See repository `THIRD_PARTY_NOTICES.md` for license attribution.

## Build and verification

```bash
# repository inputs only; no external directory argument
bash scripts/rebuild-ui.sh
npm run typecheck --prefix ui
npm run check:build --prefix ui
npm run check:plugin-api --prefix ui
node --test scripts/test-owned-ui-type-policy.mjs scripts/test-source-module-builder.mjs
node --test scripts/test-standalone-ui-build.mjs
```

`assemble-static-ui.mjs` checks the complete admitted source closure against
real SDKs, builds module dependencies and assets, then atomically replaces
`dist/`. Failed compilation or missing input does not destroy the previous
artifact. Repeat builds from identical locked inputs must be byte-identical.
The same strict source guard rejects explicit/inferred `any`, ordinary/non-null
assertions and TypeScript suppressions; literal `as const`, import aliases and
`satisfies` are allowed. Pinned third-party originals are verified separately.

Commit source, manifest, lockfile, graph, HTML and generated assets together.
CI also runs the actual platform/Core and old/new Chromium + WebKit regressions.
These are fixture and protocol acceptance, not claims that every native OS,
external account or real-model workload was exercised.

## Workspace directory browser (Web / Windows / macOS / Linux)

`src/modules/directory/index.tsx` fills both existing
workspace directory-flow slots. The sidebar Add workspace button and the
new-conversation workspace picker can browse existing folders or create one
child folder, then open it using the shared workspace service. Paths, including
Windows drive letters/UNC paths, are resolved by the Rust Host, not joined in
JavaScript. Browsing acts on the Host filesystem (not a remote browser's disk).

The repository module manifest explicitly includes this capability. Rebuild
the shared artifact after changing it:

```bash
npm run build --prefix ui
node scripts/test-workspace-directory.mjs
# UI_TEST_DEPS contains Playwright; UI_TEST_BROWSER=chromium or webkit.
node scripts/test-workspace-directory-browser.mjs
```

Commit source, shipped plugin, graph and HTML together. CI checks both slot
owners in the shipped browser UI, plus the Windows NSIS/macOS app payloads.
Opening an existing workspace reuses its registration; cancelling the browser
does not create a workspace. A folder already explicitly created remains on
disk if the user subsequently cancels opening it. No existing files are deleted.

The picker starts at **Drives and locations**, with one-click shortcuts for the
host's Windows drive letters, Home, or `/` on POSIX (`/Volumes` on macOS too).
`host.listDirectory` with an explicit empty path returns this virtual overview
using the existing response shape; omitted path still lists Home. The overview
cannot be opened as a workspace or used as a folder-creation parent. Assigned
but unavailable drives remain selectable and report errors only when opened.

Both picker entry points remember the last successful path in session storage
for the current window and origin, with an in-memory fallback when storage is
blocked. This is not cross-device or durable across desktop port changes.
An unavailable remembered path falls back to the overview; hosts without the
overview extension fall back to Home. Typed paths, including UNC paths, remain
available. Clicking Drives and locations refreshes attached drive letters.

## Embedded desktop browser

`apps/desktop/src-tauri/src/browser.rs` owns independent Tauri child WebViews
for HTTP(S) pages. `src/modules/layout/workspace-pane.tsx` owns placement and tabs; the browser
plugin only controls URL/navigation and reports page events. The desktop
capability is scoped to the `main` **WebView**, not the whole window, so visited
pages cannot invoke Host/updater IPC. Native browser storage uses a dedicated
`browser-webviews` directory; tab URLs/titles are persisted per conversation in
the app config directory (not the Host's changing loopback origin), but page
bodies are not saved. At most 16 native views stay live; older hidden views are
suspended and recreated from their URL when selected. Downloads go to the OS Downloads directory with
unique filenames. Popups become workspace browser tabs. Closing a tab closes
its native WebView; switching chats hides it without losing page state.

The browser plugin uses one serialized visibility coordinator for bounds,
activation, and navigation. Pane popovers and shell modals both suppress native
views; visibility is rechecked after every native await so stale resize/tab
operations cannot resurface a page over an overlay. Blank tabs stay native-hidden.
Chat shortcuts target the existing `data-composer-seat` / `data-composer-card`
textarea contracts. Terminal shortcuts use `data-xh-terminal-trigger` and
`data-xh-terminal-open`, not localized labels, and never close an already-open
dock. An unavailable target reports an error without closing the browser.

`scripts/sync-browser-ui.mjs` refreshes the checked-in layout, browser and terminal plugins for a
preview; `scripts/assemble-static-ui.mjs` applies the same patch on a fresh UI
build. Both require the source, generated plugin, graph, and HTML to be committed
together. Run `node scripts/test-browser-ui.mjs` plus both Chromium and WebKit
`test-browser-*-browser.mjs` / `test-browser-native-bridge.mjs`. Rust checks and
tests run on the configured remote build server per `AGENTS.md`.

## Context Inspector

产品自有插件 `@xlang/xharness-client-ui-context` 在会话顶部注册第三个
`Context` Tab。源码位于：

```text
ui/plugins/@xlang/xharness-client-ui-context/client.js
```

`scripts/assemble-static-ui.mjs` 会把该插件加入与上游插件相同的模块图，
因此重新构建 DeepSeek Web Shell 时不会丢失此功能。插件直接消费 Rust
后端持久化的 `request/header.input/options` 和 `compaction/summary`，展示
模型实际上下文、Token Budget、工具定义以及压缩前后对比。

快速验证：

```bash
node --check ui/plugins/@xlang/xharness-client-ui-context/client.js
node scripts/test-context-plugin.mjs
node scripts/test-schedule-plugin.mjs
```

## Schedule Catalog

`@xlang/xharness-client-ui-schedule` 选择性迁移上游只读 Schedule 目录组件，
源码位于：

```text
ui/plugins/@xlang/xharness-client-ui-schedule/client.js
```

它不要求 Rust Host 新增专用 RPC 或 projection：组件在浏览器内直接折叠
现有 `schedule/change` 会话事件，并把活动提醒入口注册到会话头部。创建、
删除和提醒交付仍由 Rust Schedule 工具与持久化运行时负责。

## Computer Use 隐私状态

`@xlang/xharness-client-ui-computer` 为 macOS `computer` 工具提供 Web/Tauri 共用的
专用工具卡。系统级操作运行时，页面顶端显示“正在查看屏幕 / 读取界面结构 / 控制
鼠标和键盘”等不可静默隐藏的状态；工具完成后自动清理。切换会话不会提前隐藏仍在
运行的控制状态，并有略长于工具执行上限的 watchdog 防止异常残留。

工具卡只挂载动作、目标、frame 和结果计数，不把完整 AX 树再次渲染进聊天 DOM；
原始输入输出继续通过统一 Inspect 面板查看。刷新产品插件及验证：

```bash
node scripts/sync-computer-ui.mjs
node scripts/test-computer-ui.mjs
UI_TEST_BROWSER=chromium node scripts/test-computer-ui-browser.mjs
UI_TEST_BROWSER=webkit node scripts/test-computer-ui-browser.mjs
```

## 会话模型控制（Web / Tauri 共用）

`ui/overrides/model-controls.js` 将上下文表单接入上游模型菜单的二级页面；思考档位
复用已有菜单，输入区只保留一个模型按钮。复用上游 ModelSelect 与 ModelDirectory。
`scripts/patch-model-controls.mjs` 同时适配客户端的容量字段校验，
重建脚本会自动应用。只修改产品组件时可执行：

```bash
node scripts/patch-model-controls.mjs
node scripts/test-model-controls.mjs
```

必须同时提交更新后的 `ui/dist` 模块、图 revision 和 HTML。软件加载安装包内置资源，
不会随着浏览器目录或 Git 源码更新而自动更新；包内资源一致性由桌面资产测试校验。

## 编辑历史用户消息

会话停止后，点击消息旁的“编辑并重新发送”，可恢复文字和图片到输入框。
已有草稿需要确认；取消编辑恢复原草稿。发送会创建新一轮，不修改或删除旧历史。
图片缺失时需重试、重新添加或主动移除；不会自动丢图发送。刷新可恢复未完成的编辑。
详细语义与边界见 [规范](../docs/specs/message-edit-resend.md)。

## 图片与普通文件

附件按钮支持混合选择、拖拽图片与文件。历史文件卡片可下载或重试；编辑旧消息会恢复
文件引用，不重新上传。上传图片直接交给视觉模型；文件以只读路径提供给工具。
现有 read 工具能够查看工作区图片，不需要另一个 read_image 工具。详见
[统一附件规范](../docs/specs/attachments.md)。

## 黑白灰产品配色

### 上游交互的选择性迁移

`scripts/patch-upstream-ui-experience.mjs` 将 DeepSeek Harness
`dsh-v0.1.7-rc.2` 的纯展示交互移植到现有 XHarness 客户端，不替换 Rust Host
协议：工作步骤的四种展示密度、文件差异的行内/并排视图与同步滚动、
WebFetch URL 入口、模型切换状态，以及“设置 → 显示与快捷键”中的本机快捷键。
迁移后的控件采用下述黑白灰语义色；错误和警告仍使用状态色。

这是**选择性适配而非整个上游 UI 的逐字复制**：现有会话结构没有上游的
process-group / shortcut catalog 协议，因此不会改写历史数据或伪造所有上游
快捷键。展示偏好只保存在当前设备，不影响 Agent 运行与服务端快照。

验证：

```bash
node scripts/test-upstream-ui-experience.mjs
UI_TEST_BROWSER=chromium node scripts/test-upstream-ui-experience-browser.mjs
UI_TEST_BROWSER=webkit node scripts/test-upstream-ui-experience-browser.mjs
```

本功能的产品源码在 `ui/plugins/@xlang/xharness-client-ui-experience/` 与
`ui/overrides/{process-mode-hook,review-diff}.js`，发布时须一并提交生成的
`ui/dist/`、`client-graph.json` 和 `index.html`。独立浏览器 Web UI 与 Tauri
桌面版使用同一静态资源，但已经安装的桌面软件需要重新打包才会出现新版界面。

`ui/overrides/monochrome.css` 统一覆盖上游语义 Token：浅色黑色强调、深色白色强调，
背景与气泡使用中性灰。保留错误、警告、成功色，以及图片与代码高亮，不使用整页灰度滤镜。
执行 `node scripts/patch-monochrome-theme.mjs` 更新静态包；完整重建也会自动应用。
执行 `node scripts/test-monochrome-theme.mjs` 检查幂等注入、资源一致性和主色对比度。
Web 与 Tauri 使用同一资源；已安装的软件须重新打包更新后才能使用新配色。

侧栏和欢迎页使用透明的折叠 X，与桌面图标同一造型但不带图标的黑色方框，
通过 `currentColor` 在浅/深主题下自动反色。源码为 `overrides/FishLogo.tsx` 和 `BrandWordmark.tsx`；现有打包产物
用 `node scripts/patch-brand-mark.mjs` 更新，完整重建直接编译 TSX 源码。
验证：`node scripts/test-logo-gradient.mjs`（沿用 CI 中的历史测试名）。

Logo 透明度高光由 `overrides/logo-motion.css/js` 控制，每 5 秒短暂变化一次，
其余时间静止；不驱动 React 更新，也不使用 JS 帧循环或定时器。页面隐藏时暂停，
减少动态效果时停止动画但保持标志可见。测试 `node scripts/test-logo-motion.mjs`。
侧栏收起时显示 X；展开时 X 缩入、名称接位，不在展开状态并排显示两者。
该过渡复用设计令牌，减少动态效果时直接显示最终状态。

首页光场使用 `overrides/hero-glow.js` 的静态装饰节点和黑白主题中的 radial-gradient，
不再渲染上游蓝色 SVG 模糊光晕。输入框仅增加渐变边缘，保留工作区选择器的虚线状态，
不使用遮挡点击的叠层。支持浅/深色和强制高对比模式。重建通过产品补丁自动应用；
验证 `node scripts/test-silver-surface.mjs`。
