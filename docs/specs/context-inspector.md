# Context Inspector 上下文检查器规范

## 目标

Web 客户端必须能够检查每个模型步骤真正收到的完整输入，并明确区分：

- System Prompt；
- 用户消息；
- 模型 reasoning；
- 模型正文；
- Tool Call；
- Tool Result；
- Provider opaque items；
- 压缩 checkpoint；
- 请求侧 `tool_result_pruned` 与 `assistant_history_pruned` Surface Edit 及其移除字符数。

该视图用于审计和调试，不参与 Loop 决策，也不得修改 Session Journal。

## 后端事实来源

每次普通模型请求前，Core 在 `request/header` 中持久化完整的
`RequestHeader`：

- `provider`、`model`、`reasoning_effort`；
- `system`；
- `tools`；
- `input`：ContextPolicy、Token Guard 和压缩处理后的最终消息；
- `options.context`：Policy 和 Surface Edit；
- `options.tokenBudget`：Token 计量器、精度与预算。

Host 投影为 Web 兼容结构：

```json
{
  "type": "request/header",
  "data": {
    "header": {
      "config": { "provider": "...", "model": "..." },
      "system": "...",
      "tools": [],
      "input": [],
      "options": {},
      "xharnessVersion": 1
    },
    "reason": "initial | change"
  }
}
```

其中 `config/system/tools` 保持 DeepSeek Web 客户端兼容，
`input/options` 是 XHarness 的审计扩展。API Key、Authorization Header 和
Provider 凭证禁止进入该事件。

## 压缩

`compaction/summary` 是不可变压缩证据，包含：

- `compactionId`；
- `shadowedSeqs` 和 `shadowedRange`；
- `shadowedTokenCount`；
- 原始 summary；
- Provider、模型和 usage。

Web 端以事件序号关联压缩前最后一个 RequestHeader 和压缩后第一个
RequestHeader。压缩前历史仍保留在 Journal 中；压缩后模型输入以新的
RequestHeader.input 为准。

普通请求侧历史投影不生成 Compaction Event；它通过同一个 RequestHeader 的
`options.context.edits` 暴露。Context Inspector 必须把 `assistant_history_pruned` 解释为
“只改变本次模型输入”，不得把已经落盘的源 Tool Call、Reasoning 或文件内容显示成被删除。

## 前端行为

Conversation 顶部注册 `Context` 和 `Harness` 两个调试 Tab：

```text
Chat | Trajectory | Context | Harness
```

`Context` 只展示某一 Step 模型实际收到的输入，支持：

- 按 Step 切换 RequestHeader 快照；
- `实际发送 / 压缩前 / 压缩后 / Diff`；
- 默认折叠的请求详情，按需查看 Token Meter、Policy、消息数量和模型路由；
- System、用户、reasoning、正文、Tool Call、Tool Result、压缩摘要的颜色标记；
- Raw JSON 折叠查看；
- 上下文搜索。

`Harness` 解释这个请求为什么被构造成当前形态：

- `Prompt Assembly → Tool Registry → Context Policy → Provider Request` 构造链路；
- 有序 Prompt Section、版本、Hash 和最终注入的 System Prompt；
- 当前 Step 真实发送给模型的 Tool Description 与 JSON Schema；
- Context Policy、Token Guard、Provider/Model、Reasoning Effort 和请求身份。

Tool Definition 不在 `Context` 正文重复渲染；`Harness` 的 Tool Registry 是唯一详细展示面。

颜色不能是唯一分类信息，每个块必须同时显示文本标签。

## 性能要求

- 默认只渲染选中 Step；
- Tool Schema、Prompt Section 身份和 Raw JSON 默认折叠；
- 不复制或改写后端消息内容；
- 后续超大上下文版本应增加虚拟列表和按内容引用懒加载。

## 验证

- Rust Host 测试确认 Web request/header 同时保留兼容字段和完整 input；
- Client 插件烟雾测试确认注册 `Context/Harness` 两个 Tab、事件 Definition 和 Snapshot Builder；
- 浏览器验证两个 Tab 可见、Request Step 可选、Context 的折叠请求详情和颜色块正常，
  Harness 的 Prompt/Tool/Policy/Route 均来自同一 RequestHeader 快照。

具体 Token 用量不在 Context 工具栏重复显示。Host 通过标准 `request/context` 与
`contextPressure` Projection 驱动输入框底部原生无文字圆环；圆环填充比例表示下一次请求
预计占用的 Context Window，Hover/点击才显示详细数字。

## 页签滚动隔离（2026-09-05）

- `Context`、`Harness`（包含无请求时的空态）必须声明上游
  `data-conversation-composer-overlay` 契约，与 Trajectory 的接入方式一致。
  外层会话容器保持视口高度，由 Inspector 内部负责滚动；不能继续沿用 Chat
  长消息流的外层滚动位置，否则切换后内容会落到视口上方。
- Inspector 根容器使用 `flex: 1; min-height: 0`；Harness Grid 行使用
  `max-content`，避免限定视口后卡片被压缩并裁掉内容。
- 底部留白使用上游 `--dsh-composer-height` 加 24px；未提供变量时回退到
  150px 输入区高度。桌面与窄屏规则必须一致，输入框增高后仍能滚动查看最后一块内容。
- 不通过逐事件 `scrollTop = 0` 修复，不改 Chat 的语义锚点与自动跟随逻辑；
  请求快照更新、搜索或展开工具时不得强制打断读者的滚动位置。

回归入口：

```sh
node scripts/test-context-plugin.mjs
# UI_TEST_DEPS 指向独立的测试依赖目录，依赖不打入产品。
npm install --prefix /tmp/xharness-ui-tests --no-save --package-lock=false playwright@1.61.1 react@18.3.1 react-dom@18.3.1
node /tmp/xharness-ui-tests/node_modules/playwright/cli.js install chromium webkit
UI_TEST_DEPS=/tmp/xharness-ui-tests UI_TEST_BROWSER=chromium node scripts/test-context-layout.mjs
UI_TEST_DEPS=/tmp/xharness-ui-tests UI_TEST_BROWSER=webkit node scripts/test-context-layout.mjs
```

布局测试直接读取仓库内实际上游 CSS、加载真实 React 与 Inspector 组件，构造
长 Chat 滚动容器及合成请求数据，不读取用户对话、不调用模型或操作正在运行的软件。
覆盖重复切换、模拟请求快照持续更新、请求选择、工具展开、宽窄窗口、输入框增高、
空态及短请求；CI 中分别运行 Chromium 和 WebKit。测试不等同于已安装 Tauri
应用的发布验收，桌面包更新后仍需验证真实 Chat 返回时的阅读位置与原生点击。
