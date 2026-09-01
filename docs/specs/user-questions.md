# 用户提问与等待交互规范

**Crate：** `xharness-interaction`  
**模型工具：** `ask_user_question`  
**上游兼容 Frame：** `question/requested`、`question/resolved`

## 目标

当模型缺少的是用户决定、偏好或系统无法自行取得的事实时，可以暂停当前 Tool Call，等待用户回答，
再使用原 Provider Call ID 继续同一个 Turn。该能力不是普通聊天提问，也不能靠一个仅存在于进程内的
`LoopCommand` 实现。

第一阶段冻结 Provider-neutral 类型、状态机和 Tool Registry 接口。Session/Host/Web 的正式持久接线
属于后续切片；前端应复用现有 DeepSeek Harness User Questions 组件。

## 模型输入契约

- 每次必须包含 1—3 个问题。
- 一个有限集合问题最多提供 3 个选项；布尔判断应表现为两个选项。
- `allowCustom=true` 时，用户可以只填写自由文本，也可以在选择一个选项后补充说明。
- 纯文本问题必须使用空选项和 `allowCustom=true`。
- 每题最多一个推荐选项。
- `destination=context` 是默认短期答案，只进入当前 Tool Result/Session 上下文。
- `destination=agent_markdown` 表示显式长期目标；Host 只能写入受管 AGENTS.md Memory Section，
  禁止接受模型指定的任意路径。
- 该工具必须独占一个 Tool Batch，禁止与写文件、运行命令等副作用工具并发发起。

模型在提问前应先读取可用上下文并使用可用工具取得事实。能够从 Workspace、Session 原始日志或网络
可靠取得的信息，不应重新询问用户。

## 回答动作

### `submit`

所有问题必须有有效答案。缺少任意一题时返回接口校验错误，不结束 Pending Interaction。

### `continue`

用户可以明确表示“不想回答，直接继续”。它是成功的 Tool Result，而不是错误：

- 没有答案：`status=skipped`；
- 只回答一部分：`status=partially_answered`；
- 已经全部回答：`status=answered`。

Tool Result 必须携带 `unansweredQuestionIds`，使模型明确知道哪些信息没有获得。模型应使用已有信息
继续，不得把 Skip 当作工具失败无限重试。

### 关闭或点掉卡片

关闭、最小化或切换页面不是回答，也不是取消。前端保存的半成品应通过 Draft 接口更新，Interaction
继续保持 Pending；重新打开或重连后恢复草稿。只有显式 `continue`、`submit`、Session Cancel 或
Host Policy Cancel 才能结算。

## 状态机

```text
Requested/Pending
    ├── DraftUpdated ───────────────┐
    ├── UI Dismissed（无状态变化） ┤
    ├── Submit ───────> Resolved    │
    ├── Continue ─────> Resolved    │
    └── Cancel ───────> Cancelled   │
                                      └── 可继续更新 Draft
```

同一 Interaction 的相同 Resolution 可以幂等重放；不同 Resolution 冲突必须拒绝。Cancel 同理。

## Tool Registry 边界

`AskUserQuestionTool` 生成普通 `ToolSpec` 并通过现有 `ToolRegistry::register()` 注册：

- `ToolConcurrency::Exclusive`；
- `ToolSettlement::External`；
- `ToolBatchPolicy::Standalone`，混合批次在任何 Handler 启动前整体拒绝；
- 继续经过 Schema、Guard、Lifecycle、Middleware、Observer 和结构化取消；
- 不使用普通 Tool Timeout；用户等待多久不应占用超时预算；
- Cancel 后仍必须在统一 Cleanup Grace 内收敛。

`UserQuestionProvider::ask()` 是 Host 接线点。正式实现必须在开始等待前持久化并 Flush
`question/requested`，在返回 Tool Result 前持久化并 Flush `question/resolved`。Provider 实例可以按
Session 绑定，因此模型参数不需要携带 Session ID、文件路径或 Owner ID。

## 持久事件与恢复

冻结事件类型：

- `question/requested`；
- `question/draft-updated`（内部持久状态，不要求投影成上游 Mux Frame）；
- `question/resolved`；
- `question/cancelled`。

正式 Session 接线必须保证：

1. Assistant Tool Call 先落账；
2. `question/requested` Flush 后才向 Web 发布；
3. 回答先写 `question/resolved` 并 Flush；
4. 使用原 `execution_id/provider_call_id` 生成 Tool Result；
5. Host 重启从 Pending Question 重建 UI 和原 Turn；
6. 相同 RPC ID/答案重放原响应，不同答案复用 ID fail closed；
7. 未决 Question 不占用活跃 Provider、Process 或 PTY Task。

## 长期与短期答案

短期答案始终通过 Tool Result 进入当前 Context。`agent_markdown` 答案还需要由 Host 的受管 Memory
Sink 规范化后写入 AGENTS.md 的专用区段，并使用 CAS/原子写保护用户已有内容。写入失败不得伪造
成功，模型也不能指定任意路径或覆盖整个文件。

## Compaction 后续任务

第一阶段不改变 Compact。正式持久接线时必须补充以下规则：

- 未解决的 Assistant Tool Call、`question/requested`、Draft 和关联 ID 禁止被 Compact；
- Question 解决并生成 Tool Result 后，问、答、Tool Result 作为一个原子单元选取安全切点；
- 原始 Session 中已有答案时，Context 恢复应优先检索原记录，再考虑询问用户；
- 长期 `agent_markdown` 内容进入下一轮 Prompt 的预算和去重策略必须独立审计。

## 测试矩阵

- 1—3 个问题和每题 0—3 个选项；第四个问题/选项拒绝；
- 有限选择、纯自定义、选择加补充文本、未知选项；
- 回答一半后点掉，Draft 保持 Pending；
- 空回答直接 Continue、部分回答 Continue、完整 Submit；
- 相同 Resolve 幂等、不同 Resolve 冲突、Cancel 后拒绝回答；
- `agent_markdown` 只产生受管目标，不接受 Path；
- 普通 Tool Registry 注册、重复名检测、结构化 Tool Result；
- External Settlement 不触发普通 Tool Timeout，Cancel 仍有界收敛；
- 后续补充 Requested/Resolved/Tool Result 每个 Flush 切点的 SIGKILL 与 Web 重连恢复。
