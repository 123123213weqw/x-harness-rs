# UI PR 审核修复与组合回归（2026-10-04）

## 集成范围

保留 #205、#206、#209、#210、#211 的原始提交与各自修复提交，通过合并提交集成。合并源码后统一重新生成 `ui/dist`，不以任一分支的旧 Bundle 覆盖其他功能。

## 已修复的审核问题

- #205：重新生成资源清单，CSS 文件的 SHA-256 与字节数不再引用旧产物。
- #206：单元加载器支持新增的 `react-dom` 依赖；真实浏览器使用真正的 Portal 实现。新增样式、词条和外部依赖采用明确的特性差异断言，其他旧契约继续精确对照。消息导航回归纳入 Chromium、WebKit CI。
- #210：错误／运行中工具重新出现时，独立订阅的轻量消息 Seat 在布局阶段失效旧折叠记录；恢复成功必须重新经过展示预算和交互保护判断。补充焦点、选中文本和手动展开的恢复测试。生命周期变化只改变展示，不修改工具结果或历史。
- 通用浏览器测试：窗口化卸载测试先明确释放焦点，避免把 Linux Chromium 的按钮焦点保护误判成永久挂载。消息导航加载历史前使用真实滚轮解除底部跟随，不用强制点击绕过可见性。

## 合并冲突处理

- `ChatView` 同时保留消息导航和自适应工具折叠；Portal 的真实依赖注入不能因后续合并丢失。
- 完整启动回归分别验证：新区域外观确实可见、工作入口恰好一个、其他控制与词条一致。只对明确获准的区域几何差异做参考投影，投影后对话区域像素仍与独立冻结版本逐字节相等。工作入口变化不作为放宽整个界面断言的理由。
- 两种浏览器中的模型、思考强度、上下文、设置入口仍通过真实生成图运行。

## 可重复执行的本地 UI 验证

```sh
npm ci --prefix ui --ignore-scripts
npm run typecheck --prefix ui
npm run build --prefix ui
npm run check:build --prefix ui
node --test scripts/test-conversation-source.mjs scripts/test-adaptive-tool-fold.mjs scripts/test-work-catalog.mjs scripts/test-automation-navigation.mjs scripts/test-tasks-state-ownership.mjs
node scripts/test-owned-ui-boot-differential.mjs
for browser in chromium webkit; do
  UI_TEST_BROWSER="$browser" node scripts/test-turn-process-browser.mjs
  UI_TEST_BROWSER="$browser" node scripts/test-conversation-message-rail-browser.mjs
  UI_TEST_BROWSER="$browser" node scripts/test-automation-navigation-browser.mjs
done
```

浏览器依赖通过 `UI_TEST_DEPS` 指向锁定的测试依赖目录，不连接真实 Host、模型或用户数据。

组合单元测试 **56 项通过**；完整启动对照在 Chromium、WebKit 各运行源码、冻结版本、几何投影源码三次，共六次通过。Rust、Windows/macOS/Linux 构建与完整 Linux 浏览器矩阵使用 GitHub CI，不在本机编译 Rust。发布／软件替换不属于本次合并。
