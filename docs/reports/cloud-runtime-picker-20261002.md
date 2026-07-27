# 执行环境入口验收（2026-10-02）

> 历史证据：本文描述旧实验工作区的 JS UI 验收。2026-10-03 云端基础 PR 仅移植后端与实验脚本，不包含旧 UI 补丁/生成包；最新 owned TS 前端迁移和真实云端路由仍待验收。

## 交付范围

- 新任务工作区选择前新增环境选择器，复用 Client Slot/Locale/主题/原图标。
- 本机是唯一可路由项；统一 Cloud 选项禁用且说明待接入，不展示机器名称，不伪装为真实环境目录。
- 菜单始终可展开查看（复用 Client Menu），不可选原因在菜单内展示。可信空会话可选本机（cold/open）；旧/运行/加载/失败/未知会话保持原环境，不再禁用查看入口。
- 产品源码、会话 Slot 补丁、静态生成包、revision/HTML graph 和重建脚本一致；新测试已加入 CI 工作流，尚未运行 GitHub CI。
- 本机 3083 只更新受影响静态资源，原服务 PID 60774 未重启，修改前备份保存在忽略的设计证据目录。没有替换桌面 App、修改模型配置、启动 VM 或模型请求。

## 回归

六组 Node 套件通过：Runtime Environment、UI Namespace、Workspace Directory、Context Plugin、Model Controls、Upstream UI Experience。新增套件覆盖 216 个会话状态组合、双语、缺省锁定、伪造 DOM change 不路由、cloud 禁用、Slot/样式清理、图/hash、一致性/幂等、上游签名漂移与坏 manifest 写入前拒绝。

浏览器实际使用当前产品生成包与独立空数据 Host（临时 3084），不是 React/目录服务模拟：新任务下选择器可展开，Down/Return 不能选择禁用的云端，仍为 local；原工作区菜单正常展开。验收后关闭临时页及 Host，确认 3084 不再监听。

原 3083 的预览会话历史加载状态为 error。初版禁用了整个选择框，导致用户不能展开；本次修正为菜单可查看、选项保持锁定，并在菜单内解释历史未能确认。未将其冒充新任务、未修改数据来使测试通过。

本机没有执行任何 Rust 编译命令。此批仅 UI/构建脚本修改，复用了已有远程构建的 Host 产物作独立预览，不把 Node 回归宣称为新的 Rust/跨平台 CI 验收。

## 证据

- 忽略目录 `dist/regression/runtime-picker-20261002/`：六组完整测试输出。
- 忽略目录 `dist/design/runtime-picker-20261002/`：真实新任务/3083 截图与 DOM 状态观察。
- 忽略目录 `dist/design/cloud-ui-20261002/before-runtime-picker/`：受影响的旧静态文件。

仍待：真实环境目录、RuntimeConnection/Gateway、按环境选择目录、提交绑定和断线/切换事件隔离。环境入口已显示不等于 CLOUD-07 或整套云端托管已完成。

## 入口不可展开回归

2026-10-02 将 native select 整体禁用修正为共享 Client Menu：按钮一直启用，绑定锁仅禁用目标项，菜单内展示解释。保留未接入云端不可选、未知历史不重绑、伪造 item ID 不发命令的门禁。新增键盘开关、Escape/Tab 关闭、动画帧清理和锁定/错误状态仍可查看的单元测试；上面六组 Node 套件重新通过。

在用户当前 3083 标签页实际点击展开成功；Escape 关闭、Down 展开、点击外部工作区关闭环境菜单并打开原工作区菜单全部通过。当前 error 会话的目标仍被禁用，没有改会话数据或编译/重启 Host。截图 `dist/design/runtime-picker-20261002/inspectable-menu.jpg` 为当前页面实际展开的菜单，不是设计稿。已有空数据 Host 的 native select 验收是初版证据；此次共享 Menu 的真实浏览器验收仅声明上述当前 error 页面行为。

## 工作区风格统一

入口与菜单加上现有 16px 电脑/地球装饰图标。用户反馈两侧风格不一致后，环境入口直接复用 WorkspaceChip 提供的按钮/图标/文字/箭头 CSS 类，产品 CSS 不覆盖共享类，独立 fallback 仅用于没有样式契约时。原会话绑定、菜单打开行为和唯一 Cloud 项不变。

六组 Node 回归再次通过，补充装饰图标读屏隐藏、16px、共享类传递、fallback 不覆盖契约测试。当前 3083 实页比较 font family/size/weight、color、line height、gap、padding、radius、min height 九项 computed style，无差异；截图 `dist/design/runtime-picker-20261002/workspace-matched-style.jpg`。未打包或更新桌面 App。
