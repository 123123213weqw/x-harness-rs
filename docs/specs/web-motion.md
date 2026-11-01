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

复用 ZCode `ChatLoading` 的视觉节奏：16px、中性低对比图标，外层 HTML
容器以 1s 匀速旋转，整体以 900ms `cubic-bezier(.16,1,.3,1)` 淡入。
颜色使用 XHarness 自己的主题令牌，深浅色共用组件；不引入 ZCode 的 React
上下文、国际化服务或运行时依赖。

Loader 图标来自 Lucide（ISC，包含 Feather 派生图标的 MIT 声明）；完整版权与
许可声明保留在 `docs/licenses/lucide-loader.txt`。

- `LoadingIndicator` 只接受宿主传来的 `active` 与本地化 `label`，不推断
  Agent、工具、审批或网络状态。`active=false` 时不挂载。
- 对外只有 `role=status` 和无障碍标签；默认不显示 Working 文案、时间或百分比。
- 不使用 JS 定时器、逐帧 React 更新或额外日志。旋转与淡入分属两层，互不覆盖；
  `prefers-reduced-motion` 同时关闭两层动画。
- 正式 ChatView 的 TurnStatus 用该组件替换 Working 扫光文字，仍由原有
  `running` 状态控制显隐；保留 `_turnStatus` 活动门控，不能破坏流式文本动效。
  不改变工具、审批或 Host 生命周期。15 秒后的原有耗时显示、turn/start 时间锚点
  与计时器清理逻辑保持不变；逐秒计时与流式重渲染不能重挂载旋转图标。
- 独立预览不能连接 Host/模型、执行工具、保存会话或更改正式应用。
- 预览覆盖等待模型、工具准备、等待确认和完成；等待确认与完成不显示旋转。

验收：组件开关、标签、无定时器、16px 尺寸、1s 匀速、900ms 淡入、主题继承、
减少动态效果、重复渲染不重启动画，以及 Chromium/WebKit 的状态切换与窄屏布局。
