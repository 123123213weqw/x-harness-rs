# 界面动效（Web Motion）

两处动效，均改写自 Apache-2.0 的 zai-org/ZCode，均带
`prefers-reduced-motion` 降级，均为纯 CSS（不引 Framer Motion）。

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
（190ms 定时器）再卸载，ESC 与遮罩点击同路径。
