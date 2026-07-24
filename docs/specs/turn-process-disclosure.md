# 整轮过程收起与常驻结束提示

## 目标

运行中完整展示思考、工具和中间回复。收到该轮 `turn/end` 后，默认收起过程，保留最终回答和常驻的“用时 … >”按钮；点击按钮重新展开同一轮的过程。

这是 UI 展示状态，不是上下文 Compact，不裁剪模型输入，不删除消息、附件或工具结果，不改变调度、审批、提问或执行状态。

## 结束边界

- 唯一结束证据是由真实 `turn/end` 投影出的 `turn-tail`，实时和历史复用同一投影。
- `step/end`、工具返回、Session 暂时 idle 都不能提前收起整轮。
- 无正文、纯思考、工具调用后停止以及失败轮次，也必须有结束入口。
- 缺少历史起点时显示“本轮已结束”，不伪造用时；已知起点时采用整轮 start/end 的墙钟差，不采用最后一步耗时。

## 可见内容

收起时隐藏工具根卡片及子调用、中间 Assistant、思考、轮内重试与注入信息。最终的文字、图片及其他输出保留；最终回答里的思考块仅在展开过程后展示。

用户/Steering 消息、手动命令及手动压缩、错误、输出超限和运行检查点提醒仍可见，未知扩展默认保留。会话级、无法归属某轮的节点不猜测性隐藏。

用时按钮放在本轮过程的起点，不受 hover 才显示时间信息的旧 CSS 控制；点击后过程出现在按钮下方。复制、Fork、时间和 TTFT/TPS 沿用最终回答之后的消息动作栏。

## 状态与滚动

- 仅改变当前 ChatView 的展开集合，每轮独立，按 Session 隔离。React 节点 Key 同时包含 Session ID，切换会话不会串用相同数字轮次的状态。
- Think、工具卡、Compaction 及原生 details 的布尔／显示模式状态由稳定的 ChatNodeSeat 持有，窗口卸载或整轮收起不清除；移除节点或卸载会话后自然释放。复用原 transcript-state 桥，不缓存 DOM 或复制完整工具结果。
- 新结束轮次默认收起；打开历史也默认收起。
- 折叠过程子树停止挂载，但完整节点仍由原 Session store 持有；展开时继续使用既有窗口化，不一次永久挂载全部历史。
- 点击后保留结束按钮的视口锚点和键盘焦点。布局之前同步解除自动跟随，不因收起后高度缩小、暂时贴底而夺回跟随；真正滚到底或显式“回到底部”仍沿用原行为。
- 不认识、损坏或归属其他轮次的 tail 不触发隐藏；仍保留未知节点的 JSON 展示。
- 不新增 Host/RPC 字段；新增的 renderer owner 参数为可选，仅在 UI 内传递。

## 回归

- `node scripts/test-turn-process.mjs`：边界、正文/无正文、图片、异常提醒、live/history 投影以及内容不变。
- `UI_TEST_BROWSER=chromium node scripts/test-turn-process-browser.mjs` 与 `webkit`：真实 ChatView/ChatNodeSeat/TurnTailNodeView，80 工具行、运行→idle→结束、常驻、键盘展开／锚点、实际 ToolRow 与 Think 多次折叠重开、原生 details 恢复、窗口淘汰、Session／轮次隔离、部分历史、无正文／未知起点／错误、损坏 tail 以及图片最终输出。
- `node scripts/test-conversation-source.mjs`：保留已有迁移/ABI 回归，仅声明新增文案和结束按钮样式的有意差异。

这些测试和构建只涉及 Node/TypeScript；不在本机编译 Rust。
