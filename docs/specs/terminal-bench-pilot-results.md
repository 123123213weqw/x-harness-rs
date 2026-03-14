# Terminal-Bench 小型试验记录（2026-09-11）

## 结论

**本轮未得到有效的对照分数，不能声称 XHarness 赢过或输给 Terminus-2。** 已真实调用 DeepSeek、运行原生 XHarness 并保存轨迹；参考组和独立评分尚未跑通。停止付费试跑是因为测试环境与适配器问题，不是根据代码得分选择性重试。

## 冻结方案与实际执行

- 原计划：3 道题 × XHarness / Terminus-2 × 各 1 次；按元数据预选，未向模型提供隐藏测试或答案。
- XHarness 源码 `5fbf964067149ff448ba25b2343a3dae733fe028`，使用实际 Host、原生工具和默认上下文策略，不是重写的简化循环。
- Host SHA-256：`c108aa8ebfd38222c01f9e2b31d33b24d0cad3884a67a348add48039c46f61f5`。
- Terminal-Bench 2.1：`7131e4375048a0e408a8fb404b5f499d726b695b`。
- Harbor 0.16.1；Python 3.12.14；LiteLLM 1.100.1；OpenAI client 2.54.0；Pydantic 2.13.5；tiktoken 0.14.0。
- 模型 `deepseek-flash`，thinking enabled / high；输出上限 4096，配置上下文 65536；每题至多 40 次调用、$0.30 保守预留预算。
- 两组外层执行期限均为 300 秒；XHarness 内部 290 秒终止以预留清理时间，存在 10 秒的有效时间不对称。原题 agent / verifier 各 900 秒，本试验各改为 300 秒。并非官方榜单协议。

| 任务 | XHarness | Terminus-2 |
|---|---|---|
| cancel-async-tasks | 12 次真实模型请求；内部期限耗尽；适配器错误分类导致未评分 | tmux 安装超过 240 秒；0 次模型请求；未评分 |
| build-cython-ext | 未开始 | 安装阶段被人工中止，`CancelledError`；0 次模型请求；未评分 |
| log-summary-date-ranges | 未开始 | 未开始 |

另有 `runs-1` 网络连通性失败：容器无法连接宿主桥接 TCP 代理，0 次模型请求，随后中止并改用独立 Unix socket。该记录不计代码分数，也未删除。

## 唯一付费轨迹的计量

来源：`runs-2/cancel-async-tasks--xharness/result.json`、broker ledger 和会话 journal。

| 指标 | 实测 |
|---|---:|
| 模型请求 | 12 |
| 累计输入 token | 92,035 |
| 其中缓存命中 | 77,312 |
| 累计输出 token（包含 reasoning） | 17,940 |
| 其中 reasoning token | 12,534 |
| 包含环境/收尾的 trial 时间 | 305.71 秒 |
| Host wrapper 时间 | 290.58 秒 |
| 峰值价格、全部输入按未命中计算的保守估计 | $0.0491385 |

输入 token 是多次请求的累计值，**不是单次上下文占用**。费用是按记录用量与保守价格计算，不是官方账单。12 次请求均返回 HTTP 200；无其他已记录付费试验。

## 观察与归因边界

1. **环境缺工具。** journal seq 153：`glob` 因找不到 `rg` 失败；seq 388：诊断命令找不到 `ps`。Terminus-2 则在安装 `tmux` 时超时。这不是有效的同环境工具完备性对照，应先给双方准备相同的中性依赖层。
2. **容器依赖网络不可用。** 宿主访问 Debian 镜像返回 HTTP 200；容器域名请求卡住，独立公网 IP TCP 探针被拒绝。容器到宿主桥接 TCP 同样超时，而只读挂载的受限 Unix socket 通路已通过断网容器测试。此证据未定位到具体哪条防火墙规则；本轮没有改防火墙、宿主网络或改用 host networking。
3. **首次输出预算不够。** 首次模型响应 4096 completion token 全为 reasoning，没有实际动作输出。4096 是本试验设置，不是由此证明产品默认值有问题。下一轮需独立比较更合适的单次输出上限，不能在同一轮中途改参数后混算。
4. **自测等待吃掉期限。** seq 309 的 `python3 test_run.py ... | tail -60` 请求 180000 ms，结果 `termination=timedout` 且没有 stdout；之后模型改用后台无缓冲输出，再等待。部分自行编写的测试打印 PASS，但这不能代替独立评分，也不能证明剩余测试为何卡住。
5. **大输出确有归档。** seq 199 的工具结果有 11,164 字节原文归档和 `history` 引用。本轨迹没有证明模型成功回读该引用，不能把“存下来了”当作恢复能力得分。

## 本轮已修正的测试设施

- 内部超时退出码改为 124，适配器映射为 Harbor 可继续评分的 `AgentTimeoutError`；真正适配器错误继续单独报错，不伪装为成功。
- 两组模型激活前都检查相同基础工具（bash、rg、tmux、ps、python3），并做有外层 25 秒期限的依赖端点探测；DNS 卡住也受外层约束。出现零模型调用的基础设施失败，控制器停止剩余批次。
- Windows：12 项离线测试通过，2 项 Harbor 契约测试因未装该依赖跳过。
- WZU：14 项测试全部通过（包括真实 Harbor 类型契约）；实际 Unix socket + 容器 relay 鉴权检查通过，0 次模型请求。
- CI 增加三平台离线测试及 Linux Harbor 契约测试；不使用真实 API key，不跑付费模型。提交时不将“已配置 CI”写成“远端 CI 已通过”。

以上是测试设施回归验证，**修正后尚无端到端有效评分**。当前没有足够数据进行胜率、token/成功题或统计显著性比较。

## 下一轮的开跑条件

先在隔离容器中验证依赖安装、工具可用性和独立 verifier 能运行；缺少依赖必须标记基础设施失败，不能把 pytest 启动失败的 reward 0 当作代码不正确。可以准备可复用离线依赖镜像，或在明确授权的范围内修复容器出网，但不得放开到共享宿主的敏感服务。

随后冻结新的完整协议，以双方相同依赖、明确输出/思考预算和期限重新跑全部配对任务。保留本轮所有记录与花费，不混算、不挑最好结果。只有有了独立通过/失败结果，再做单变量优化：环境描述、预算感知、长命令等待和历史回读。不要靠删除原文或切断未完成工具状态换取表面 token 降低。

## 证据保留

远端独立目录：`/home/wzu/codex-build/x-harness-rs/tbench-pilot-20260911/`。

- `runs-1/`：零请求运输失败。
- `runs-2/`：上述部分试验、协议、用量和原生会话。
- `adapter-runs2/`：当时实际使用的适配器快照，保留旧超时分类缺陷；当前 `adapter/` 是测试设施修正版。
- 原始文件留在私有目录，不公开 provider key、请求内容或临时能力令牌；报告只含汇总值。实际密钥只在控制器内存中，未进入 task 容器。

使用镜像摘要（`alexgshaw/<task>:20251031`）：

- cancel-async-tasks：`sha256:84c7fae6b256dcc56a350790e2a9715eefc7dad662a9d8e8a472363aa71ef18d`
- build-cython-ext：`sha256:3612a38fadb89a96f74a1a951fb0b0af734198fd160571eeaba6401593234594`
- log-summary-date-ranges：`sha256:cbeb6ba905c2fec294f16cd5e16e3ea7f2e04d38ac2484d51a11de262aa7dc51`

评测方法来源：[Harbor agent integration](https://www.harborframework.com/docs/agents)、[Terminal-Bench 2.1](https://www.tbench.ai/news/terminal-bench-2-1)、[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/)。
