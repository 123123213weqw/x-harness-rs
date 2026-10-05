# Assistant 消息可见性生命周期

## 问题

工具参数以部分 JSON 到达时，Assistant preparing 提示会物化一个 chat 节点。
参数完成后，如果没有正文或 reasoning，该提示应隐藏。旧定义却返回 `null`，
触发 assembler 的 `withdrew materialized target "chat"` 异常。
此外，argument-only 续传片段可能携带 `name: ""`；不能据此清除已有工具名。

## 不变量与修复边界

- 从未物化且没有可显示内容：返回 `null`，不创建空消息。
- 已物化但暂时没有可显示内容：以同一个 key 发布 `visibility: hidden`。
- 后续正文、reasoning 或 preparing call 可以重显该 key，不重复物化。
- 空／缺失的续传名称保留已有名称；参数逐段完整追加，既有调用 ID 不变。
- 重试、取消、完成消息、分页恢复沿用原有投影边界。
- 不移除或吞掉 assembler 的节点撤回异常；其他违反契约的定义仍须报错。
- 不修改 Host 协议、模型请求、工具执行、权限或历史文件格式，不增加缓存。

生产改动仅位于 `ui/src/modules/conversation/conversation-nodes/assistant.ts`。
前端生成产物由仓库构建脚本重新生成，不复制旧工作区的 bundle。

## 回归设计

`scripts/test-assistant-visibility-lifecycle.mjs` 执行实际 ModuleLoader 工厂、
ConversationNodeAssembler 与 Chat builder，不使用替代投影器。

- 2,704 种有界事件语料的分帧组合，287 种历史分页切分。
- partial → complete、block-end、多调用、迟到 reasoning。
- 重试清空正文／提示、空响应、usage-only、取消及未关闭的尾部。
- 空／缺失名称续传、重复事件去重、隐藏／重显的 key 身份。
- 从未物化的空行保持不存在；故意撤回已物化节点仍被拒绝。
- 固化 2026-10-03 隔离编程验收捕获的 DeepSeek 工具参数片段；调用 ID
  已规范化，未包含私人会话或凭据。不在回归中访问真实模型。
- 冻结参考工厂必须复现异常，以证明测试对该缺陷敏感。

这些数量仅为所选有界语料的所有分帧／分页组合，不代表完整状态空间穷举。

## 2026-10-04 移植验收

基于公开主分支 `c8440ae` 的独立工作区移植，原开发工作区不修改。
同一新增测试在未修复主分支上真实失败，修复并重新构建后通过。
严格 TypeScript、前端构建和生成产物 freshness 检查通过。
9 条已有投影／重试／生命周期／Compact／历史事务回归命令通过；
Chromium、WebKit 的实际 Conversation DOM 回归均通过。
完整跨平台 CI 在 PR 中继续执行；不因本地 JS 测试通过就宣称全平台验收。
不本机编译 Rust，不部署或重启生产软件。

复现命令（JS 可本地执行）：

```sh
npm ci --prefix ui
npm run typecheck --prefix ui
npm run build --prefix ui
npm run check:build --prefix ui
node scripts/test-assistant-visibility-lifecycle.mjs
node scripts/test-assistant-projection.mjs
node scripts/test-retry-turn-projection.mjs
node scripts/test-ui-lifecycle-recovery.mjs
```
