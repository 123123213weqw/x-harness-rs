# 页面优先级修复验收（2026-10-03）

## 范围与产物

基于 `d705aa6` 的独立分支 `fix/ui-page-priority-20261003`。只修改自有 TS 前端，不改 Host、模型请求、Profile 格式、桌面安装包或正在运行的 3082 服务；不覆盖整轮折叠和工具参数的其他修复分支。提交后发现 #195 已合入 `master`（`6010a59`），将其合并到本修复分支；仅三个生成元数据文件冲突，保留双方源码并重建产物，而非选择某一侧的旧 dist。

- 生产整图：53 个模块、154 个资产，全部从仓库源码构建。
- `ui/dist/asset-manifest.json` SHA-256：`74fa87ec9607fd9ae7f0e6f91bc866f7d421a50c90cb6d1de2df229094b33efa`。
- `DialogSurface.tsx` SHA-256：`2239055c5be8a496de10384f954e04001e8a2100594fcc2e032d70ff657cd540`。
- 页面优先级回归脚本的历史版本 Hash 保存在各轮日志；最终版本包含等待 WebKit 原生 cancel 完成的生命周期同步。

## 四项问题与修复

| 问题 | 修复 | 验证 |
| --- | --- | --- |
| 菜单 Esc 同时关闭设置 | 菜单消费 Esc；原生 dialog cancel 只关闭顶层，并阻止 React Portal 祖先冒泡 | 菜单先关闭、设置保留；嵌套 Modal 只关闭内层 |
| 设置 Tab 跳到背景 | 原生顶层令背景 inert，补齐正反向 Tab 边界循环，关闭后恢复打开按钮焦点 | 连续 Tab／Shift+Tab、焦点恢复与重复开关 |
| 窄屏表单与聊天框被挤压 | 设置导航移到顶部横向滚动；侧栏展开为覆盖抽屉，仍只预留 56px 控制轨 | 426×664 表单可用；输入框展开前后宽度不变；遮罩可点击关闭 |
| 折叠的设置图标无名称 | 隐藏但不从可访问树移除本地化标签 | 控制轨中的 Settings 可按名称定位并打开 |

## 浏览器矩阵

在 WZU_Server 使用隔离测试依赖 Playwright **1.61.1**（与当前 CI 一致）、Node **20.20.2**。Chromium revision 1228，WebKit revision 2311。实际源码和产物 Hash 与本机一致。首次完整矩阵日志对应合并 #195 前的产物 `40075f0…`；顶部 Hash 是最终合并后产物，后续集成矩阵另行保存。

以下入口 Chromium／WebKit 均通过：

1. `test-page-priority-browser.mjs`：真实整图 + fixture transport；嵌套确认另外使用实际平台 Modal/Menu 导出，避免伪造可删除提供方。
2. `test-owned-ui-boot-browser.mjs`：53 个插件加载、模型选择与设置；无页面异常、无静态资产失败。
3. `test-settings-save-feedback-browser.mjs`：保存失败提示处于模态层，保留输入焦点及中英文提示。
4. `test-plugin-center-browser.mjs`：侧栏导航、插件中心与返回聊天。
5. `test-browser-dock-native-browser.mjs`：真实平台／Runtime 的原生窗体桥接模拟回归；不是桌面安装验收。
6. `test-platform-source-browser.mjs`：冻结主分支与源码数学、Shiki、ABI、SlotCore；每个引擎 12 组布局／像素结果完全一致。仅排除新增原生模态运输层的 DOM wrapper，卡片及其他节点仍完整比较，两侧统一焦点状态，未修改冻结基线。

完整输出：[浏览器](page-priority/browser.log)、[平台差分](page-priority/platform.log)。WebKit fixture 中 HMR `/plugins/events` 的可选连接取消已单列；静态资产失败仍为零，不作为生产网络结论。

修复提交 `1e1ff4a` 在 WZU_Server 独立 Node **22.14.0** 完整复跑通过：owned type policy **23/23**、基础模块 **123/123**、布局 **3/3**，共 **149/149**，严格类型检查通过；[完整输出](page-priority/node22.log)。未改全局 Node 或注入 Polyfill。最终产物 `npm run check:build --prefix ui` 通过。所有 Rust 编译禁令保持不变，本次没有执行 Rust 编译。

![WebKit 窄屏设置](page-priority/webkit-narrow-settings.png)

## 合入最新 main 后的复验

保留 #195 的源码并重建后，确定性构建再次通过。独立 Node 22.14.0 + Playwright 1.61.1 下，两引擎再次通过页面优先级和真实整图启动，并验证 #195 的两条主链路：

- 更新器 14 项 Node 测试及滚动跟随 helper 回归通过。
- Chromium／WebKit 各 24 个真实 sticky composer／updater／shell 层级场景通过；未调用安装或重启。
- 两引擎实际 ChatView 滚轮、微小向上阅读、resize／append 竞态、键盘／触摸／滚动条、返回底部及 compact 回归通过。
- Rail 测试同时等待 frame 几何和实际 slot 里的 Open sidebar／唯一 New session 控件，避免异步 concession 尚未发布时抢点旧宽侧栏控件；未放松功能断言。

