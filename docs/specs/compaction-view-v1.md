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

`succeeded` 还包含 `summary`、`summaryEventSeq`、`shadowedItemCount`、`shadowedTokenCount`。完成更新携带完整摘要，不要求 UI 同时持有摘要事件；`failed` 保持同一节点 key 并转为隐藏状态，不撤回已经发布的节点。未知 `schemaVersion` 不被误读，旧事件回退仅用于没有本产品投影的服务端。

本试点**不改变** Session JSONL、压缩预算、恢复语义或 RPC 名称。当前 Conversation Assembler 仍要求先收到 start Match 才能发布节点；因此只有 end 的极窄历史页虽有自包含投影，仍须加载到 start 后才会出现。后续若要做到“仅凭终态页立即显示”，需单独设计 Assembler 的快照起点协议，不应在本试点里伪造第二个 start。

回归：`scripts/test-compaction-ui.mjs` 验证 v1/旧版、成功/失败、实时/重放节点形状；`xharness-projection` 单测验证持久投影和兼容投影一致。Rust 测试按仓库规则只在远程运行。
