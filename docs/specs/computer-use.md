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

## 用户可见状态

- Web 与 Tauri 共用 `@xlang/xharness-client-ui-computer`，为 `computer` 注册专用工具卡，而不是退回通用 Tool call。
- 浏览器运行时在页面顶端显示隐私状态条；macOS 桌面壳把相同活动状态通过受限 IPC 投影为原生 `NSPanel`。原生面板置于其他 App 上方、跨 Space 可见、鼠标穿透，不创建第二个 WebView，也不抢走当前 App 的焦点。
- Computer 调用运行期间，隐私状态持续区分“查看屏幕/读取界面结构”和“控制鼠标键盘/窗口”。桌面壳存在时页面条自动隐藏，避免同一状态显示两次；完成、失败或中止后立即消失。
- 切换会话导致工具卡卸载时，不得立即隐藏仍可能运行的系统级操作；状态条保留到结果到达，并以 70 秒 watchdog 兜底。它比工具的 60 秒执行上限略长，不会永久残留。
- 原生层按 `callId` 保存并发活动，最新活动优先显示，结束后恢复上一项；前端串行发送 start/stop，避免 IPC 乱序使已完成状态复活。桌面壳再次执行独立 70 秒 watchdog，前端崩溃也不能永久留下浮层。
- 原生面板设置 `NSWindowSharingNone` 作为防止提示条进入截图的第一层保护；正式验收仍需覆盖目标 macOS 版本，因为系统捕获实现可能调整该语义。
- 历史工具卡只展示动作、目标、frame 和观察结果计数。完整 AX 树不直接挂载到对话 DOM，仍可通过统一 Inspect 面板查看，避免为了安全提示重新引入长会话内存峰值。
- 状态条使用 `role=status` 和 assertive live region；减少动态效果时停用脉冲动画。

## 动作

| action | 作用 | 关键字段 |
|---|---|---|
| `observe` | 屏幕、显示器、窗口和权限快照 | `detail`、`region`、`include_screenshot`、`include_accessibility` |
| `move` | 移动指针 | `x/y` 或 `node_id + frame_id` |
| `click` | 左/右/中键，1–3 次点击 | `button`、`count`、坐标或节点 |
| `drag` | 按路径拖动 | `path`、`duration_ms`、`button` |
| `scroll` | 像素级滚动 | `delta_x/delta_y`，可选 `x/y` 或 `node_id + frame_id` |
| `type` | 输入 Unicode 文本；可先聚焦语义节点 | `text`，可选 `node_id + frame_id` |
| `keypress` | 单个按键或快捷键 | `keys`、`modifiers` |
| `wait` | 等待 UI 稳定 | `duration_ms`（1–30000） |
| `window` | 列表/聚焦/移动/缩放/最小化/最大化/全屏/关闭 | `operation`、`surface_id`、几何字段 |

工具根 Schema 使用仓库支持的可移植 JSON Schema 子集。不同 action 的条件约束由 `ComputerRequest::validate` 在执行任何副作用前完成。

## 坐标、帧和节点

- 坐标统一为 macOS logical point，不使用截图物理像素。
- `observe` 返回显示器 logical bounds、physical pixels 和 scale，支持 Retina、多屏和负坐标。
- 每次观察生成单调递增 `frame_id`。
- 使用 `node_id` 时必须同时提交生成它的 `frame_id`；帧或节点过期返回可重试的 `stale_frame` / `stale_node`，禁止在未知位置点击。
- 语义观察返回有界的扁平 AX 树，节点以 `parent_id` 保留层级，同时附带 role、label、bounds、状态与可执行 actions。
- 节点数量/深度按 `detail` 分档：low 80/4、auto 220/8、semantic 300/10、high 500/12；适配器硬上限为 600/16，并返回 `truncated` 和 `visited`，禁止无界遍历桌面。
- `node_id` 是当前 `frame_id` 内的定位句柄，不承诺跨观察稳定；任何后续节点操作都先检查帧，路径变化时 fail closed 并要求重新观察。
- 单次左键单击优先执行节点的 `AXPress`；没有该 action、右键/多击/带修饰键时才退回节点中心坐标。`type` 可先通过 AX 聚焦目标，`scroll` 可先移动到节点中心。
- `AXSecureTextField` 的值固定输出 `<redacted>`；普通可编辑文本框不回传当前内容。其余值与文本字段均限长并清理控制字符。

## 截图与多模态

- 未显式填写 `include_screenshot` 时：视觉模型默认带截图，文本模型默认只返回语义观察；显式 `detail=semantic` 对视觉模型也默认不截图。
- 文本模型显式请求截图时失败，并提示切换视觉模型或使用 `detail=semantic`。
- 截图进入现有 AttachmentStore，并通过 `xharnessContentBlocks` 发送给 Provider。
- 图片大小继续受统一附件上限约束，避免工具结果和事件日志无限膨胀。

## 取消和失败语义

- 截图、JXA/Accessibility、等待和输入循环均观察 CancellationToken。
- 拖动在取消或中途失败时仍发送 mouse-up，避免系统遗留按键状态。
- 普通 AppleScript/JXA 有独立 8 秒上限；有界 AX 快照为 12 秒；整个工具有 60 秒上限。
- 窗口 ID 不再存在、权限撤销、辅助功能超时均返回结构化错误，不猜测成功。
- 流程恢复不得盲目重复 GUI 副作用；Host 现有 tool-call execution id 和生命周期日志仍是权威恢复边界。

