# Compact UI 投影试点（v1）

本试点只迁移**自动压缩**的聊天节点。持久事件仍是事实来源，Host 为实时事件和历史页统一附加可选的 `view`；前端只用这个版本化投影决定自动压缩节点的显示状态，不再从 `compaction/end.error` 等事件字段推导新服务端的 UI。旧服务端没有 `view` 时保留原事件解析作为兼容路径。手动压缩命令不变。

```json
{
  "for": "compaction",
  "view": {
    "schemaVersion": 1,
    "id": "compaction-id",
    "phase": "running | succeeded | failed",
    "anchorSeq": 123,
    "time": 1700000000000
  }
}
```

`succeeded` 还包含 `summary`、`summaryEventSeq`、`shadowedItemCount`、`shadowedTokenCount`。完成更新携带完整摘要，不要求 UI 同时持有摘要事件；`failed` 保持同一节点 key 并转为隐藏状态，不撤回已经发布的节点。未知版本或格式无效的 `view` 不被误读；如果原事件仍是可识别的生命周期事件，则使用兼容解析，避免忽略终态后一直显示运行中。

本试点**不改变** Session JSONL、压缩预算、恢复语义或 RPC 名称。失败/取消只隐藏压缩进度节点，正常的 turn 错误展示链路不变；手动压缩命令节点保持原有行为。

## 同一套状态转换

自动压缩节点的实时 `update` 与历史 `fallback` 都调用 `updateCompactionState`。历史恢复是将已加载 Match 按序折叠，不另写“找第一条 start/end”的推断逻辑。有 `view` 时仍保留原始生命周期证据，所以开始有投影、结束没有投影（兼容 carrier）也可以安全隐藏原节点。

`view` 的协议版本仍为 1；前端 reducer 补丁版本为 2，两者不要混淆。React 组件只负责呈现节点，不自行决定业务是否结束。

## 分页与终态

只有 end 的历史页只要带自包含 `view`，也可渲染终态节点，不必伪造 start。实际 Assembler 的 `flush` 会对无 start 的 Context 调用节点构建，状态为空时使用共享 reducer 折叠 Match。这里不修改 Assembler 的唯一 start、序号、稳定 key 约束。

## 回归

- `scripts/test-compaction-ui.mjs`：渲染与手动/自动兼容。
- `scripts/test-compaction-projection.mjs`：运行实际打包的 ConversationNodeAssembler 和 compactionDefinition，覆盖逐条/批量实时、刷新、任意分页切点、生成中重连、重复事件/重复历史页、仅终态页、连续压缩、旧版/新版混合、未知或坏投影，以及原始 null 撤回故障的确定性复现。此测试接入 CI。
- `xharness-host`：经过实际同步发布和 history RPC，验证成功、网络失败、取消、输出超限的 live/history/restart `view` 一致。
- `xharness-projection`：持久与兼容投影一致；预算和 Session 事实不变。

Rust 测试按仓库规则只在远程运行。源码完成不代表当前已安装软件已经更新。

2026-09-30 源码验收：Assembler 705 条检查通过；V100 上 Host 180 个单测、22 个集成测试、Projection 14 个单测通过（Host 另有 5 个显式忽略用例）；WebKit 历史缓存、窗口化以及关联投影回归通过。GitHub CI 仅接入新测试，尚未推送执行。
