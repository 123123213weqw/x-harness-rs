# Windows Computer Use 视觉与 UIA 对照

2026-10-06，在 V100 的独立 Windows 实验克隆中，对比纯 UIA、纯截图视觉和两者同时提供。真实 DeepSeek Flash 已能识别原生截图并通过原生 computer 工具完成搜索；本页视觉输入明显小于完整 UIA。不过每种操作模式只有一次完整成功试验，且都有帧过期重试，不能据此宣称稳定性验收完成。

## 实验边界

- 工具源码：`16c5568041b165a8136ac6c6fc09a4e864bde860`；工具注册、执行器和 Windows 原生后端真实执行，不使用 DOM 自动化代替点击。
- 模型：`deepseek-flash`，当次模型清单标识 DeepSeek-V4.1-Flash；thinking disabled、temperature 0、max_tokens 1400，各试验使用新消息历史。
- 路径：原生 PNG → 实验 MediaSink → 二进制上传 → SHA256 与尺寸校验 → 模型 image_url。没有先 OCR，也没有把 noVNC 画面当模型输入。
- 此结果属于实验控制器链路，不代表已安装 Host 的附件投影、历史恢复、压缩或当前 3271 会话已经通过多模态验收。`provenance.json` 的 `native_desktop_accepted` 仍为 false。
- 原 Windows 虚拟机、UAC、账号、本机软件及 3271 Web 均未替换。没有登录、加购物车或购买。

## 图像能力确认

两张随机七字符加颜色图片仅通过像素提供答案，2/2 正确；另外通过 tool-result 的 image_url 内容结构做真实请求，也正确识别。原始答案和 usage 保存在 `canary-results.json` 与 `tool-image-compatibility.json`。它们是能力探针，不是购物任务通过项。

## 同一公共页面快照

冻结同一张 Newegg 商品页的 1024 × 768 原生 PNG 与 UIA，要求识别前两个可见 SSD 的主价格以及页面搜索输入框的位置。独立 oracle 基于可见图片，不以模型自评判定。正确商品为 Samsung 9100 PRO 2TB 399.99、WD_BLACK SN850X 2TB 352.00；搜索输入框像素范围为 [186,95,398,137]。

| 模式 | 独立判定 | 每请求输入 Token | 模型响应中位数 |
| --- | --- | --- | --- |
| 纯 UIA | 3/3 正确 | 19489 | 1.357 秒 |
| 纯视觉 | 3/3 正确 | 2189 | 1.174 秒 |
| UIA 与视觉 | 3/3 正确 | 19985 | 1.294 秒 |

本快照视觉比完整 UIA 少约 88.8% 输入 Token。三次顺序轮换，但 temperature 0 下同图重复不是独立场景成功率。视觉返回可见的截断商品名称，判定只要求正确的品牌、型号和容量，不要求截图看不到的完整 SKU。

输入 PNG SHA256：`45144197da12dae0574143f07bae428dbe383948c8c0c7b076b1f29e590866ec`。证据在 `static/`，每组实际传入内容由 `recipes/static-compare.py` 生成。纯 UIA 只传 JSON、不传图像；原 JSON 中残留 screenshot_included 元数据不代表供应商收到 PNG。

## 搜索操作闭环

受控购物页初始有 808 件商品、6493 个 DOM 节点。每次恢复初始页后，模型通过真实 computer 调用搜索 SSD，再报告前两件商品及人民币价格。独立页面事件必须出现本次 initial 后的 search，query 精确为 SSD；结果必须是 Orion Pro SSD 549、Lyra Plus SSD 599，且没有排序、过滤、对比或购物车事件。

| 试验 | 任务结果 | 原生调用 | stale_frame 失败 | 原生 observe 中位数 | 控制器总墙钟 |
| --- | --- | --- | --- | --- | --- |
| uia-1 | 通过 | 9 | 2 | 8764 ms | 85.567 秒 |
| vision-1 | 通过 | 10 | 1 | 478 ms | 71.156 秒 |
| hybrid-0 | 通过 | 9 | 2 | 8858.5 ms | 98.573 秒 |

