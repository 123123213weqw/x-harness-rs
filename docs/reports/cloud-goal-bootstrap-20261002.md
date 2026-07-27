# 唯一 Goal 引导与真实 DeepSeek 验收（2026-10-02）

## 结论与边界

完成本次 `CLOUD-04b1`：原 Host 的幂等根 Session/Goal 引导、PreparedReady、原 Ready/激活 ack，以及 `NativeStageExecutor` 适配。所有执行仍走原 Durable Runtime / Provider / Tool Registry，没有第二个 Loop、新模型 Tool 或新公网 RPC。

**不是完整云端产品交付**：生产 VM 生命周期/材料与凭据版本授权、Gateway 与根/子 Session 归属、外部 Stop/retention + 控制器终态 CAS、可信崩溃恢复和本机 UI 仍待接入。控制器/native 集成用测试生命周期端口；真实 VM 验收直接使用原 Host，不能把两类证据混成生产 Submit 端到端验收。

本批没有提交/推送、发布安装包、替换本机 App/Web、修改现有模型服务或开放公网入口。所有 Rust 编译/检查/测试均在 `WZU_Server`，本机仅格式化、源码与 Python guard。

## 实现

- `xharness-host::prepare_goal_session`：原 Store CAS 一批提交初始权限/模型/Goal/enable/原 mutation receipt；不额外发送普通用户消息、不唤醒 Runtime。
- 先持久预留 scope/root/Goal 配置指纹/规范化 TaskSpec 指纹；重试只重放原收据，后来修改过的 Goal/模型偏好不覆盖。已有外来根拒绝接管，已应用 journal 丢失拒绝重建。
- native journal schema 1→2 增量新增 bootstrap，不重置 authority/ack/launch；真实旧 schema 形状的迁移测试保留封存、停止与历史激活 ack。
- 带私有 manifest 的 Prepared 可初始化原 Host/Goal，但真实模型、工具、RPC 与 ready 门禁关闭；Applied + PreparedReady 才允许激活，同一 launch 转 Ready。
- 适配器 inspect 只查询；激活超时查询原操作、不重新启动。没有外部停止证明的取消仍保持 Settling，不伪报整台 VM 静止。
- `architecture-host-modules.json` 仅增加可信 `bootstrap.rs` 为 GoalProcessor 的消费者，纯策略与其他 entrypoint 约束不放宽。

## 回归

独立源码/target：`~/codex-build/x-harness-rs/cloud-04-source-20261001/` 与 `~/codex-build/x-harness-rs/cloud-04-target-20261001/`，同步当前未提交源码，排除 Git/target/node_modules/dist/env/密钥/认证文件。

| 验收 | 结果 |
|---|---|
| 最新源码 `cargo test --workspace --no-fail-fast`，140 个结果汇总 | **1060 passed / 19 ignored / 0 failed** |
| Cloud / Cloud-app / Host / Host-app / Core / Tools 全目标 Clippy `-D warnings` | 通过 |
| 架构依赖边界 | 38 crates、8 extracted processors 通过 |
| 架构 mutation guard | 5 通过 |
| Python VM / Dedicated / Native / Goal guard | 15 + 16 + 3 + 6 = **40 通过** |
| 专属 VM-1，原 Host + 真 DeepSeek | **7/7 通过** |

全量工作区 Clippy 的已有、独立未跟踪 `edit_mode_ab.rs` lint 未改，不宣称全量 Clippy 或 GitHub 跨平台 CI 已通过。19 个 ignored 保持原有分类，不把它们计作 passed。

重点：准备前/准备中取消；首次外来根；header-before-batch；已应用历史丢失；TaskSpec/scope/epoch 冲突；封存后的历史 ack；准备时零请求；优雅重启；原生异常退出不伪造 Stop；控制库重开；激活丢回执；无外部停止证明；Standalone 批次纠正与零旧调用副作用。

## 真实任务

保留 VM-1 `89ac0170-3edd-473c-8f86-c698f0ce4451`，独立 fixture `goal-1e130ebbed4e4d7c`。首次 Prepared 创建一个根 Goal，模型请求为零；Prepared 优雅重启后仍一个 Goal；再激活，同一 launch 驱动原 Runtime。

模型：**deepseek-flash**，调用用户软件已有的 DeepSeek 配置。厂商 Key 只在 V100 私有临时配置/relay 内；VM 使用短期、定模型的 loopback scoped token，不放宽通用出网限制。测试 relay 对可选 input_tokens 明确返回 unsupported 404，不伪造精确 Token 数。

