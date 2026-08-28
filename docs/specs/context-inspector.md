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
- 压缩 checkpoint。

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

## 前端行为

Conversation 顶部注册第三个 `Context` Tab：

```text
Chat | Trajectory | Context
```

支持：

- 按 Step 切换 RequestHeader 快照；
- `实际发送 / 压缩前 / 压缩后 / Diff`；
- Token Meter、Policy、消息数量和模型路由；
- System、用户、reasoning、正文、Tool Call、Tool Result、压缩摘要的颜色标记；
- Tool Schema 与 Raw JSON 折叠查看；
- 上下文搜索。

颜色不能是唯一分类信息，每个块必须同时显示文本标签。

## 性能要求

- 默认只渲染选中 Step；
- Tool Schema 和 Raw JSON 默认折叠；
- 不复制或改写后端消息内容；
- 后续超大上下文版本应增加虚拟列表和按内容引用懒加载。

## 验证

- Rust Host 测试确认 Web request/header 同时保留兼容字段和完整 input；
- Client 插件烟雾测试确认注册第三个 Tab、事件 Definition 和 Snapshot Builder；
- 浏览器验证 Tab 可见、Request Step 可选、Token Meter 和颜色块正常展示。

具体 Token 用量不在 Context 工具栏重复显示。Host 通过标准 `request/context` 与
`contextPressure` Projection 驱动输入框底部原生无文字圆环；圆环填充比例表示下一次请求
预计占用的 Context Window，Hover/点击才显示详细数字。