每组只有一个完成试验；浏览器动态弹层和重试不同，所以操作耗时不能当作严格因果 A/B 或生产软件延迟。总墙钟还包含 SSH、文件桥、图像传输和模型请求。单条 receipt 的 controller_wall_s 不包含随后 PNG 下载；原生 elapsed_ms 不受这项口径影响。

三组最终内容精确正确，但都带解释前缀和一个 JSON 代码块，因此 strict_final_json=false。任务通过不等于每次工具调用通过：native_all_success 均为 false。页面事件、原生失败、模型原始答案均保留在 `loop/`，未删掉失败重试来提高指标。

## 发现的问题

1. 此次隔离模态的控制器强制操作使用 observe_after=never。后端操作会消费旧 frame_id，模型沿用旧帧时得到 stale_frame，再重新 observe 恢复。生产默认其实是 auto，点击、输入等操作会自动观察并返回新帧；这些重试不能直接证明默认流程存在 bug。工具描述尚可澄清，但无需重复实现已有的自动观察。
2. FRAME_TTL 为 30 秒。远程 PNG 下载加模型决策可能超过它；vision-0 的点击被拒绝时已超过 30 秒，这是传输与帧时效问题，不能归因于视觉识别失败。
3. uia-0 因实验控制器误要求非 observe 调用也声明观察参数而中止；vision-0 因控制器未处理失败 result=null 而中止。修正的是实验控制器校验和空值处理，没有重写模型动作。两个中止试验及费用仍计入账本。
4. 三组未严格输出纯 JSON。当前判定器允许唯一 JSON 代码块，并明确记录严格格式失败。

建议先明确一次性帧契约和图像传输的时效策略，再扩大不同页面、弹层、缩放、多显示器和连续运行测试。本快照支持“视觉为主、需要时补充有界 UIA”的方向，不支持默认每步全量同时发送两份信息；本轮未修改生产选择策略。

## 内存与费用

100 ms 抽样的原生父进程与 worker 工作集之和峰值：UIA 30.4 MiB、视觉 29.6 MiB、混合 32.6 MiB。不是唯一物理页占用，不包含完整 XHarness，也不是保证捕获瞬时峰值；样本不足以证明减少泄漏或内存优化。

47 个有 usage 的响应（包含中止试验与能力探针），输入 879004、输出 5360、缓存命中 696064、缓存未命中 182940 Token。按账本保存的保守峰时费率估算上限为 0.065490384 美元，约 6.55 美分；不是供应商实扣账单。完整 usage 与费率来源见 `cost-ledger.json`，不使用其他并行任务影响的账号余额差作费用证据。

## 回归

- 源码 16c 的 Windows CI 37406240802：30 个单元契约、clippy、Host composition check、release probe 构建通过，完整输出在 windows-ci.log。
- V100 同步未提交源码后：20 个 Linux 单元测试和 clippy 通过，完整输出在 linux-tests.log。没有在 Mac 编译 Rust。
- 同一 Windows probe：16 个独立原生 fixture 用例通过；ready.json 保存记录。PE 系统导入审计通过，没有动态 VCRUNTIME/MSVC 导入。
- 本地 Python oracle 和 collector 共 18 个测试方法通过；阴性用例包含缺少真实 search、历史 search、错误价格/坐标及购物车副作用。
- 新增证据 oracle 和 workflow 修改尚未提交，不能沿用源码 16c 的 CI 成功来宣称新修改已过 CI。未合并 main、未发布。
- 原生 probe 在 39 次操作后停止，probe_alive=false；退出凭证在 exit-receipt.json。

## 证据复核

`comparison.json` 是结构化汇总；`static/grades.json` 和各 loop/grade.json 是独立判定。原生 receipt 与 capture JSON 采用无损 gzip 保存；PNG 没有重新压缩，SHA256SUMS 校验所有证据文件。

可运行仓库中的四个 Python 测试脚本，均不编译 Rust。recipes 保存实际控制器，但不是一键生产部署：它需要独立 Windows 克隆、受控 collector、已验收的原生二进制、本机 Keychain 配置、Pillow 和 fresh frame。设置 XHARNESS_COMPUTER_LAB_ROOT 与仅 loopback 的 XHARNESS_COMPUTER_LAB_URL。不能复放历史输入动作或重试结果未知的副作用；同图只读重算可先把 capture.json.gz 解压到单独数据目录。
