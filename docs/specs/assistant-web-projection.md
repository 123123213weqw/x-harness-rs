# Assistant 实时与历史投影（#61）

## 根因

旧 Host 把 `reasoning-delta`、`text-delta` 和第一个工具参数都投影到 index 0。
Web reducer 按 index 保存块，因此另一种块到达时会覆盖原内容。
此外，历史 `assistant/message` 只输出 `message.content`，遗漏已经持久化的
`message.reasoning`。完成的流式块被折叠后，刷新就看不到思考。

## 统一契约

`xharness-host::assistant_projection` 是临时 Loop Driver 和持久 Session 投影的共同边界：

| 内容 | 流式块 index | 完成消息 |
|---|---|---|
| Provider 返回的 reasoning | 0 | `{type:"reasoning", text:...}` |
| 正文 | 1 | `{type:"text", text:...}` |
| 工具参数 | 原始工具 index + 2 | 仍使用既有 Tool Call/Result 卡片链路 |

- 工具块偏移仅用于 Web 表示，不改变 Core 的工具编号、调用 ID、执行顺序或调度。
- 不预先输出 index 0 的空正文 block-start；现有客户端能够从 delta 初始化块。
- 完成消息忽略空块；仅思考、仅正文以及两者都有均合法。
- 最终消息与流式视图均采用“思考、正文、工具”排列。这不是逐块交错时间线：
  当前规范化消息分别累加正文和思考，没有保存跨种类交错顺序。
- 中断后的部分消息也保留 reasoning，并投影 `interrupted=true`。
- 历史读取、重启尾部恢复及实时消息均使用同一块投影。完成后的流式块仍按原策略折叠，
  不通过重复保留全部碎片来修复显示，也不增加第二份常驻历史。
- 旧 Journal 中已经有 reasoning 的完成消息自动恢复显示，不需要修改历史文件。
  如果源数据本身没有保存 reasoning，本修改不会推测或生成缺失内容。

## 验收

共享 `scripts/fixtures/assistant-projection.json` 同时由 Rust 投影测试和实际打包的
Web reducer/classifier 测试读取，防止两端各自通过却协议不一致。
覆盖：正文先到、交错、Unicode、两次工具调用、纯思考、纯正文、空内容、中断、
完成消息替换、刷新只读完成消息、分页历史和尾部恢复。

```sh
# Rust 必须在同步源码后的远程服务器执行
cargo test -p xharness-host
# JS 可本地执行；不连接用户正在运行的会话
node scripts/test-assistant-projection.mjs
```

这只处理模型接口公开返回的 reasoning 字段，不请求或推导其他隐藏内容。
