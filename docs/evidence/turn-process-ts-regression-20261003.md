# 整轮折叠 TS 接入回归（2026-10-03）

## 基线与故障

- 主分支基线 `d705aa6cef998d50f386dd923e4f9c3d1d902ee1`，保留 PR #195 的滚动意图／更新面板修复；不覆盖 `xharness-statecheck` 中其他未提交修改。
- 对实际 3083 发布的模块和干净 TS 主分支分别用 Chromium／WebKit 构造相同有效 DTO。旧预览可以整轮收起，但 Think 手动展开后，结束／重开及再次收起／重开均恢复成关闭。
- 干净主分支没有整轮入口，用时依赖 hover；无最终正文且无扩展 tail 时没有结束入口。因此只修旧预览而不迁入 TS 不能解决正式构建丢失功能。

## 实现边界

1. 真实 `turn/end` 派生的、归属同一轮且解码成功的 `turn-tail` 才关闭过程。Session idle、step/end、损坏或串轮 tail 不触发隐藏。
2. 原 Session store 与 Host 历史不变。显示选择复用 `transcript-state`，由带 Session ID 的稳定 ChatNodeSeat 持有；窗口／整轮重挂载恢复，不保留完整 DOM 或复制工具结果。
3. 用时入口位于用户消息之后、首个已加载过程节点之前。已知起点显示整轮墙钟用时，未知起点显示“本轮已结束”；正文、图片、错误／超限／检查点不丢失。
4. 手动切换在布局之前解除自动跟随，并恢复按钮锚点。收起导致高度暂时贴底也不会悄悄恢复跟随。

## 验收范围

本机只使用 Node／TypeScript 和受控浏览器页面。V100 为 `WZU_Server` 的独立 `~/codex-build/xharness-pr195-scroll-ci/` 测试目录；同步排除 Git、target、node_modules、环境文件及密钥，不重启生产 Host、模型或本机软件。

- 严格 TS／自有类型门禁、完整 53 模块／154 资源构建和重复字节校验通过。
- `test-turn-process.mjs`：7 项通过，涵盖真实投影的结束边界、无正文、不可隐藏的终态通知、最后的文字／图片／其他输出、后续空步骤、live/history 和异常结束。
- `test-conversation-source.mjs`：19 项 ABI／原样字典与 CSS 差分通过，仅显式接受 3 条新文案及新增 summary CSS。
- `test-conversation-main-differential.mjs` 3 项、`test-conversation-service-boundaries.mjs` 10 项、`test-atomic-history.mjs` 5 项通过；助手、重试、原子历史、原有行状态和滚动归属入口通过。
- macOS Chromium／WebKit：真实 ChatView／Seat／Think／ToolRow／Compaction 的整轮收起、重复重开、原生 details、窗口淘汰、相邻调用隔离、会话隔离、残缺历史、无正文／错误／未知起点、损坏／串轮 tail、图片最终输出通过。折叠后的高度增长不能跳底。
- V100 Linux Chromium／WebKit：同一生产源码的整轮入口、完整 conversation 浏览器入口、真实滚动手势及原有窗口化回归通过。额外更新的 corner 用例也独立重跑，不以旧测试文件的通过替代。

V100 原窗口化的 350 行合成对照：Chromium DOM 29,937 → 1,041，WebKit 15,477 → 427；窗口化首次重载完整重型节点为 0，宽度重排峰值挂载为 1。此处是合成夹具的 DOM／JS 指标，不是生产进程 RSS 或操作系统实际驻留内存。

## 发布门禁

上述是源码／受控 UI 回归，不等于已替换当前 3083 或桌面软件。GitHub CI 仍为合并门禁；本轮不发布安装包、不修改聊天持久格式，也不在本机编译 Rust。
