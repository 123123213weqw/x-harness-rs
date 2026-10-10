# Windows Computer Use 扩展真实模型实验 — 2026-10-06

## 范围与结论

- 真实 DeepSeek Flash（返回 model=`deepseek-flash`，temperature=0，thinking disabled），原注册 ComputerTool → ToolExecutor → Windows 原生适配器。
- 在 V100 的独立 Windows 实验克隆中操作 808 商品的隔离购物页面。模型自行选择操作顺序，无 DOM 执行、答案注入、自动坐标修正或未知输入重放。
- **生产运行时不变**：同一 `16c5568041b165a8136ac6c6fc09a4e864bde860` 探针，SHA256 见 artifact-provenance.json；未更换本机软件、未合并/发布。测试不等于安装版 Host/历史/compact/取消链路验收。
- 每组最多 20 次模型响应，是实验额度边界，不是产品轮数限制。没有完成即记录失败/部分完成，不声称永远无法完成。
- 4 组有效试验：2 组页面任务及内容事实通过；2 组未完成。通过的两组仍存在严格 JSON 格式和价格字段类型不合约。

| 任务 | 实际页面证据 | 判定 | 模型工具调用/失败 | 耗时 |
|---|---|---|---|---|
| 筛选、排序、商品对比 | TLC 筛选、价格升序成功；没有产生目标二商品 compare 事件 | 部分完成，20 响应终止 | 20/0 | 474.88s |
| 遮挡弹窗、搜索、读价格 | dismiss_modal + SSD 搜索 + 正确 Orion 549/Lyra 599 | 功能通过；报告格式不通过 | 7/1 | 219.30s |
| 慢加载、操作后布局变化 | 看到 Loading 后自行 wait；search + layout_shift + 两个正确价格 | 功能通过；报告格式不通过 | 13/4 | 292.71s |
| 滚动定位、详情、返回 | 有滚动；未打开目标详情；误把 Accessory 797 加入模拟购物车 | 失败，20 响应终止 | 20/1 | 513.74s |

`pass` 是独立功能判定，不包括严格最终 JSON 输出；报告格式见 `strict_final_json` / `report_field_types_ok`。未运行到的详情/返回不能算覆盖。任务页面的详情是同文档 hash 视图；未证明跨域或新文档导航、真实互联网店铺、登录、支付、验证码。慢加载是 2.2 秒模拟延迟，不是断网实验。

## 错误分类

### 模型决策/定位错误

1. 筛选任务反复选错对比复选框。最新 UIA 标签为 Rapid Mini/Classic 时，模型将其当成 Orion；实际没有二商品 comparison。没有证据证明节点被原生点击到其他位置。
2. 滚动任务反复把负 delta_y 当“向下”，随后大幅拖动滚动条、依赖商品编号猜测位置，跳过目标。目标被放在第 12 项，不能假设编号就是位置。所有观察中均未看到目标标签，不能凭此说 UIA 已经漏掉可见目标。
3. 第 25 号原生请求（retry）为 click(512,400)，模型声称要给页面焦点；页面实际产生 add_to_cart(other-797)。原生成功不等于符合任务，独立 oracle 的 no_cart 为 false。仅模拟购物车，没有真实订单/付款。
4. 已完成两组含额外正文 + JSON fence，价格写成 CNY 字符串；内容事实正确，但不满足要求的单 JSON 对象/数值字段。

### 工具契约与读取证据

- 注册 schema 的 delta_y 只有 integer，没有方向/单位说明。Windows 输入源码对垂直 wheel 取负；不能把模型误解直接认定为输入实现错误。
- 新鲜 frame 的独立 Page_Up 探针稳定返回 unsupported Windows key；源码接受 PageUp/pagedown 等不带下划线名称。实际模型运行的同名请求先被 stale_frame 拦住，**没有到达 key 解析**，不能把那个失败冒充键名复现；两份证据分别保留。
- 6 次有效模型调用在派发前被 stale_frame 拦住（modal 1、slow 4、scroll retry 1）。前两组模型自行 observe 恢复并完成任务。远程图片传输/后处理额外花费十几秒，30s frame TTL 的 WAN 混杂因素明显；未证明本地安装版存在相同故障。
- 原 receipt 等待时间不含图片下载；retry 日志增加 complete_controller_wall_s / media_and_postprocessing_s，不把旧字段冒充端到端耗时。

### 实验设施问题（不算产品失败）

- 原滚动测试控制器误拦 move；重启独立探针后又误拦 Page_Down。修正的是测试许可检查，**实际工具 args 不做别名改写**，原失败轨迹保留，不计为有效模型试验。
- 首探针固定 1200s 生命周期到期。之后的只读重试发现 bridge 已退出，没有重放任何输入；是实验设施边界，不是 Goal 自动暂停。
- scroll-sign 两次诊断的第一条 scroll 事件记录 9，反向事件记录 292。这不是反向滚动错误证据：fixture 的 150ms leading throttle 丢弃动画结束位置，等 1.5s 也不会补发事件。方向诊断对负向结论仍不充分；原结果的 false 被标注 inconclusive，未删除或改写原记录。正向位移已观测，下一次需补 trailing/settled 采样才能独立验收负向。

## 回归和证据

- 本地仅运行 Python/Node 检查，无 Rust 编译。23 个 unittest 方法通过（expanded oracle 5、route/generator 2、collector 1、基础 oracle 6、AX oracle 9），HTML JS node --check 通过。
- 测试设施提供独立事件 oracle、合法查询路由、原请求/receipt/PNG 摘要校验、最新 initial 隔离、错误价格/旧成功/模拟车副作用负例。新增 CI 步骤尚未远程运行，不能称 CI 绿。
- `initial/` 保留四组及各自控制器版本；`retry/` 保留键别名拦截试验、修正控制器后的完整滚动试验、两份方向诊断及键名诊断。大型 JSON/事件无损 gzip，图片原始 PNG。
- artifact-provenance 中 native_desktop_accepted=false 明确保留，不升级为安装版整体通过。SHA256SUMS 覆盖打包文件。
- probe 清理 receipt：initial 55 操作、retry 46 操作，均 finished 且 probe_alive=false；只关闭自建隧道/collector/noVNC 标签，不改用户 3271 页面或原虚拟机。

## 费用口径

全部 70 次模型响应（包括控制器拦截的付费响应）累计 provider-reported input 6,892,448 / output 8,692；cache hit 6,080,128，miss 812,320。
API 未返回人民币实扣/余额，cost-ledger 的 actual_currency_charge=null；不是价格估算、账单或余额。

## 下一步（不扩运行时）

1. 用清晰且平台正确的 scroll/key 工具字段描述做单变量 A/B；保留原模型自由探索，不增加强制步骤或代替模型点击。
2. 补测试页面 scroll settled 采样及多次重复/多种布局，重跑滚动定位、详情打开/返回和商品对比。
3. 只有新鲜 frame 下坐标/节点输入与实际页面效果稳定不符，才修原生工具；本次没有这种已证实的产品实现错误。

截图：slow-layout 完成态在 initial/loop/slow-layout/image-54.png；模型误加模拟车前后的请求、截图、events 在 retry/loop/scroll-detail-final。
