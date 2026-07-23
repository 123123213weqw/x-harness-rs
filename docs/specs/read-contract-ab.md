# Read 契约修复与实验（2026-10-03）

## 范围

只修改原生 read 参数描述／数值解析，以及 NativePlatform 的只读授权路径解析。保持 read 名称、字段、旧 limit 的 UTF-8 字节语义、默认页 32768 字节／400 行、最大页 65536 字节／1000 行、16 KiB 长行限制、输出字段、游标版本及 CAS 保护。其它工具描述、权限、预算、历史策略、模型保持原样。生产应用不替换。

- Schema 每字段公开单位、范围、定位互斥和合法示例；默认不填写 limit，按行定位使用 start_line/line_limit。
- malformed／negative／overflow 分页参数明确报错，不静默默认。
- restricted read 接受 canonical workspace 下按路径组件匹配的绝对路径；把相对能力交给既有 FsService 解析与 no-follow 打开，不先 canonicalize 用户路径再 reopen。附件只读根／Full access 保持既有实现。
- mutation resolve_file 仍不兼容 restricted 绝对路径，本阶段只改 read；本阶段不改变 write/edit 契约。
- 不接受 ../ 路径，不允许越界，也不新增自动权限。

## 确定性回归

V100：coding-tools 全部测试，platform 全部测试，fs 全部测试；新增参数单位／边界、工作区内绝对路径与原相对路径输出相等、越界／组件前缀伪装／父路径／符号链接拒绝、UTF-8 4 字节分页逐字节重建、长行逐页重建、空／缺失／EOF、stale cursor、冲突与取消。read 完整结果必须不变。

Clippy 检查三 crate 和实际实验 example。只在服务器编译；所有初始失败原样记录。

## 真实模型开发对照（不宣称全新盲测）

复用已经公开、已经测试过的三仓库任务：Boltons chunk strict、JSON5 sortKeys、fast-json-stable-stringify bigint。每任务两对，A/B 与 B/A 平衡，共最多 12 次任务运行，最多 200,000 未缓存输入 Token（单个在飞请求可能越过上限，不再启动下一次）。DeepSeek Flash thinking enabled/low，与前一批模型一致。A 使用此前冻结且 hash 验证的原版二进制，B 使用同一 example 源码重建的修复版，两者 mode=baseline，不启用 lossless wrapper。同任务和独立验收、同原生工具／其它定义／sandbox／预算／7 tools。

本轮修复实验设施：明确发送允许修改路径和对应项目自测命令；只忽略已核实的 node_modules/.cache/nyc 与 esm、Python/cache/coverage 等派生缓存，依赖源码仍比较。既有功能门禁不放宽。正确控制同时通过功能、旧套件、自测和源码范围。保留前阶段原始成绩，不重新评分。

指标分别记录：
- 端到端耗时、请求／步骤、输入／输出／缓存／未缓存输入。
- read 实际调用及错误原因，过小页、重复参数读取、cursor 续页；Bash 搜索/读取单独统计。
- 独立功能、旧回归、模型自测、允许范围分别报告。
- 不以“API 不报错”替代编程验收，不把工具失败全部解释为 harness bug。

读接口修复可以靠确定性门禁验证正确性；12 次开发对照只观察模型能否正确用，不保证性能稳定提高。若耗时／成本退化或样本不够，明确报告，不以实验结果自动推广／发布；经用户要求单独提生产修复 PR，不替换软件。新增描述和路径兼容是组合修复，不把总体差异归因于某一个描述字段。

## 本轮设施审计补充

事后发现 v1 runner 的 source manifest 错误地按完整绝对路径排除 `.verification`，导致原始 protocol.json 的 source_sha256 为空。本机事前冻结的 437 项不为空，运行后与服务器实际源码逐项相同；二进制 hash 和每次真实发出的定义均有核对。但不能把这些说成“运行前双端 manifest 已核对”。原 protocol 不追改；v2 改为只检查仓库相对路径，空 manifest 在调用 API 前拒绝，增加两个单测。独立 preflight 现在每任务有自己的验收日志目录，避免覆盖其它正确控制的日志。旧 12 次成绩不追改，也不继续付费重跑来掩盖设施缺陷。