## 测试门禁

1. Linux 远程：全工作区 fmt/check/test/clippy，验证跨平台桩和协议测试。
2. macOS CI：编译真实 FFI 分支，执行无副作用的参数、键码、surface ID、AX 快照反序列化和预算档位测试。
3. Chromium/WebKit：验证查看/控制文案、浏览器状态条、Tauri IPC start/stop 顺序、完成后清理、会话切换保留、工具卡摘要和 Inspect 入口。
4. 本机人工验收：分别撤销/开启 Accessibility 和 Screen Recording，验证 fail-closed；随后覆盖九类动作、Retina、多屏、取消拖动和用户接管，并确认原生提示在其他 App、全屏 Space 中可见且不进入截图。
5. 视觉模型真实验收：`observe → click/type → observe`，确认截图以附件块传输而不是写入文本历史。

## Windows 适配（开发分支，未发布）

- 复用相同 `ComputerDriver` / 单一 `computer` / 附件投影与工具卡；仅
  `danger-full-access` 注册。macOS API 与调用方式不改变。
- `xharness-computer-windows` 的 Host 侧是安全 Rust。原生 UIA/Win32 仅在
  打包的同一 Host 可执行文件的私有 `--computer-worker` 子模式内运行；
  在配置、租约、Provider、HTTP 服务初始化前分流。没有 Python/PowerShell
  或额外安装运行库，也不从模型参数解析可执行路径。
- 每次调用启动一个进程，先挂入 kill-on-close Job，再恢复执行。超时/取消
  先通过 stdin EOF 请求合作取消（输入 guard 释放按键/鼠标），最多等待
  2 秒后终止并回收进程。同步 UIA 的阻塞不会把 Host 线程永久挂住。
- 同一 Host 以及同一登录会话的其他 Host 共享串行门禁；COM 的 MTA 线程
  不拥有窗口，原生状态提示使用独立线程的原生窗口，不新增 WebView。
  提示不抢焦点、鼠标穿透、置顶并从捕获中排除；建立提示失败时不执行操作。
- Windows 使用 **physical_desktop_pixels**，PMv2 只设置在 worker 线程。
  支持虚拟桌面负原点，截图返回 `screenshot_bounds`；不把 Retina/macOS
  logical point 规则套用到 Windows。显示器元数据包含 bounds/scale/dpi。
- 控件树限于前台窗口的 UIA Control View，有节点/深度/遍历/时间预算；
  使用 CacheRequest 批量属性读取，不请求 Value/Text 内容。密码控件隐藏
  label/value 并拒绝输入。窗口列表最多 128 项。
- Host 只保存最近帧及有界定位信息。帧最长 30 秒，每次原生 dispatch 消耗
  旧帧；动作后返回的新观察可继续使用。检查 HWND/PID/class、前台身份和
  屏幕几何，节点重新定位必须匹配 UIA runtime ID，绝不按旧路径猜测点击。
- 九个 action 都有路由：observe/move/click/drag/scroll/type/keypress/wait/window。
  UIA Invoke 优先，不能在已调用 Invoke 失败后再补一次坐标点击。Unicode
  输入不使用剪贴板。Windows scroll 为 wheel units（120/档），y 正值向下、
  x 正值向右；不能宣称原生滚轮精确等于跨 App 像素距离。
- window 支持列表/聚焦/移动/缩放/最小化/最大化/关闭。Windows 的 fullscreen
  是 App-specific，不伪装为 maximize；返回明确不支持，由模型观察菜单/快捷键。
- 不提权，不申请 UIAccess，不切换安全桌面，不关闭 UAC。锁屏、无交互
  桌面或管理员窗口造成的 API/输入拒绝明确失败。SendInput 不能可靠判定
  UIPI 是唯一原因，因此只报告实际插入事件数，不臆测原因。
- 输入操作的 worker 失联、部分输入、取消、输入后的观察失败都是 non-retryable；
  纯观察失联可重新观察，取消仍不自动重试；
  不自动重放 GUI 副作用。合作取消释放本次持有的输入；进程被外部强杀
  的时刻不能承诺系统输入状态已恢复，必须单独验收异常回收行为。
- 私有协议限制请求 128 KiB、元数据 1 MiB、PNG 16 MiB/16 MP。PNG 二进制
  传输到原附件管线，不进 JSON/Base64 文本历史。

参考：[UIA threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)、
[SendInput / UIPI](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)。

原生测试必须在独立交互桌面运行，不把 hosted runner 的编译/安装成功当作
GUI 能力验收。`native-acceptance` 是显式 fixture feature，默认产品不包含
测试窗口；probe 的真实 UI 输入还需验证中文/代理对、按钮、滚轮、取消拖动、
DPI/多屏、锁屏/UAC、用户接管和 UIA 卡死，再考虑安装包发布。

Windows monitor scale is reported by `GetScaleFactorForMonitor` (null on unavailable metadata), not `GetDpiForMonitor` on a PMv2 thread. UIA focus calls complete before owned modifiers are held; foreground and display geometry are revalidated after capture.

Windows foreground identity is normalized with `GetAncestor(..., GA_ROOT)`. UIA focus on an Edit child must not look like an app switch; a different top-level window or popup is still rejected. The disposable-VM regression reproduced the old false interruption with the same PID and child class `Edit`.

原生用例及未验收边界见 [2026-10-05 Windows 验收记录](../evidence/windows-computer-20261005/README.md)。
