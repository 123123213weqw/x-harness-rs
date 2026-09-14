# 默认 Computer Use 行为实验与 Browser Use 复用分析

2026-10-06，真实 DeepSeek Flash 在独立 Windows 克隆中完成三轮默认 Computer Use 搜索与读价任务。13 次模型工具调用全部成功，未出现 stale_frame；没有修改生产帧逻辑、30 秒 TTL 或工具说明。这支持先保留现有行为，而不是因强制 observe_after=never 的对照实验立即重构运行时。

## 默认行为实验

模型输入为原始注册工具定义。删除上轮测试控制器强制模态、强制 observe_after=never 和强制重新 observe 的指令与校验；模型自行选择观察细节、截图、节点或坐标。实际参数原样执行，没有偷偷填入答案、修改 frame_id 或自动重放动作。

实验仍限制在隔离购物页内，允许观察、点击、输入、键盘和滚动，每次一个调用；不执行 shell、DOM 自动化、登录、购物车或购买。这是任务范围与测试隔离，不是要求模型遵循固定操作顺序。每轮新历史，最多 15 个模型响应；模型自行结束。

源码与二进制沿用已验收的 16c5568041b165a8136ac6c6fc09a4e864bde860，模型 deepseek-flash，thinking disabled、temperature 0、max_tokens 1400。原生工具、ToolRegistry、ToolExecutor 实际执行；实验 PNG sink 已验证模型图像能力，但未冒充当前安装 Host 的完整多模态集成。

每轮从独立 initial 事件开始，页面初始 808 件商品、6493 个 DOM 节点。验收要求本轮实际提交 SSD 搜索，报告前两个商品 Orion Pro SSD 549、Lyra Plus SSD 599，且没有过滤、排序、对比或购物车事件。独立判定基于页面事件及精确报告，不基于模型自评。

| 试验 | 搜索与读价 | 模型工具调用 | 工具失败 | 控制器总耗时 |
| --- | --- | --- | --- | --- |
| auto-0 | 通过 | 5 | 0 | 77.12 秒 |
| auto-1 | 通过 | 4 | 0 | 59.13 秒 |
| auto-2 | 通过 | 4 | 0 | 55.58 秒 |

第一轮模型自行先观察 semantic，再补充 high 区域截图，然后通过新观察的 UIA node_id 点击、输入和提交。后两轮使用一次 semantic 观察后直接操作；操作后的新观察由原有默认 auto 返回，模型使用新 frame_id。三轮模型动作均未填写 observe_after，真实默认值生效。原始请求、图片、receipt、输出与事件保存在 loop/。

三轮都没有严格遵循“最终仅输出 JSON”的实验格式要求：前两轮带解释和 JSON 代码块，第三轮带解释及末行 JSON。功能内容正确，但 strict_final_json 全部为 false。诊断抽取允许唯一 JSON 代码块或唯一末行对象，并独立标记格式失败；不修改生产解析器，也不把格式失败抹成全量验收通过。两项新增解析测试覆盖多对象歧义、缺少 JSON、非对象及错误价格。

两轮间刷新使用另外 4 次原生 setup 调用，单独保存，不混入 13 次模型工具调用。三轮期间没有人工干预页面操作。最终 probe 在总计 17 次操作后退出，probe_alive=false，见 exit-receipt.json。

这是同一任务的三次小样本重复，不是多页面稳定性证明；控制器总时间包含 SSH、PNG 传输和模型耗时，不代表产品端到端延迟。不据此取消帧检查，也不据此强制模型只能使用某种观察方式。

## 与上次结果的关系

上次三个模态的对照强制使用 observe_after=never，因此出现旧帧重试。此次保持 auto 默认后三轮未复现，不能把上次重试直接称作默认流程 bug。已有自动观察不应再实现一遍。过期保护在本次没有触发，也没有证据要求加大 TTL。完整 UIA 仍较慢，但这是性能问题，不是本实验中操作失败的原因。

## Browser Use 只读检查

检查的对话为「了解 DeepSeek Harness (4)」，其工作区是 /Users/wangyue/codex-build/xharness-browser-bootstrap-20261006。检查时 HEAD 为 81e1751692e49fdbe50ccc6fe8d912104c248ab2，工作树有未提交的原生 API 探针；检查文件的 SHA256 保存在 reuse-audit.json。没有发送新任务、修改该工作区、合并两边或替换软件。

生产 Browser Use 当前经 plugin_mcp 使用 WebView DOM 的 control、observe、perform；生产定义明确不支持截图和原生输入。其 Windows 原生探针采用 WebView2 CDP 输入与截图；这与桌面 Computer Use 的 Win32 输入和 UIA 不是同一个执行后端。探针技术路径不等于生产能力完成。

## 可以复用的小模块

图片的附件存储、会话 ContentBlock 与供应商图像投影已经共用，不必另建图片服务。可在 Host app 层提取一个小的 tool_media helper：检查当前会话图像能力、通过现有 attachment_store 保存 PNG、构造稳定的 Text 与 Image 工具结果块、检查取消。

现有 computer_media::Sink 只需委托该 helper，保持 ComputerMediaSink 接口不变；等 Browser Use 真正接入截图时，使用相同 helper。read_media 的块构造也可复用，但文件读取和历史附件归属校验仍留在原位置。第二个生产调用方出现之前不先建一套空的抽象框架。

不会合并的职责：桌面窗口与浏览器标签授权、物理桌面像素与 WebView 坐标、UIA node_id 与 DOM ref、桌面帧时效与浏览器 navigation epoch、Win32 与 WebView/CDP 输入。两边继续各自决定动作和观察；不新增统一模型规划器、自动重试引擎或全局帧管理器。

Browser bridge 当前响应上限 64 KiB，不能直接塞入通常更大的 base64 PNG，也不能为了复用随意增大全部消息上限。生产截图接入时应选用现有会话附件路径或独立有界二进制路径，再交给共享投影层；这属于后续能力接入，不是本轮实现。

## 费用与复核

16 个有 usage 的真实响应，输入 539038、输出 1649 Token。缓存命中 346880、未命中 192158；按保存的保守峰时费率估算上限 0.06170748 美元，不是实际账单。usage 与来源见 cost-ledger.json。本轮没有 Rust 源码修改或新 Rust 编译；沿用的二进制与远程 CI 凭证见上一组 modality 证据。

comparison.json 区分功能、工具调用和严格格式结果；receipt 使用无损 gzip，PNG 原样保存，SHA256SUMS 校验文件完整性。recipes 保存实际实验控制器和独立判定器；密钥只在 Mac Keychain 中读取，不进入 Windows、服务器或证据文件。未提交、未合并、未发布本轮证据与复用设计。
