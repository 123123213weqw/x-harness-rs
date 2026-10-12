# Performance 接收时间线 v1

## 展示与口径

`Performance / 性能` 注册在 `conversation.view`（order 31），紧邻 Harness
（order 30）。不修改 Chat 的接收、工具、模型参数、上下文或滚动策略。
按任务轮次选择，显示正文、思考、工具参数三条折线与状态带。每秒时间桶
可以切换为 3 秒移动均值；悬停/键盘显示时间、步骤、尝试次数及请求模型。
数据表仅展开时挂载。深浅色、窄屏与两种浏览器共用现有产品样式变量。

图的单位是**接收侧估算 tok/s**，不是 GPU/server decode TPS：

- 原始依据为 durable AssistantChunk 的检查点时间。Core 当前最多每
  250ms 或达到体积/片段阈值提交一个检查点；检查点可能合并多个片段，
  因而网络缓冲、合并与提交延迟都可能造成突发。精度不伪装成逐 token。
- ASCII 每字符 1/4 token、非 ASCII 每字符 1 token；权重跨片段可相加。
  没有把 chunk 数当 token，没有在热路径全量 tokenize，也没有存正文副本。
- 最终 provider usage **不回填、不缩放**每秒估算。另一项平均速度独立
  使用接口的输出/思考计数和首增量至完成的接收时间，并明确标其口径。
- 没有时间样本时只显示无采样。缺失秒、不同步骤、重试尝试之间不连线；
  工具、审批、问题等待和重试等阶段不伪造 0 TPS。平滑不跨这些缺口。
- 旧日志如果保留了带时间的流式检查点，可重建同口径估算；如果只剩最终
  消息/usage 或旧 idle checkpoint 没有该缓存，不能从平均值补出曲线。

## 生命周期与恢复

`xharness-projection::performance` 是确定性的内容无关 reducer。它消费
原始 LoggedEvent；权威 live driver 直接折叠这一批原始事件，避免 history
合并/省略流式块后失去时间信息。普通 Web event 入口只供非权威 embedding
兼容。live、完整恢复和 idle checkpoint 尾恢复复用同一个 typed reducer。

没有新增工具、RPC、定时后台任务或会话日志事件；Session 仍是事实来源。
`performanceTimeline` 是可选的 projection key。版本/字段验证失败只让
该面板提示不兼容，不能使聊天历史加载失败。旧 Metrics checkpoint 通过
serde default 兼容；没有采样就不发明旧数据。

## 内存、IO 与发布

全局容量限制（不是每轮一份上限）：最近 4 轮、600 个样本、128 个阶段、
64 个请求；交互去重集合也有上限。超过时先淘汰旧样本并显示窗口截断提示。
这是观测数据淘汰，不删除聊天、工具结果或改变执行状态。模型/提供方名称
长度有限，不保存提示词、思考原文、参数 JSON、API key 或错误正文。

同一秒的普通 delta 只累加私有计数；下一秒/状态切换/边界再发布投影。
最终结束立即 flush。无流式增量的间隔不定时制造样本。会话列表及冷启动
catalog 不带完整时间线，只有打开会话的 baseline/live projection 带它。
idle recovery cache 中保留有界 reducer 状态，重启无需重复存聊天数据。

## 回归门禁

- Rust：分片计数等价、同秒不重复发投影、缺口、未知 usage、并发工具与
  交互、重试、时钟倒退、终止、长目标容量、旧缓存、live/replay 等价。
- `protocol/fixtures/performance-timeline-v1.json` 同时被 Rust 真 reducer
  与 TS decoder/chart 测试验证，不能仅修改前端让字段“看起来对齐”。
- `scripts/test-performance-source.mjs`：严格 owned TS、非法可选协议仅影响
  面板、平滑边界、容量、注册卸载、生产图隔离。
- `scripts/test-performance-browser.mjs`：真实生成图/React/Locale/Slot，
  仅 fixture 传输 baseline 注入共享 wire fixture；不是替代生产组件。
  验证 Harness 邻接、键盘、深浅色、窄屏、懒挂载表格与返回 Chat。
- 原 full-boot frozen pixel comparison 只增加精确模块清单项，不改 golden
  内容、像素容差、Chat/模型/设置回归。

安装或替换 Host 前必须完成远程 Rust 回归。本机不得编译 Rust。此模块
不意味着已部署到用户的 3083 服务，也不自动发布安装包。

### 2026-10-12 验收记录

- V100：projection 28/28；Host 282 passed、0 failed、6 原有 ignored；
  两 crate all-targets Clippy `-D warnings` 通过。完整输出保存在本机
  `dist/regression/performance-20261012/rust.log` 和 `host-final.log`。
- 权威 Host 的 live mux → history → restart 整份 projections 差分通过，
  另检查最终 TPS 时间线帧、接口分桶以及会话列表不带完整采样。
- 6 项新 source 测试、20 项 conversation source 与 14 项 CI suite 通过。
- Chromium / WebKit 完整模块图：相邻页签、键盘、窄屏、深浅色、
  数据表展开才挂载、切回 Harness/Chat 通过。两引擎 frozen boot 的
  Chat 像素仍逐字节等于旧参考布局；未修改参考或像素容差。
- 示例截图使用共享协议测试数据，不是用户对话，也不宣称真实模型 TPS。
- 未发布、未替换本机 App 或 3083 服务、未连接真实模型或消耗 API 额度。
