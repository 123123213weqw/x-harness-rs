# 会话自动标题规范

**状态：** 2026-09-07，Host 实现；桌面/Web 共用同一个后端。发布安装单独验收。

## 产品语义

每个会话默认接受一次模型生成标题，不是每条消息或每个 Loop 步骤都改名。
先用用户文字作为临时标题；首个有实际内容的 Turn 结束后后台总结。仅有问候、
“好的”“继续”等输入时延后，后续有效任务仍可触发。失败的 Turn 也可总结用户目标，
但不能把尚未完成的工作命名成“已完成”。

启动时对旧会话补生成：仅无标题或 `source=fallback` 的会话；已有 `user` 或
`provider` 标题不覆盖。来源不明的继承标题也保留。这里的“一次”指最多一次接受并
持久化的自动标题，不保证网络调用 exactly-once；失败允许有界重试。

## 分层和触发

- `xharness-host::titles` 管后台队列；不向模型注册 Tool，不改 Core Loop。
- `AgentRuntime::auxiliary_model(route)` 从现有 Registry 取得准确路由和独立最低推理档位。
  未声明档位则不发送该参数，绝不猜 `off`；不继承主会话 `high`。
- `InputCommitted` 排队产生临时标题；Driver 在 Turn 边界再次排队；恢复启动、
  Provider 配置变更、选择模型也排队。排队去重，单 Worker，全局并发 1。
- 请求开始前若有 Agent 正在运行则延期；主会话不等待标题完成。
  这不是 GPU 优先级抢占：后台请求已经发出后到达的新任务可能与它短暂重叠。
- 没有结束的 Turn 不触发模型总结；恢复/新 Turn 结束后再次调度。

## 输入输出上限

只抽取首条及最近一条有效用户输入、最近一条 Assistant 正文，每条最多 1536 UTF-8
字节（边界安全），最多约 4.6 KiB。原始工具结果、Tool Arguments、reasoning、附件和
provider opaque items 都不传入。输入片段作为数据，不作为新的指令。

标题请求：`tools=[]`，最多 256 输出 Token，30 秒总超时，响应正文与 reasoning 累计
最多 16 KiB。只接受已完成的普通文本，不接受工具调用、输出截断、空结果、换行、
JSON/Markdown 块和超过 80 字符的标题。Prompt 目标为中文约 6–24 字或英文 3–9 词。
自定义 Provider 未声明 finish reason 时遵循现有 ModelProvider 的 Completed 合约；
明确 Length/Incomplete 则失败。所有失败保留临时标题，不让主对话失败。

## 持久化和竞态

沿用 `session/title`：临时 `source=fallback`，模型 `source=provider`，人工 `source=user`。
模型标题附带实际 provider/model 和输入 messageSeqs，复用原 Web `title` 投影；
标题事实和进度都不进入 `derive_messages()`，不改变模型历史/Compact。

新增内部事件 `xharness/title-generation`：

- `version=1`、`attempt=1..3`；
- `phase=pending|retry|completed|exhausted`；
- `retry_at_ms` 是重试/崩溃恢复的最早时间。

先持久化 Pending 再请求；正常成功把标题与 Completed 原子追加。总计最多三次模型
尝试（含崩溃时的预约）。429、408、5xx/可重试网络错误、空/不完整结果可重试；
退避 5/10 秒并尊重 Retry-After（上限一天）；其他不可重试错误直接耗尽。
Store 过渡失败最多连续重试两次，只打印固定脱敏诊断；未来启动可重新检查。

复用会话 admission gate，但 HTTP 期间不持锁；提交前重新校验标题版本、预约 attempt、
会话存在和当前 provider/model。人工改名或删除则丢弃结果；模型已切换则不提交旧标题，
剩余尝试用新路由。请求超时/应用退出取消 transport，进度留待下次启动判定。

## 启用与兼容性

正式 `xharness-host-app` 启动服务后启用，退出先停止标题 Worker；Web 和 Tauri Sidecar
相同。嵌入式 Host 默认 `auto_titles=false`，宿主显式启用并调用 start/shutdown。
历史使用者升级后可产生少量标题 API 调用，使用会话已经配置的模型，不另换供应商。

新增持久事件对升级读取旧日志兼容，但**旧版二进制不能保证读取新增事件**。
发布前备份状态；降级应恢复对应版本备份，不能直接拿旧程序读取升级后日志。
本功能不改已有对话文本，不删除日志，不涉及 schema 破坏性原地迁移。

## 回归与后续

测试覆盖旧会话补齐/重启去重、独立推理和空工具、人工标题竞态、切模型/删除竞态、
三次失败上限、崩溃预约恢复、问候延后、前台运行延期、关闭取消、超时、协议错误、
Retry-After、UTF-8/空白边界、元数据序列化和真实 Host Prompt→Loop→标题投影链路。

后续另列 TODO：用户点“重新生成”、大批历史的可视化补齐进度、可配置标题专用模型/
预算、专用 Debug 统计、真实厂商模型标题质量与三平台发布包验收。
