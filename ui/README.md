# XHarness Web UI

This directory is the versioned XHarness browser product shipped beside the
Rust Host. It reuses the DeepSeek Harness browser UI under the MIT license,
while replacing all visible DeepSeek branding with XHarness branding. Both the
product-owned sources and the deployable bundle are committed here; a fresh
clone does not need the historical sibling `x-harness` checkout.

## Layout

- `dist/`: deployable static assets. This generated directory is intentionally
  tracked and must be refreshed together with source/plugin changes.
- `dist/plugins/`: the complete, dependency-ordered client plugin graph. The
  generated `index.html` preloads the module-system/runtime bundles and embeds
  `window.__DSH_BOOT__`, so a plain static Rust host can boot the UI without the
  upstream Node-side index transform.
- `dist/client-graph.json`: generated graph metadata for deployment diagnosis.
- `brand/`: the original xLang brand reference supplied for this project.
- `overrides/`: source-level branding replacements used when rebuilding from
  the upstream UI.
- `desktop/updater.js`: Tauri-only updater bridge with separate download and confirmed restart/install. It is injected
  directly into product HTML and intentionally does not join the upstream
  client-module graph.

The existing `@deepseek-ai/dsh-*`, `__DSH_BOOT__`, and CSS token identifiers in
the compiled bundle are protocol/ABI compatibility identifiers. They are not
rendered branding and are intentionally retained until the XHarness daemon
provides its own browser protocol.

For license attribution, see the repository-level `THIRD_PARTY_NOTICES.md`.

## Rebuild and verification

Rebuild against an explicitly selected DeepSeek Harness checkout:

```bash
scripts/rebuild-ui.sh /path/to/deepseek-harness
node scripts/test-context-plugin.mjs
node scripts/test-schedule-plugin.mjs
node scripts/test-desktop-updater.mjs
```

The first command rebuilds the complete upstream Client face, applies XHarness
branding, injects the product plugins into the dependency-ordered client graph,
and writes the result back to `ui/dist/`. Commit `ui/dist/client-graph.json`
and the rebuilt assets with every source-level Web change.

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

## 会话模型控制（Web / Tauri 共用）

`ui/overrides/model-controls.js` 提供显式思考档位和上下文容量入口，复用上游
ModelDirectory。`scripts/patch-model-controls.mjs` 同时适配客户端的容量字段校验，
重建脚本会自动应用。只修改产品组件时可执行：

```bash
node scripts/patch-model-controls.mjs
node scripts/test-model-controls.mjs
```

必须同时提交更新后的 `ui/dist` 模块、图 revision 和 HTML。软件加载安装包内置资源，
不会随着浏览器目录或 Git 源码更新而自动更新；包内资源一致性由桌面资产测试校验。
