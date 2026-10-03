# 页面优先级修复验收（2026-10-03）

## 范围与产物

基于 `d705aa6` 的独立分支 `fix/ui-page-priority-20261003`。只修改自有 TS 前端，不改 Host、模型请求、Profile 格式、桌面安装包或正在运行的 3082 服务；不覆盖滚动／更新器、整轮折叠和工具参数的其他修复分支。

- 生产整图：53 个模块、154 个资产，全部从仓库源码构建。
- `ui/dist/asset-manifest.json` SHA-256：`40075f0d17e91edb9f9ed2a725c7d7705f7ba4323862bff987c5bcdf4ba070fe`。
- `DialogSurface.tsx` SHA-256：`2239055c5be8a496de10384f954e04001e8a2100594fcc2e032d70ff657cd540`。
- 页面优先级回归脚本 SHA-256：`9754e5ce6bfde1f4e76010d50980deb3fa244132b7b6310e733c2fb6d99731c7`。

## 四项问题与修复

| 问题 | 修复 | 验证 |
| --- | --- | --- |
| 菜单 Esc 同时关闭设置 | 菜单消费 Esc；原生 dialog cancel 只关闭顶层，并阻止 React Portal 祖先冒泡 | 菜单先关闭、设置保留；嵌套 Modal 只关闭内层 |
| 设置 Tab 跳到背景 | 原生顶层令背景 inert，补齐正反向 Tab 边界循环，关闭后恢复打开按钮焦点 | 连续 Tab／Shift+Tab、焦点恢复与重复开关 |
| 窄屏表单与聊天框被挤压 | 设置导航移到顶部横向滚动；侧栏展开为覆盖抽屉，仍只预留 56px 控制轨 | 426×664 表单可用；输入框展开前后宽度不变；遮罩可点击关闭 |
| 折叠的设置图标无名称 | 隐藏但不从可访问树移除本地化标签 | 控制轨中的 Settings 可按名称定位并打开 |

## 浏览器矩阵

在 WZU_Server 使用隔离测试依赖 Playwright **1.61.1**（与当前 CI 一致）、Node **20.20.2**。Chromium revision 1228，WebKit revision 2311。实际源码和产物 Hash 与本机一致。

以下入口 Chromium／WebKit 均通过：

1. `test-page-priority-browser.mjs`：真实整图 + fixture transport；嵌套确认另外使用实际平台 Modal/Menu 导出，避免伪造可删除提供方。
2. `test-owned-ui-boot-browser.mjs`：53 个插件加载、模型选择与设置；无页面异常、无静态资产失败。
3. `test-settings-save-feedback-browser.mjs`：保存失败提示处于模态层，保留输入焦点及中英文提示。
4. `test-plugin-center-browser.mjs`：侧栏导航、插件中心与返回聊天。
5. `test-browser-dock-native-browser.mjs`：真实平台／Runtime 的原生窗体桥接模拟回归；不是桌面安装验收。
6. `test-platform-source-browser.mjs`：冻结主分支与源码数学、Shiki、ABI、SlotCore；每个引擎 12 组布局／像素结果完全一致。仅排除新增原生模态运输层的 DOM wrapper，卡片及其他节点仍完整比较，两侧统一焦点状态，未修改冻结基线。

完整输出：[浏览器](page-priority/browser.log)、[平台差分](page-priority/platform.log)。WebKit fixture 中 HMR `/plugins/events` 的可选连接取消已单列；静态资产失败仍为零，不作为生产网络结论。

WZU_Server 独立 Node **22.14.0** 完整复跑通过：owned type policy **23/23**、基础模块 **123/123**、布局 **3/3**，共 **149/149**，严格类型检查通过；[完整输出](page-priority/node22.log)。未改全局 Node 或注入 Polyfill。最终产物 `npm run check:build --prefix ui` 通过。所有 Rust 编译禁令保持不变，本次没有执行 Rust 编译。

![WebKit 窄屏设置](page-priority/webkit-narrow-settings.png)

## 边界

上述页面操作使用隔离 fixture，不调用真实 Host、不删用户数据、不提交真实模型请求。额外的 Node 20 基础模块复跑为 121/123：两个冻结 timer 用例缺少 `Promise.withResolvers`（当前 CI 要求 Node 22），不是本次 UI 的失败。保留 [诊断输出](page-priority/node20.log)，未给生产代码或测试注入 Polyfill。首次浏览器测试工具发现共享 Playwright 已升级但相应 WebKit 未安装，改为独立固定 1.61.1 后重新执行上述矩阵；初次验收脚本误假设 fixture 提供方可删除、以及 resize 尚未结算的时序问题也已纠正，未通过关闭断言绕过。

桌面原生 WebView、安装包和运行中服务仍需合并／部署后的独立验收，`UI-PRIORITY-RELEASE-01` 保持未完成。
