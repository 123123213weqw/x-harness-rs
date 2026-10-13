# 执行环境入口 TS 迁移（2026-10-11）

## 补交范围

10-02 的执行环境入口属于旧工作区的 JS 补丁与静态预览，PR #208
恢复公开开发时没有搬进 owned TS 前端。本批补齐 `CLOUD-07a-ts`，
从公开 master `e0a35e4c` 派生，不复制旧生成包或私有历史。

- `runtime-environment` 为正式 source-module，纳入 `ui/modules.json`，
  由 Slot/Locale 服务注册，不修改 bundle 字符串。
- ConversationRoot 声明并传递 `conversation.hero.runtimeEnvironment`
  的类型化 owner：会话 ID、可信 blank、composer/open 状态及工作区样式。
- 新任务工作区左侧显示本机/Cloud 菜单。菜单始终可以查看；仅确认的
  blank cold/open 状态可以确认本机。加载、失败或未知历史不当作新任务。
- 复用工作区按钮的准确 CSS 类和 16px 装饰图标；窄屏换行、portaled
  菜单、键盘打开/选择/Escape/Tab、会话状态变化关闭及监听器清理均有回归。
- 同步重建当前生成图、HTML、manifest 和模块产物。生产图不包含私有
  test entry。现有会话、运行任务、模型配置和数据库均不修改。

## 明确未交付

Cloud 只显示统一名称，不显示测试机器名称。环境目录、Gateway、
RuntimeConnection、远程工作区和提交绑定属于 `CLOUD-06/07a-routing`，
本 PR 不实现，也不伪装可用。Cloud 持续禁用，产品没有新增路由/RPC，
未知/伪造菜单 ID 无效，不存在“选云端后悄悄跑本机”的 fallback。
本机只代表当前连接 Host 的既有执行路径，不从 UI 标签推导连接身份。

## 验收口径

- 严格 TS source-module 编译、当前产物重建与幂等检查。
- 新单元回归覆盖 120 个 composer/history 组合，每个组合检查 5 个
  正常/伪造选项；附加槽注册清理、双语、样式契约和生产图隔离。
- 浏览器回归使用真实生成模块图、React/Slot/Locale/Menu，与内置 fixture
  传输；不模拟菜单组件，不连接真实 Host、VM 或模型，不消耗模型额度。
- Chromium/WebKit 分别核对样式、键盘、禁用 Cloud、窄屏菜单和零页面异常。
- 原 conversation 注册差分只独立断言新增槽，再比较全部旧注册；冻结
  reference 和 CI 覆盖基线不改。
- 全图冻结对照单独计数并断言新增环境模块/按钮，保留未投影的真实新 UI
  截图；仅在原参考布局 lane 隐藏该按钮的确切 Menu wrapper，再要求其余
  对话像素逐字节等同于独立冻结参考。不增加像素容差或跳过原功能检查。

完整本地输出存于忽略目录 `dist/regression/cloud-ui-ts-20261011/`，
截图存于 `dist/runtime-environment-20261011/`。本 PR 的跨平台结果仍须
等待新 head CI；没有本机 Rust 编译、发布安装包、替换软件或启动 VM。
