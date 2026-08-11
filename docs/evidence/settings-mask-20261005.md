# 设置遮罩尺寸不统一：定位、修复及回归

> 本文是 10 月 5 日的历史收据；版本、分支、指纹和“尚未完成”均指当日状态。10 月 6 日已将源码修复迁入最新 master 基线并重新生成、回归，见 [当前 PR 集成证据](settings-mask-pr-20261006.md)。本目录的旧指纹不代表当前候选的全部产物。

日期：2026-10-05。基线提交：`564f5277c1e97f0ecd7e02f10c70e1af60ac741a`。
修复位于 `fix/settings-mask-scope-20261005` 分支；源码、生成 UI 和测试指纹见 [SHA256SUMS](settings-mask/SHA256SUMS)。

## 明确根因

Profile 与 Archived chats 的页面 CSS 使用 `[role="dialog"]:has(...)` 设置 1040px／1180px 宽度，本意是扩大内容卡片。原生 `DialogSurface` 现在由**全屏外层 dialog**承担该 role，因此这两条规则实际缩窄了外层 dialog 及其内部遮罩；内容卡片反而仍为 800px。原生 `::backdrop` 为透明，无法补上右侧露出的背景。

只切换到 Profile 或归档页即可稳定复现，**不需要窗口缩放**。General、Models、Display & shortcuts 使用相同外壳，但不命中这两条规则。

此前本地调查仅对 General 做隔离缩放对照，原生观察期间又有同时切页，因此不能把异常归咎于 WebKit／Tauri resize 或遮罩颜色不同。本次多页面 A/B 已纠正这一不完整推断；保留旧调查作为过程记录，不将旧阴性结果作为全设置页正常的证明。

## 修复范围

- `SettingsRoot.tsx` 为**内层内容卡片**提供稳定的 `data-xh-settings-panel` 标记。
- Profile／Tasks CSS 将宽度选择器限定到该标记；外层 dialog 和 mask 始终覆盖全视口。
- 普通卡片仍为 800px，Profile 为 1040px，归档页为 1180px；窄窗口按既有规则保留边距及内部滚动。
- 不修改遮罩颜色／模糊、不取消原生模态、不调整 Rust／Tauri 窗口链路；不修改业务数据、模型配置或权限。
- 更新生产 `ui/dist`、中文规范与 TODO，将新增浏览器用例接入现有 CI。

## 旧版与修复版几何对照

系统 WKWebView，视口 1280×820。旧资源只读来自已安装 XHarness 0.2.34；修复资源来自本分支 `ui/dist`。均使用隔离 `fixture=1`，不连接用户 Host。

| 页面 | 旧版 dialog／mask 宽度 | 修复后 dialog／mask 宽度 | 旧版卡片宽度／x | 修复后卡片宽度／x |
| --- | ---: | ---: | --- | --- |
| General | 1280 | 1280 | 800／240 | 800／240 |
| Profile | **1040，少覆盖 240px** | 1280 | 800／120，偏左 | 1040／120，居中 |
| Archived chats | **1180，少覆盖 100px** | 1280 | 800／190，偏左 | 1180／50，居中 |

修复后原生 zoom 到 1470×833，dialog／mask 同步为 1470×833，Profile 卡片为 1040px、x=215，保持居中。切页、普通／动画调整窗口以及 dialog 重开，共 **11 个修复版检查点**全部覆盖视口并居中。原始几何见 [旧资源](settings-mask/native-before.log)、[修复资源](settings-mask/native-after.log)。

## 回归结果与边界

浏览器环境：Playwright 1.61.1；系统原生对照：macOS 26.5（25F71）AppKit + WKWebView。

| 验收 | 结果与收据 |
| --- | --- |
| 修复前完整生产图，Chromium／WebKit | 两引擎均在 Profile 失败：`1040 != 1810`；[Chromium](settings-mask/before-chromium.log)、[WebKit](settings-mask/before-webkit.log) |
| 修复后完整生产图，Chromium／WebKit | **各 50 个场景通过**：两主题 × 5 宽度（1810、1280、960、640、426）× 5 设置页；每页右侧边缘点击关闭／重开、遮罩颜色与模糊一致、无页面异常；[Chromium](settings-mask/after-chromium.log)、[WebKit](settings-mask/after-webkit.log) |
| 系统 WKWebView A/B | 旧版两个页面复现；修复后 11 个覆盖／居中检查点通过；[验证器](settings-mask/verify-native.py) |
| Profile／Tasks 源码功能 | 两引擎均通过，含统计切换、归档恢复／确认／失败与清理；[收据](settings-mask/section-functional.log) |
| 原有页面优先级 Chromium | 通过；[收据](settings-mask/page-priority-chromium.log) |
| 原有页面优先级 WebKit | **未通过**：Tab 焦点断言失败；修改前后同样失败，不能宣称全部回归全绿；[基线](settings-mask/page-priority-webkit-before.log)、[修复后](settings-mask/page-priority-webkit-after.log) |
| TS 严格检查／生成物一致性／Profile 插件检查 | 通过；[typecheck](settings-mask/typecheck.log)、[check:build](settings-mask/check-build.log)、[插件检查](settings-mask/profile-plugin.log) |

截图均为合成 fixture 数据，已目视检查，没有设置保存失败提示：

- [深色 Profile](settings-mask/webkit-dark-Profile.png)
- [浅色归档](settings-mask/webkit-light-Archived-chats.png)
- [浅色 Profile](settings-mask/webkit-light-Profile.png)
- [深色归档](settings-mask/webkit-dark-Archived-chats.png)

## 复验方式

仓库根目录执行；`UI_TEST_DEPS` 指向现有隔离 Playwright 依赖目录。本次为 `/tmp/xharness-pr224-ci-analysis/ci-browser-deps`。

```sh
npm run typecheck --prefix ui
npm run check:build --prefix ui
UI_TEST_BROWSER=chromium node scripts/test-settings-mask-browser.mjs
UI_TEST_BROWSER=webkit node scripts/test-settings-mask-browser.mjs
python3 -B docs/evidence/settings-mask/verify-native.py
```

macOS 可使用 [隔离原生驱动](settings-mask/MaskProbe.swift) 与 [本地只读资源服务](settings-mask/run-native.py) 复验，不加载真实聊天数据：

```sh
python3 -B docs/evidence/settings-mask/run-native.py ui/dist /tmp/settings-mask-native.log
```

原生程序只在临时窗口使用非持久 WKWebView，通过 127.0.0.1 临时端口加载 UI；测试结束关闭窗口及服务。Swift 用于 AppKit 诊断，**没有执行任何本机 Rust 编译／检查／测试**。

## 尚未完成

- 原有 WebKit Tab 焦点失败独立跟踪；本次不放宽该断言或混入无关焦点改造。
- GitHub CI 尚未运行本候选，未创建／合并 PR，未发布安装包。
- **未替换已安装 XHarness 0.2.34**，未重启 Host 或部署 3082。上述原生 A/B 证明资源修复，不等于完成真实 Tauri 安装包升级验收；用户当前软件需后续更新才能带入修复。