任务分两轮：实现 JSON Lines 统计函数和 unittest，报告 progress；自动第二轮写 README、复测、报告 complete。完整任务验收耗时 **53.209 秒**。

- 原 Goal `rounds_started=2`，只发生一次 Create；最后 turn completed，report complete，没有在飞或待执行 continuation。
- 验收脚本另行执行 unittest；至少 5 个真实用例，退出码零。
- 独立语义 fixture：对象/坏 JSON/非对象/空白/Unicode/type 缺失或 null；结果 `valid=5, invalid=2, counts={alpha:2, 中文:1}`，空输入为零。
- `summarize.py`、`test_summarize.py` 与非空 `README.md` 均存在。模型“完成”不替代独立检查。
- 完成报告进入原 UserConfirm 验收机制；重启后不重放 Goal、不增加模型请求。这不是 Cloud Task Finished 的终态证明。
- Sealed 后原 Runtime 优雅 Stop，尝试重启不领取新 generation、不增加请求；外部核实四 VM 全部停止，磁盘保留，原 VM Host 二进制未替换。

成功运行 **18 次模型请求（含原标题辅助请求）**，全部 HTTP 200；usage 累计 input=154898、output=9522、total=164420，input cache hit=128768。这是多次请求的累计值，不是单请求上下文容量，也不等同于费用。

原生 Host 服务 cgroup 的 `MemoryPeak=25169920`，约 **24.00 MiB**，包括该服务的工具子进程。**不包含 QEMU/桌面 WebKit，也不是桌面总内存或整段 VM 峰值**。客体 2 vCPU/2 GiB；QEMU 保留原 4 GiB/128 PIDs 硬限制，原生 fixture 1 GiB/128 PIDs；其他三 VM 未启动。

最终固定产物 SHA256（远程 debug 构建，仅剥离 debug 符号；非 release 性能基准）：

```text
Host    d50e95c5f806816762317e60b2eec1689710ea8d92c33be185d7880c684a5703
Permit  e16464d77ab36337684718fdd47b332605dd6da6d5e8d2b7e8ad73b06b4360ee
```

## 失败实验与修正，不覆盖失败证据

1. 第一轮 fixture 错读原 EventData 的相邻 tag/content 包装，PreparedReady 实际已就绪，尚无模型请求。修正读取 `event.data`，补真实结构 guard。
2. 第二轮测试 relay 将可选 Token 计数路径返回 403，Goal 在模型请求前失败。改为认证后 unsupported 404，保留原 Provider 的估算降级；不扩大转发路径或伪造实测。
3. 第三轮真实模型在同一批调用 Bash + Standalone Goal，调度器正确拒绝且零 handler 执行，但 Core 把 `StandaloneRequired` 变成整轮失败。
4. 修复第三项：只对该明确的执行前调用错误生成有序、持久 Tool error，标记未执行，让模型后续拆批；不静默执行子集/串行，不吞内部/supervisor/存储/清理失败。原调度拒绝测试保留，新增 Core 测试覆盖两种顺序、未知 sibling、纠正后各执行一次和没有 outcome_unknown。第四轮以修复后的固定产物通过全部 7 项。
5. 收尾审查发现外层 oneshot 作业只写 RuntimeMaxSec 不能限制 activating 阶段；实际真模型作业已有限完成并清理，但不把该字段冒充已验证 TTL。手册改为明确 TimeoutStartSec，另以无 VM/无模型的 sleep fixture 验证：2 秒启动超时、Result=timeout、ExecStopPost 清理收据存在。该预期失败证据与业务测试失败分开记录。

临时厂商配置、VM scoped token 和隧道均已清理；独立停止核对保留。原始日志/成功与失败报告/源码指纹位于本机忽略目录 `dist/regression/cloud-goal-20261002/`，服务器实验目录保留磁盘和阶段证据；不复制 auth/credential 文件到证据。

## 下一步

1. `CLOUD-04b2/03c/02c`：实现可信生产 VM 生命周期端口、材料/模型/凭据版本解析与授权，把 native 收据接到实际持久控制服务。
2. `CLOUD-05b/06`：外部停止/保留、崩溃恢复授权、Goal 用户验收与 Task 终态 CAS、认证与根/子 Session Gateway。
3. `CLOUD-07`：复用原 UI 的托管选择、远程徽标、GoalBar/提问/停止与附件路径映射。

不能在这些边界尚未验收时，把环境 unknown 能力直接改成 supported 或开放生产 Submit。
