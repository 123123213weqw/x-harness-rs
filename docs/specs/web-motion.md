# 界面动效（Web Motion）

流式文本与面板动效改写自 Apache-2.0 的 zai-org/ZCode；品牌扫光为产品自有动效。
它们均带 `prefers-reduced-motion` 降级，均为纯 CSS（不引 Framer Motion）。

## 统一运动令牌

`ui/overrides/motion-tokens.css` 是唯一的产品运动令牌源。静态 UI 组装时复制到
`ui/dist/motion-tokens.css`，带内容哈希的 `<link>` 在插件启动前注入一次；Web 和
Tauri 使用相同的静态资源。插件的 CSS 使用 `var(--xh-…, fallback)`，即使单个
样式文件缺失也能维持原有速度。令牌按语义分为快速反馈、控件反馈、遮罩进入/退出、
面板进入/退出、流式正文、运行状态脉冲、Logo 周期及相应缓动，不把不同场景
强制改成同一时长。任务、终端、流式正文、日程、电脑、上下文插件和 Logo 都使用
同一组令牌。

## 流式文本逐段淡入（`@xlang/xharness-client-ui-motion`）

ZCode `zcode-stream-text-in` 的 DOM 级等价实现：对话流式输出时，新增的内容块
（P/H1-H6/LI/PRE/UL/OL/TABLE/BLOCKQUOTE/IMG/HR）以 900ms、
`cubic-bezier(.16,1,.3,1)` 淡入，同批最多五级 45ms 交错。

实现是 MutationObserver 而非上游 bundle 补丁：监听
`[data-conversation-scroll]` 根，仅当同时满足——

1. 存在 `[class*="_turnStatus"]`（回合运行中的状态条，CSS module 哈希名保留语义后缀）；
2. 新节点位于最后一个 `[data-transcript-mounted]` 行（流式只发生在末行）；
3. 不在 `[data-transcript-mounted="false"]`（transcript windowing 的滚动重挂载，必须跳过，否则滚动即闪烁）；
4. 标签属内容块集合；
5. 同父元素 300ms 窗口内没有先前的动画（React 增长重渲染按 churn 抑制，窗口每次命中刷新；同批兄弟节点不抑制、走交错）——

才挂 `data-xh-stream-animate="true"` 与 `--xh-stream-delay`，`animationend`
后清理。嵌套目标（LI 内的 P）折叠到祖先只动一次。选择规则是导出的纯函数
`planStreamAnimations`，node 测试覆盖。

已知边界：上游若改为整段替换式渲染，粒度退化为整块淡入；回合恢复时首屏
历史行会随挂载淡入一次（门控只在 turn 活跃时开）。

## 面板进出场（terminal dock 与 tasks panel）

ZCode `ConversationBottomDockTransition` 的参数：进场 0.26s、退场 0.18s、
缓动 `cubic-bezier(.23,1,.32,1)`；底部 dock 32px 上移 + 0.96 缩放，侧面板
24px 位移 + 0.98 缩放，scrim 0.2s/0.15s 淡入淡出。退场经 store 的关闭相位
在关闭相位等对应面板的 `animationend` 后卸载，而不是另设与 CSS 并行的 190ms
时钟。监听器只接受自身的退场动画，子节点或进场动画不能误关；看门狗按退场令牌时长加余量计算（至少 1s），兜底
标签页隐藏或样式丢失导致的事件缺席。重新打开会取消旧关闭；减少动态效果时
立即关闭。ESC、遮罩点击与按钮走同一路径。

## 轻量等待指示器（正式聊天入口与独立预览）

使用 XHarness 自有的单层像素圆环：12 个 2×2 方块组成 16px 环，以 1.2s
透明度交错追逐。SVG 不旋转、不缩放，像素边缘保持对齐；不加中心点、额外圆环、
霓虹颜色或发光。整体保留 900ms `cubic-bezier(.16,1,.3,1)` 淡入节奏。
颜色继承产品主题的主文本色，深浅色共用组件。

- `LoadingIndicator` 只接受宿主传来的 `active` 与本地化 `label`，不推断
  Agent、工具、审批或网络状态。`active=false` 时不挂载。
- 指示器只有 `role=status` 和无障碍标签；不显示 Working 文案或百分比。
- 环自身不使用 JS 定时器、逐帧 React 更新或额外日志。透明度追逐与淡入分属
  两层；`prefers-reduced-motion` 同时关闭动画，留下可见静态环。
  `data-xh-page-hidden` 暂停像素追逐。
- 正式 ChatView 保留 `_turnStatus` 活动门控与 `running` 显隐逻辑，不改变
  工具、审批、Host 生命周期或最终回合摘要。流式正文更新、计时与主题切换
  不得重挂载像素环或重启动画。
- `ElapsedTime` 独立叶子组件每秒刷新，从回合开始即显示 `0s`、`1m 02s`、
  `1h 02m 03s`，不带“运行”前缀。锚定日志 `turn/start`，重新进入运行中的
  会话继续显示真实回合经过时间；边界不在窗口内时才回退到本次挂载时刻。
  包含审批等待，不伪造工具执行进度。`role=timer`、`aria-live=off` 避免逐秒播报；
  卸载清理 interval。可选结束时间冻结演示钟，正式状态在停止时卸载。
- 独立预览直接使用正式组件，不连接 Host/模型、执行工具、保存会话或更改
  已安装应用。预览覆盖等待模型、工具准备、等待确认和完成；等待确认与完成
  不显示环，完成冻结演示计时，新任务重新开始。

验收：组件开关、标签、无定时器的像素环、16px/12 方块几何、1.2s 追逐、900ms
淡入、深浅色、减少动态效果、重复渲染不重启动画，h/m/s 边界格式、时间锚点与
清理，以及 Chromium/WebKit 的正式 ChatView、预览状态切换与窄屏布局。
