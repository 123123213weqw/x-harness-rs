# 使用档案（Profile）规范

**涉及模块：** `xharness-projection`、`xharness-host`、Web Settings 插件。

## 口径与数据源

- 仅使用 Session 事件日志中 Provider 报告的 Usage，不扫描对话正文，也不把字符数伪装成真实 Token。缺失 Usage 的请求不计入。
- 每个有效样本按事件的 UTC 毫秒时间归入 UTC 自然日。前端显示 UTC 日历；不按会话的最后更新时间归属整段历史。
- 同一 `(turn, step)` 的流式 Usage 与最终 `assistant/message.usage` 是同一样本的修订，后者替换前者；若修订跨 UTC 零点，必须从旧日期扣除并归入新日期。
- Fork 复制的父会话事件不得在子会话重复记账。遇到 `session/fork-origin` 后，子会话 Profile 投影清空复制前缀，再累计后续独立请求。
- 数值分为未缓存输入、缓存读取、缓存写入、输出四桶。总量为四桶之和；这是用量而非费用。已归档或未列入当前会话列表的会话不包含在设置页汇总中。

## Web 契约

`session.list` 的 `projectionValues.dailyTokenUsage` 及历史投影包含升序数组：

```json
[{"dayStartMs": 1789776000000, "uncachedInputTokens": 100, "cacheReadTokens": 20, "cacheWriteTokens": 0, "outputTokens": 8}]
```

实时更新使用同名 `dailyTokenUsage` 投影键。恢复与实时投影必须一致。

## 更新与冷启动保留

- 安装包内仅包含程序和静态 UI；Session JSONL 仍保留在稳定的用户数据目录，不按软件版本更换路径。Profile 不依赖浏览器的端口、内存缓存或 LocalStorage。
- 为避免启动时把所有聊天加载进内存，每个有效 `.catalog` 索引保存 `metricSnapshot`：`version=1` 和 `values` 中的 `tokenUsage`、`dailyTokenUsage`、`sessionStats`、`contextPressure`。只保存公开统计视图，不保存模型提示词、对话正文或逐步骤计数器。
- 冷会话直接用该快照响应 `session.list`，不必先打开聊天。快照只读，不能作为增量 reducer 状态；真正打开/继续聊天后仍从完整日志重建，避免修订重复记账。
- 索引须通过现有文件指纹和 `nextSeq` 验证；失效、缺字段、未知快照版本均是缓存缺失，而不是“用量为零”。`sessionListMetadata.metricsPending=true`，UI 明确显示后台恢复和部分统计。
- 旧版本的有效索引首次启动后逐会话补建统计，优先完成必要任务与旧日志恢复，**不阻塞 Ready**。补建只保留指标，不打开历史、不创建 Agent、不执行工具；与用户打开聊天共用同一会话恢复锁。以后重启仅读取小索引。
- 索引上限 1 MiB，兼容多年每日统计。原子写入失败、日志并发变化或损坏时保留日志，报告 startup issue，不用不可信快照覆盖统计。

设置中的「使用档案」显示累计量、单日峰值、活跃天数、会话数、每日热力图及每周/累计视图。热力图按 26 周一页翻阅；单日 Tooltip 展示值。中文和英文均须说明 UTC、Provider 报告口径及当前列表范围。

## 回归

1. 流式与最终 Usage 不双计，跨日修订只保留最终一天。
2. Fork 复制前缀不重复计数，后续子会话 Usage 正常计数。
3. Typed Log 冷恢复与 Web Event 实时投影一致。
4. 设置页对缺失、不合法、空 Usage 及旧版仅有 `tokenUsage` 的会话不伪造每日记录。
5. 新索引冷启动：未打开的会话立即显示每日/总量，JSONL 热缓存仍为空；打开聊天前后数值一致。
6. 旧索引迁移：恢复期间显示 pending，不伪造空历史；后台补建后及再次冷启动数值一致，历史和 Agent 不被加载/启动。
7. 多年每日统计超过旧的 32 KiB 限制仍可写入，索引源指纹失效及未知版本触发回源而非清零。
