# 运行中切换权限（#64）

## 产品契约

用户可在运行中选择 workspace-write / danger-full-access。选择被持久化，但不会改写
已经构建的沙箱、工具执行器或已发出的系统提示词。新权限在**下一个 turn 准备快照点**
生效，不是在当前 turn 的下一个模型 step 生效。

- `permission_preset`：保留既有字段和 PermissionPreset / SandboxMode / ApprovalPolicy
  事件，代表最新选择。连续成功修改取最后一次，重启仍恢复该选择。
- `active_permission`：Host 的运行快照，不作为用户设置持久化。系统权限段落与执行器
  从同一快照产生，当前轮的工具不会被重新创建。
- Web `permissions` 投影保留 options/currentValue，增加 activeValue、pending、effectiveAt。
  空闲时 activeValue 为 null；运行中不同于选中项则 pending=true。
- 当前会话继续复用 `/permission` 命令入口；没有新增模型工具或第二套权限写入协议。
  单独查询 `/permission` 同时返回选中值、当前轮生效值和 pending 状态。

## 实现边界

复用 Host 会话 gate 容器，增加独立权限 lane：权限写入与快照捕获串行。
不让 Runtime 工厂等待普通 admission/control lane，避免“控制请求等待 Agent 回执，
Agent 又等待同一把控制锁”的互等。新选择写入成功后才更新投影，不乐观修改执行权限。

普通非持久 Driver 捕获一次权限及 PromptAssembly；持久 Runtime 在实际 factory.build
处重新捕获，而不是沿用入队时缓存的配置。Goal / Schedule 自动续轮也走这个工厂。
Host 对持久运行的投影观察者不能重复发布另一份 active 快照。

当前轮创建的子 Agent 继承当前执行权限，而非待生效选择；已启动子 Agent 不被追溯修改。
已经在运行的后台 Job 不会因权限选择而被自动降权/终止。若希望立即收紧，停止当前任务，
并按需单独停止既有后台 Job。

## UI

- 运行本身不禁用选择器；只读状态、正在保存或风险确认仍锁住对应交互。
- Full Access 保留现有风险确认，不因支持运行中切换而跳过。
- 保存未完成显示“保存中”；成功且待生效显示“下一轮生效”。Hover 说明当前轮权限，
  以及立即收紧需停止当前任务、后台任务需单独停止。
- 保存失败回到后端的已保存选择，不制造成功状态。
- 设置页既有“选择新会话的默认权限模式”说明保持；修改默认值不改变已有会话。
- UI 和 Rust 需成对发布。只部署新 UI 到旧后端仍会遇到旧后端拒绝。

## 验证范围

- 两种 Runtime 的真实 Loop + 可控 Provider：第一轮保持旧权限；在切换前已排队的
  第二轮获取最后一次新选择，模型看到的权限段落与工具工厂参数一致。
- 连续修改、非法值、降权延迟、空闲状态、持久化重启恢复。
- 注入权限写入失败：不更新选择；24 轮快照/修改并发；普通控制 gate 与准备快照互不阻塞。
- 当前轮等待工具审批时改 Full Access，工具仍不执行，只有原审批回答才放行。
- 原 Goal、Schedule、Delegation 测试一并回归；不把模拟 Provider 测试声称为线上 DeepSeek 实测。
- Node 执行打包的 PermissionSelect：运行可选、只读禁用、Full Access 确认、保存失败回退、
  当前与待生效说明、资源哈希；CI 增加同一入口。

Plan 与 Agent 预设切换不在本次放开范围。

## 2026-09-12 验收结果

- 全部 Rust 编译、测试在同步源码后的 WZU_Server 执行，无本机 Rust 编译。
- Host：106 单元 + 19 集成；Host App：44；Goal：18；Schedule：5，合计 **192 通过**。
  另有原有 crash_matrix 1 项 ignored，未计入通过数。
- Host 全 target Clippy `-D warnings` 通过。
- 权限选择器、消息编辑、上下文计量、Assistant 投影、模型控件和 Context 插件 Node 回归通过。
- Permission 补丁从上一次 bundle 可精确重现本次产物，重复执行幂等，插件哈希和 HTML 同步。
- 顺带修正组装脚本 shebang 必须位于第一行，并在 CI 增加语法检查，避免组装启动即失败。
- 未推送、未发布安装包、未重启或替换用户正在运行的应用；不等于线上已生效。
