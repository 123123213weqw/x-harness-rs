# Compact UI 投影（v1）

自动与手动压缩使用同一套生命周期投影；手动压缩通过 `sourceCommandId` 关联到已有命令节点，不重复生成自动压缩卡片。持久事件仍是事实来源，Host 为实时事件和历史页统一附加可选的 `view`；前端优先使用版本化投影。旧服务端没有 `view` 时保留原事件解析作为兼容路径。

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

`succeeded` 还包含 `summary`、`summaryEventSeq`、`shadowedItemCount`、`shadowedTokenCount`。完成更新携带完整摘要，不要求 UI 同时持有摘要事件；`failed` 保持同一节点 key，显示“压缩未完成 · 原始历史未改变”，并可展开错误详情，不撤回已经发布的节点。未知版本或格式无效的 `view` 不被误读；如果原事件仍是可识别的生命周期事件，则使用兼容解析，避免忽略终态后一直显示运行中。

预算判定、RPC 名称、持久历史真源和摘要原子提交机制不变。新增的 `compaction/progress` 只记录数值快照，不保存未完成的摘要或思考内容。失败或取消显示明确终态，正常的 turn 错误展示链路保持不变。

## 极简状态（2026-10-02）

正常压缩只显示一行 `正在压缩… · 可能需要几分钟`；英文为 `Compacting context… · May take a few minutes`。没有进度条、百分比、次数、每行倒计时或展开控件。内部阶段与重试次数更新不改变这行文案；暂停明确显示“压缩已暂停 · 恢复后继续”，失败详情仍可展开。

展示简化不削弱运行时恢复：分类明确的网络抖动沿用可取消的长期退避，鉴权等永久错误立即进入明确终态，HTTP 与未分类错误保持有界重试。暂停/继续/停止/steer 复用现有对话控制；只有预算验证通过的完整候选才能替换模型上下文。实时、历史恢复和迟到进度都使用共享 reducer，终态不得被旧进度重新激活。

## 同一套状态转换

自动压缩节点的实时 `update` 与历史 `fallback` 都调用 `updateCompactionState`。历史恢复是将已加载 Match 按序折叠，不另写“找第一条 start/end”的推断逻辑。有 `view` 时仍保留原始生命周期证据，所以开始有投影、结束没有投影（兼容 carrier）也可以安全结束原节点，不留运行中状态。

`view` 的协议版本仍为 1；前端 reducer 补丁版本为 2，两者不要混淆。React 组件只负责呈现节点，不自行决定业务是否结束。

## 分页与终态

只有 end 的历史页只要带自包含 `view`，也可渲染终态节点，不必伪造 start。实际 Assembler 的 `flush` 会对无 start 的 Context 调用节点构建，状态为空时使用共享 reducer 折叠 Match。这里不修改 Assembler 的唯一 start、序号、稳定 key 约束。

## 回归

- `scripts/test-compaction-wire.mjs`：运行实际打包的 Connection 工厂和内置 Zod，验证 `session.history`、SSE 和浏览器实际使用的 WebSocket 三条入口。确定性复现第 67、70 条压缩投影导致整页历史拒收的问题；新入口保留完整投影、Unicode 和未来字段，旧工具卡片约束不变，损坏的事件外壳仍拒绝。
- `scripts/test-compaction-ui.mjs`：渲染与手动/自动兼容。
- `scripts/test-compaction-projection.mjs`：运行实际打包的 ConversationNodeAssembler 和 compactionDefinition，覆盖逐条/批量实时、刷新、任意分页切点、生成中重连、重复事件/重复历史页、仅终态页、连续压缩、旧版/新版混合、未知或坏投影，以及原始 null 撤回故障的确定性复现。此测试接入 CI。
- `xharness-host`：经过实际同步发布和 history RPC，验证成功、网络失败、取消、输出超限的 live/history/restart `view` 一致。
- `xharness-projection`：持久与兼容投影一致；预算和 Session 事实不变。

Rust 测试按仓库规则只在远程运行。源码完成不代表当前已安装软件已经更新。

## 传输校验边界（2026-10-02 修复）

Host 已输出 `view.for = "compaction"`，但 Connection 内的展示联合类型原先只允许 `call | result`。历史入口会拒绝整页，实时入口则会丢弃压缩帧。直接测试 Assembler/reducer 会绕过这一层，所以此前投影测试通过仍不能证明软件能加载真实历史。

`scripts/patch-compaction-wire.mjs` 在静态 UI 组装阶段扩展**共享**传输 schema，加入 `compaction` 分支。此分支只验证内层是对象，并透传未知字段；版本、阶段、序号和摘要等语义仍由现有 compaction projector 校验。未知版本或坏业务字段走原始生命周期事件的兼容路径，不使整页合法历史失效。未知 `for`、非对象投影、坏工具卡片和非法持久事件仍报错；没有通用 catch、吞错或删除历史。

维护补丁同时更新 Connection 文件哈希、插件图 revision、HTML 中的 boot graph／预加载 URL，避免客户端继续命中旧 bundle。重复运行幂等；上游 schema 锚点变化时失败而非盲目替换。修复不更改 JSONL、Host 预算、压缩算法或工具执行，也不要求重新编译 Rust。

验收包括当前本机失败会话的 172 条真实事件（仅在内存读取，无原始聊天落盘到测试仓库），旧 decoder 精确复现两个 discriminator 错误，新 decoder 正常通过并保持消息 data 与压缩 view 完整。载体原有的额外事件字段过滤行为不在本次改动范围内。

2026-09-30 源码验收：Assembler 705 条检查通过；V100 上 Host 180 个单测、22 个集成测试、Projection 14 个单测通过（Host 另有 5 个显式忽略用例）；WebKit 历史缓存、窗口化以及关联投影回归通过。GitHub CI 仅接入新测试，尚未推送执行。
