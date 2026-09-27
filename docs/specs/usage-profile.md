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

设置中的「使用档案」显示累计量、单日峰值、活跃天数、会话数、每日热力图及每周/累计视图。热力图按 26 周一页翻阅；单日 Tooltip 展示值。中文和英文均须说明 UTC、Provider 报告口径及当前列表范围。

## 回归

1. 流式与最终 Usage 不双计，跨日修订只保留最终一天。
2. Fork 复制前缀不重复计数，后续子会话 Usage 正常计数。
3. Typed Log 冷恢复与 Web Event 实时投影一致。
4. 设置页对缺失、不合法、空 Usage 及旧版仅有 `tokenUsage` 的会话不伪造每日记录。
