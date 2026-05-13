# Computer Use 工具规范（macOS 首版）

## 目标

Computer Use 通过**一个**模型工具 `computer` 提供桌面观察和操作，不为每个动作注册独立工具。这样可控制工具定义的上下文成本，也让调度、审批、取消和日志沿用现有 `xharness-tools` 主链路。

## 分层

```text
模型 / Provider
      │  computer(action=...)
      ▼
xharness-computer                 协议、校验、ToolSpec、媒体抽象
      │ ComputerDriver
      ▼
xharness-computer-macos           CoreGraphics / Accessibility / 截图
      │ ComputerOutput
      ▼
xharness-host-app                 权限策略、附件持久化、多模态投影
```

- `xharness-computer` 不依赖操作系统和 Host。
- `xharness-computer-macos` 是唯一允许接触 macOS FFI 的边界。
- Host 负责把 PNG 存为会话附件；工具文本和 Debug 日志不放 Base64。
- 非 macOS 构建保留不可用适配器以支持全工作区检查，但 Host 不注册工具。

## 注册策略

- macOS + `danger-full-access`：注册一个 `computer`。
- `workspace-write`：不注册。GUI 输入无法被工作区文件沙箱约束，不能伪装成沙箱内能力。
- macOS Accessibility / Screen Recording 权限由适配器在每次操作前探测，缺失时返回 `permission_required`，不在后台自动弹授权窗口。
- 全部 Computer 调用使用 `ToolConcurrency::Exclusive`。键盘、鼠标和前台窗口是全局资源，不允许同批并行。

## 动作

| action | 作用 | 关键字段 |
|---|---|---|
| `observe` | 屏幕、显示器、窗口和权限快照 | `detail`、`region`、`include_screenshot`、`include_accessibility` |
| `move` | 移动指针 | `x/y` 或 `node_id + frame_id` |
| `click` | 左/右/中键，1–3 次点击 | `button`、`count`、坐标或节点 |
| `drag` | 按路径拖动 | `path`、`duration_ms`、`button` |
| `scroll` | 像素级滚动 | `delta_x/delta_y`，可选 `x/y` |
| `type` | 输入 Unicode 文本 | `text` |
| `keypress` | 单个按键或快捷键 | `keys`、`modifiers` |
| `wait` | 等待 UI 稳定 | `duration_ms`（1–30000） |
| `window` | 列表/聚焦/移动/缩放/最小化/最大化/全屏/关闭 | `operation`、`surface_id`、几何字段 |

工具根 Schema 使用仓库支持的可移植 JSON Schema 子集。不同 action 的条件约束由 `ComputerRequest::validate` 在执行任何副作用前完成。

## 坐标、帧和节点

- 坐标统一为 macOS logical point，不使用截图物理像素。
- `observe` 返回显示器 logical bounds、physical pixels 和 scale，支持 Retina、多屏和负坐标。
- 每次观察生成单调递增 `frame_id`。
- 使用 `node_id` 时必须同时提交生成它的 `frame_id`；帧或节点过期返回可重试的 `stale_frame` / `stale_node`，禁止在未知位置点击。
- 首版语义节点至少覆盖可见窗口；后续 AX 树扩展不得改变现有 action 协议。

## 截图与多模态

- 未显式填写 `include_screenshot` 时：视觉模型默认带截图，文本模型默认只返回语义观察。
- 文本模型显式请求截图时失败，并提示切换视觉模型或使用 `detail=semantic`。
- 截图进入现有 AttachmentStore，并通过 `xharnessContentBlocks` 发送给 Provider。
- 图片大小继续受统一附件上限约束，避免工具结果和事件日志无限膨胀。

## 取消和失败语义

- 截图、JXA/Accessibility、等待和输入循环均观察 CancellationToken。
- 拖动在取消或中途失败时仍发送 mouse-up，避免系统遗留按键状态。
- AppleScript/JXA 有独立 8 秒上限；整个工具有 60 秒上限。
- 窗口 ID 不再存在、权限撤销、辅助功能超时均返回结构化错误，不猜测成功。
- 流程恢复不得盲目重复 GUI 副作用；Host 现有 tool-call execution id 和生命周期日志仍是权威恢复边界。

## 测试门禁

1. Linux 远程：全工作区 fmt/check/test/clippy，验证跨平台桩和协议测试。
2. macOS CI：编译真实 FFI 分支，执行无副作用的参数、键码、surface ID 测试。
3. 本机人工验收：分别撤销/开启 Accessibility 和 Screen Recording，验证 fail-closed；随后覆盖九类动作、Retina、多屏、取消拖动和用户接管。
4. 视觉模型真实验收：`observe → click/type → observe`，确认截图以附件块传输而不是写入文本历史。

