# Prompt 组装与注入规范

**所属层：** 未来的 `xharness-prompt`，由 `xharness-host` / `xharness-agent` 组合
**状态：** 待实现；当前 Web Host 只保存 Preset 文本，没有注入 System Message。

## 目标

Prompt 不是散落在 Host 代码里的字符串。每次模型请求必须由确定性的 Prompt Registry 组装，
并把模型实际看到的 System 内容、工具集合和版本写入 Request Header。UI 中“选中了预设”不等于
模型已经收到预设。

## Section 顺序

建议固定顺序如下：

```text
身份与总目标
-> 安全/权限与审批规则
-> Workspace/平台能力
-> Coding 工作流
-> 工具选择指导
-> 动态上下文/Skill
-> Provider 专用补充
```

每个 Section 具有稳定 ID、版本、优先级、Scope 和 Token 预算。相同输入必须生成字节一致的
System Message。Provider 专用内容只能通过显式 Adapter 注册，禁止根据错误自动猜协议。

## 工具说明与 System Prompt 的边界

- 工具 `name/description/JSON Schema` 进入协议原生 `tools` 字段。
- System Prompt 说明整体工作流、失败处理、何时停止和工具之间的选择原则。
- 二者都在每次 Prepared Call 中计入上下文预算，但不能互相冒充。
- 工具不可用时必须从本轮投影中移除或提供结构化不可用状态，不能只依赖 Prompt 劝模型别用。

最小 Coding Prompt 必须明确：已确认的 Sandbox/Provider 能力错误不要原样重试；读取大文件先
分页；获得足够证据后直接回答；有副作用操作先审批；工具错误是观察结果，不是要求无限探索。

## 持久化与诊断

每次 Request Header 至少保存 Prompt Version、Section ID/Version、最终 System 文本 Hash、
工具定义 Hash 和动态变量的无敏感信息投影。凭据、环境 Secret 和审批 Token 禁止进入日志。
Session Export 应能回答“这一轮模型实际看到了什么”，而不是只展示 UI 预设名称。

## 当前实现差距

- `AgentPreset.content` 仅存于 `BasicHost` 内存状态。
- `run_turn` 以 User 历史创建 `LoopRequest`，没有追加对应 `Role::System`。
- 全部 14 个工具定义会随每个 Step 发送；这是工具 Schema 注入，不是完整 Coding Prompt 注入。
- 没有 Prompt Version、Section Registry、Token Budget 或 Request Header Hash。

## 验收标准

测试必须直接解析真实 Provider 请求体，断言 System Message、Section 顺序、选择的 Preset、工具
子集和版本；切换 Preset 后下一 Turn 生效；不存在或超预算 Section 明确失败；Session Export
能够重建相同模型可见 Prompt；任何测试不得用“Host 状态里有字符串”代替网络请求断言。