[完整合并后输出](page-priority/merged-main.log)包含合入 #195 时的产物和脚本 Hash，区别于首次矩阵日志；以下 CI 复验修复进一步重建了布局模块。

## PR #199 首次 CI 的抽屉回归修复

GitHub CI `37081635914` 的 Rust 三平台、Tauri Linux、更新渠道门禁通过，但浏览器回归发现本次新加的显式网格列位置使右侧绝对定位抽屉仍以 0px 轨道为包含块，按钮落到视口外或被遮罩挡住。相同规则也会把侧栏抽屉的百分比最大宽度限制在 56px 轨道内。未绕过红色检查合并。

仅对覆盖抽屉恢复 `grid-area:auto`，令其以整个 Frame 定位；停靠模式仍固定列。增加 700px 右侧抽屉宽度、右边界及真实命中测试，以及 426px 侧栏至少 240px 宽度断言。WZU_Server Node 22.14.0／Playwright 1.61.1 的 Chromium、WebKit 上，source 和 legacy 四组 browser dock 均通过。

补测首次遇到 WebKit 原生 cancel 在 key-up 返回之后才提交的断言竞态，改为等待内层隐藏，再检查唯一外层、焦点恢复和无异常，不放松结果断言。两引擎页面优先级与各 12 组冻结／源码平台几何和像素再次通过。保留[初次日志（包含该竞态）](page-priority/drawer-initial.log)及[最终复验日志](page-priority/drawer-followup.log)。最终产物构建一致性及严格 TS 检查通过，GitHub 全量门禁继续重新执行。

扩大远程完整浏览器链路后发现目录选择器的内嵌新建文件夹 Esc 只停止冒泡，原生默认 cancel 仍会误关外层。补 `preventDefault`，并在原有浏览器测试中新增表单关闭后工作区选择器仍可见的断言。Chromium／WebKit × source／legacy 四组目录回归通过，保留全部原始断言、真实平台和 Runtime，见[完整日志](page-priority/directory-native-escape.log)。重新构建并通过严格类型及构建一致性检查。旧 CI `37085222009` 在等待期间由本任务主动取消，避免已知缺陷继续占用 runner；不算作通过。

## 侧栏会话操作回归修复

窄屏会话行的省略号按钮原本在 Frame 捕获阶段被当成导航，按钮自身的 `stopPropagation` 来不及阻止侧栏收起、行和菜单卸载。关闭抽屉改为冒泡阶段处理：会话导航先执行，行内操作和 Portal 菜单保留既有事件隔离；插件中心的捕获处理不变。

新增 `test-sidebar-row-actions-browser.mjs` 验证窄屏 Rename／Fork／Archive 菜单可见、Escape 仅关菜单并恢复触发按钮焦点、Enter 打开菜单、重命名弹窗可取消、普通会话导航关闭抽屉，以及宽屏菜单。重建前的生产 dist 在“操作必须保留抽屉”断言失败，重建后两引擎通过；测试纳入 CI。

保留 `6a11976` 的抽屉定位修复，并合入已合并 #198 的 master `1c2e465`；TODO 两段和双方源码均保留，生成图由合并后的源码重建。严格 TypeScript 和确定性构建校验通过。WZU_Server Node **20.20.2**、Playwright **1.61.1** 上，Chromium／WebKit 各通过会话操作、页面优先级、浏览器工作区三组回归；本机也通过两引擎会话操作。[完整输出](page-priority/row-actions-followup.log)。GitHub 完整门禁仍需单独通过。

目录 Esc 修复推送前，远端同一分支已新增 `13c1882`（侧栏行操作及 #198）。本次不强推覆盖；合并双方代码与验收段落，冲突仅限中文证据和生成元数据，重新从完整源码构建，保留 `bf3ab1a` 的目录修复。合并产物严格 TS 与构建一致性再次通过；浏览器集成门禁继续复验。

## 边界

上述页面操作使用隔离 fixture，不调用真实 Host、不删用户数据、不提交真实模型请求。额外的 Node 20 基础模块复跑为 121/123：两个冻结 timer 用例缺少 `Promise.withResolvers`（当前 CI 要求 Node 22），不是本次 UI 的失败。保留 [诊断输出](page-priority/node20.log)，未给生产代码或测试注入 Polyfill。首次浏览器测试工具发现共享 Playwright 已升级但相应 WebKit 未安装，改为独立固定 1.61.1 后重新执行上述矩阵；初次验收脚本误假设 fixture 提供方可删除、以及 resize 尚未结算的时序问题也已纠正，未通过关闭断言绕过。

桌面原生 WebView、安装包和运行中服务仍需合并／部署后的独立验收，`UI-PRIORITY-RELEASE-01` 保持未完成。
