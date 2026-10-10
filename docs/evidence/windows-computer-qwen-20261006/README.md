# Qwen 27B 原生 Computer Use 实验（2026-10-06）

## 结论

不能由本轮证明模型能力差，也不能证明 Qwen 任务能力优于 DeepSeek。Qwen 的 11 次非观察操作均被 Host adapter 的 30 秒 frame TTL 拒绝，未进入原生输入执行；这轮实际卡在运行时有效期与模型/链路耗时的匹配上。

## 环境与对照

- V100 现有 `qwen3.8-27b-uncensored`，Qwen3.8-27B Q8_0 GGUF；两张 V100，llama.cpp。`/v1/models` 与 `/props` 实测 n_ctx=262144、1 slot、vision/video=true、audio=false；实际服务已加载视觉投影。
- 使用用户现有服务，不改启动参数、不重启、不清 KV、不占用其它进程管理权。共享服务负载与缓存是性能干扰因素。
- 继续用同一独立 Windows 克隆、16c5568 原生二进制、相同合成 808 商品 fixture、相同 system/task、相同 B 版工具描述、temperature=0、max_tokens=1400、每项最多 12 次助手响应。
- thinking=false 通过 llama.cpp `chat_template_kwargs.enable_thinking=false` 请求；DeepSeek 使用其 own thinking 字段。请求意图相同但实现、默认采样参数、上下文上限、图像处理与 tokenizer 不同，不能包装为纯参数数量/智力的严格消融。
- 实际注册 ComputerTool → ToolExecutor → Windows native adapter；模型自行选择操作。没有人工给操作顺序、重新写坏参数、跳过门禁、用 DOM 替模型点击。
- 先前 DeepSeek B 的结果保留在旁边的 descriptions-ab 证据目录，不重新消费 DeepSeek API；两边 candidate-definition 字节相同。各任务每模型仅一个样本。

## 实际结果

| 任务 | 模型工具调用 | stale_frame 拒绝 | 终态 |
|---|---:|---:|---|
| TLC 筛选、升序、比较两个 SSD | 12 | 6 | 未完成，筛选点击均未执行，无最终报告 |
| 滚动定位 Accessory 779、详情并返回 | 12 | 5 | 未完成，滚动/点击均未执行，无最终报告 |

其余 13 次为观察。第一组尝试点击的 node_id 对应最新树中的 enabled/visible `TLC only` checkbox。第二组使用正数 delta_y=3000/5000，符号符合 Windows 向下滚动约定，但由于拒绝未移动页面，不能验收定位能力或滚动幅度正确性。

本轮 24 次模型响应、33 个原生桥接操作（含 9 个设置/前置检查操作），12 张原生截图完整验证。两组分别耗时 362.73、402.64 秒，只作事实记录，不与 DeepSeek 单次耗时作因果比较。相同 12 轮是实验成本界限，未新增产品轮数限制。

## 过期原因证据

`frame-age-diagnostic.json`（raw 目录）记录所有 11 次输入：

1. 每次输入 frame_id 都等于最近成功观察返回的 frame_id，不是模型复用了旧 ID。
2. 同一 guest 时钟的首个资源样本与 frame_id 创建时间差约 31.84–64.61 秒；样本发生在 native dispatch 前。这是外部近似年龄，不是精确内部 monotonic 时间。
3. 回执均为 `stale_frame`，拒绝耗时 0–3ms。adapter 源码明确 `FRAME_TTL=30s`，且先检查 TTL，再进入 exchange/native。
4. 模型单次响应耗时最高 35.74 秒；另有观察、序列化、PNG 和 SSH 传输开销。第一组识别到正确 checkbox 也无从执行。

因此此次失败被运行时门禁明显干扰。不能用 0/2 完成率判断模型智力；也不能因为调用 JSON 合法就宣布模型能完成整项任务。先处理/隔离有效期与链路干扰，再做任务质量比较。本次不改生产 TTL、权限或业务逻辑。

## 用量

Qwen 提供方报告累计输入 970,091 tokens，其中缓存命中 822,718；输出 1,958。累计多轮上下文不等于单次上下文。使用已有本地模型，没有本轮 DeepSeek 调用；外部扣费、GPU 电力和资源成本未测，不宣称零成本。

## 实验基础设施与清理

最初 rsync 断开，重新同步后才启动有效 collector，并检查模型/视觉元数据。筛选结束后，滚动任务导航成功，但读 shop-history 一次断连；只重试 GET，确认 fresh initial 后继续，没有重放键盘/导航/有副作用操作。原始失败和恢复日志都保留。

两任务结束后 probe_alive=false，operations=33。停止并验证本轮 collector，关闭自有隧道与临时控制台；原 Windows VM、模型服务和用户软件均不改动、不重启。

## 文件

- `results.json`：逐项外部验收、用量、拒绝原因。
- `raw/`：模型声明、响应、native 请求/回执、截图、页面事件、服务器元数据与重现脚本。大 JSON 使用 gzip；没有 API 密钥。
- `source-snapshot/adapter.rs`：实际 TTL 检查源码，未修改。
- `deepseek-baseline-results.json`：已有相同 B 描述组的结果引用，不是新跑样本。
- `integrity.json`、`SHA256SUMS`：截图与全量文件完整性。
