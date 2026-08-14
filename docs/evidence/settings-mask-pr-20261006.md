# 设置遮罩修复：最新 master 集成回归

日期：2026-10-06。基线：`a3d5c6d93be089eb055888e0f5fc3ee1c217023b`（master，#234 合并提交）。
候选分支：`fix/settings-mask-release-20261006`。
本次本机工具：Node.js 25.9.0、Playwright 1.63.0；不同于历史原生收据的浏览器版本。

## 来源与范围

原修复仅存在于本地 `fix/settings-mask-scope-20261005` 工作区的未提交修改中，没有进入当前已安装的 0.2.36。此次只迁入三个源码文件、回归测试与文档，再用当前 master 的本仓库构建器重新生成 UI；没有复制旧分支的整份产物。

Profile／Archived chats 的宽度规则错误命中外层 `[role="dialog"]`，缩窄了全屏遮罩。修复将规则限定到内层 `[data-xh-settings-panel]`；保持普通卡片 800px、Profile 1040px、归档页 1180px。遮罩颜色／模糊、原生模态、Host 协议与 Rust／Tauri 窗口逻辑均不变。

## 本次真实执行

| 检查 | 结果 | 收据 |
| --- | --- | --- |
| master 原始生产图 + 新布局测试 | Chromium／WebKit 均复现 `Profile dialog covers viewport width: 1040 != 1810`；不是安装／依赖错误 | [Chromium](settings-mask-20261006/before-master-chromium.log)、[WebKit](settings-mask-20261006/before-master-webkit.log) |
| 候选生产图 + 新布局测试 | 每引擎 50 个场景通过；两主题 × 5 窗口宽度 × 5 设置页，每个场景验证完整遮罩、居中卡片、右边缘关闭与重开，无页面异常 | [Chromium](settings-mask-20261006/after-chromium.log)、[WebKit](settings-mask-20261006/after-webkit.log) |
| Profile 功能 | 两引擎通过；统计模式、延迟数据、投影与清理 | [Chromium](settings-mask-20261006/test-profile-source-browser-chromium.log)、[WebKit](settings-mask-20261006/test-profile-source-browser-webkit.log) |
| Tasks 功能 | 两引擎通过；搜索排序、恢复、确认、失败、父子重试与清理 | [Chromium](settings-mask-20261006/test-tasks-source-browser-chromium.log)、[WebKit](settings-mask-20261006/test-tasks-source-browser-webkit.log) |
| 完整 UI 启动 | 两引擎通过；55 模块加载、设置／模型控件、工作中心导航 | [Chromium](settings-mask-20261006/test-owned-ui-boot-browser-chromium.log)、[WebKit](settings-mask-20261006/test-owned-ui-boot-browser-webkit.log) |
| 模块／插件检查 | 74 个 source／legacy 模块测试通过；Profile 插件检查通过 | [模块](settings-mask-20261006/view-source-modules.log)、[插件](settings-mask-20261006/profile-plugin.log) |
| 严格 TS／构建／生成物一致性 | 通过；55 模块、190 资源；依赖来自本仓库锁文件 | [typecheck](settings-mask-20261006/typecheck.log)、[build](settings-mask-20261006/build.log)、[check:build](settings-mask-20261006/check-build.log) |
| 原有页面优先级 | Chromium 通过；本机 WebKit **未通过** Tab 焦点断言，master 原始产物和候选同样失败，不删除／放宽断言 | [Chromium](settings-mask-20261006/test-page-priority-browser-chromium.log)、[master WebKit](settings-mask-20261006/page-priority-master-webkit.log)、[候选 WebKit](settings-mask-20261006/test-page-priority-browser-webkit.log) |

所有浏览器测试使用隔离 fixture、实际平台模块和生产静态图，不读取真实聊天、不写设置、不请求模型。截图已目视检查：

- [当前深色 Profile](settings-mask-20261006/webkit-dark-Profile.png)
- [当前浅色归档](settings-mask-20261006/webkit-light-Archived-chats.png)

## 原生证据与发布边界

此前系统 WKWebView 的 11 个几何／zoom／重开检查点来自 [10 月 5 日独立资源 A/B](settings-mask-20261005.md)。本次只再次验证该历史收据的结构和断言：[验证日志](settings-mask-20261006/verify-historical-native.log)，**不是再次运行原生窗口，也不是当前 Tauri 安装包验收**。

本次没有执行本机 Rust 编译／检查／测试。没有替换 XHarness.app、重启 Host、部署 3082、合并或发布版本。GitHub CI 结果以 PR 检查为准，不能由这些本地通过项推定全部 CI 已通过。

## 重复执行

仓库根目录，`UI_TEST_DEPS` 指向隔离 Playwright 依赖目录：

```sh
npm ci --prefix ui --ignore-scripts
npm run typecheck --prefix ui
npm run build --prefix ui
npm run check:build --prefix ui
UI_TEST_BROWSER=chromium node scripts/test-settings-mask-browser.mjs
UI_TEST_BROWSER=webkit node scripts/test-settings-mask-browser.mjs
```

新增布局测试已接入 CI 的 Chromium／WebKit 实浏览器步骤。本次源码、产物与收据指纹见 [SHA256SUMS](settings-mask-20261006/SHA256SUMS)。
