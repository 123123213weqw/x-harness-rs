# 原 Host 原生托管门禁验收（2026-10-01）

## 结论与范围

`CLOUD-04a / CLOUD-05a` 首切片已实现并通过 V100 Linux 回归及真实专属 VM 验收；**完整 CLOUD-04/05 和云端托管产品仍未完成**。未调用真实模型、未注入 API Key、未替换本机 App/Web 或服务器原模型服务，未提交、推送或发布安装包。

这一切片只增加原 Host 的可选执行许可与原生启动/停止收据，不另造 Loop、Tool Registry、Goal 或 Session 状态机。设计及操作命令见[规范](../specs/cloud-runtime.md)和[手册](../runbooks/cloud-native-execution-gate.md)。

## 实际改动

- `xharness-host` 新增中立 `ExecutionGate`：默认未安装时保持本机原行为；普通消息、共享自治 turn、resume、manual compact、辅助 Provider 和实际 tool handler 共用门禁。
- `xharness-tools` 增加追加 innermost AroundMiddleware 的入口，保留原审批/调度/生命周期；在等待结束、进入 handler 前再核对许可。
- `xharness-cloud-app` 增加 VM-local `NativePermitJournal` 和可信管理 CLI：SQLite WAL/FULL、固定绑定、单向 Prepared/Active/Sealed、操作 ID/CAS/幂等 ack、单调 launch generation 与不可变停止收据；不保存模型凭据。
- `xharness-host-app --hosted-permit-dir` 安装上述门禁：Linux/loopback 限制，固定实际二进制 SHA 与 canonical workspace/state，复用原 state ownership。Prepared 不进入原 Host boot；Active 才启动；封存后不接新工作并复用原 shutdown。
- Hosted transport 在 lazy hydration 前校验；独立 Web PTY 执行入口在此模式下关闭，本机模式不变。

临时 graceful stop 可同 Binding 领取新 generation；SIGKILL、启动中断、清理失败、缺少停止收据则拒绝自动重启。启动中封存不伪造 Stop。原生 Stop **不是整台 VM 静止或云任务已完成的证明**。

## 回归证据

源码包含未提交改动，Rust 仅在 `WZU_Server` 编译。使用隔离源码 `~/codex-build/x-harness-rs/cloud-04-source-20261001/` 和 target `~/codex-build/x-harness-rs/cloud-04-target-20261001/`，避免其他 worktree 并发构建混用内部产物。仅借用第三方依赖缓存，内部 crate 重新编译。

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| `cargo test --workspace` | **1041 passed / 0 failed / 19 ignored** | 139 个完成的测试摘要汇总；ignored 不计入通过数 |
| 原生 journal 新增测试 | 21 passed | 重放/封存/CAS、世代、损坏/路径、停止及清理语义；已包含在总数内 |
| Host gate + Runtime 新增测试 | 4 + 1 passed | 每请求校验、保留旧 middleware、等待后封存、无许可不接纳 |
| Host-app 新增测试 | 3 + 6 passed | 组合根/transport 单测及真实原生进程生命周期 fixture |
| 四接线模块 Clippy | 通过 | cloud-app、host、host-app、tools，全目标 `-D warnings`；**不是全仓 Clippy** |
| 架构边界 | 通过 | 38 crates、8 个提取处理器；Host 未依赖云/SQL |
| Python guard | **34 passed** | 原生脚本 3 + 专属 VM 16 + 四 VM 实验 15，远程执行 |
| 专属 VM 原生门禁验收 | **8 passed** | 真实 VM-1，未配置模型和 Goal |

全仓 Clippy 仍有既有、未跟踪的独立 `edit_mode_ab.rs` lint，本批没有修改该文件。没有运行 GitHub 跨平台 CI，因此不宣称 Windows/macOS 托管模式验收完成。

前次共享 target 暴露不同源码产物混用，未作为最终验收证据；隔离后的前台测试一度因 SSH 断开中止，也未记为全仓通过。最终使用有 MemoryMax/TasksMax/CPUQuota/20 分钟上限和同 VM ExecStopPost 清理的远程 systemd 作业，SSH 断线不会中断测试，最终作业成功退出。

## 真实 VM 验收

复用原 VM-1 `89ac0170-3edd-473c-8f86-c698f0ce4451` 与持久盘；保持 2 vCPU / 2 GiB 客体和宿主 4 GiB QEMU 上限、无 GPU、无出网。fixture 单独部署到 `/home/agent/cloud-native/native-03e71215ebc64ef8/`，使用独立 guest 单元，不覆盖原 Host 二进制、服务、工作区和合成 canary。

固定 fixture Host SHA256：`774b2346fc8d147f4b0f84cf2f2f8ff61a3a559584fe0d8fb00f9b364f5e2ae6`。

1. 复用原专属身份和硬资源上限。
2. 单独部署固定 SHA，重复 initialize 返回同一 Prepared。
3. Prepared 不恢复原 Runtime、控制日志、会话或 Ready。
4. Activate ack 重放一致，原 Host Ready，generation=1。
5. 临时停止写 graceful 原生收据；重启 generation=2，仍为 Active。
6. Seal 后原 Runtime 完成清理，收据为 sealed/graceful、零 forced/cleanup errors。
7. 封存后重启拒绝，generation 不变；原实验 Host 和路由仍可用。
8. 宿主外部核实四 VM 均停止，磁盘保留；作业结束后再次独立核对四台均为 stopped。

VM 报告：`~/codex-build/x-harness-rs/cloud-vm-lab-20261001/dedicated/native-03e71215ebc64ef8-report.json`。报告明确 `native_gate_only=true`、`no_model_calls=true`、`no_goal_bootstrap_claim=true`。

debug 二进制较大，SHA 验证每次流式读取、不会整文件载入内存；原生进程 fixture 等待上限 120 秒、VM Ready 上限 150 秒。这是测试容忍窗口，**不是 release 启动性能指标**；实机 activate/Ready 检查约 34.8 秒，包含本次 debug SHA 和轮询成本。

完整非敏感日志及 JSON 证据已返回本机 `dist/regression/cloud-04-20261001/`（忽略目录，不上传私钥、VM seed 或磁盘）：`cloud-04-regression-final.log`、VM 报告、`summary.json`、`source-sha256.json` 和 `source-verification.json`。本机和远程 28 个相关 Rust 源文件摘要与冻结验收源码核对；后续修改必须重新验证，不能继承这次结果。

## 损坏与测试环境补修

损坏注入在远程先复现 **18 passed / 3 failed**，再修实现并重跑：

- authority 行缺失但残留 command/launch 时，initialize 拒绝创建新的 Prepared，不重置旧封存绑定。
- 历史 ack 校验许可语义及其与操作 expected revision 的关系，拒绝零/非法 revision，不能因当前 authority 有效而接受坏收据。
- launch 必须源于 Active revision=2，拒绝 Prepared revision 的伪记录；原始未初始化空库正常重开/初始化仍通过。

另外将测试绑定路径改为本平台绝对路径，避免 Windows 将写死的 `/workspace` 视为非绝对路径而导致 fixture 错误；Windows CI 仍待执行。全仓重跑发现既有 PTY resize fixture 清除了 shell 的 `--noprofile/--norc`，受宿主 `.bashrc` 影响超时；保留原 fixture 参数后定向连续五次通过，最终全仓也通过。不修改生产 PTY 行为，不靠扩大读等待窗口掩盖错误。

最终远程作业 `xh-cloud-04-complete-1790868419.service` 于 23:26:59 开始，23:31:55 全部完成并成功退出；之后核对四 VM 停止与 28 文件源码一致。本次最终证据不使用中途失败的工作区结果。

## 下一步门禁

1. 接真实 `StageExecutor` 与原生 bootstrap/Ready/Goal 收据，独立 Binding state、初始输入去重及材料/凭据固定版本；Prepared dormant 不冒充控制协议 bootstrap prepared。
2. 接可信崩溃恢复授权、外部静止/保留证明、控制器终态 CAS 和任务根/子 Session 范围；不通过重新初始化 journal 或手动改 supported 绕过能力未知。
3. 以上门禁通过后，在专属 VM 内用 DeepSeek 跑多轮编程、客户端断线/Host 与 VM 重启/工具在飞/取消等真实任务。
4. 最后接鉴权 Gateway 与本机 RuntimeConnection，复用聊天/Goal/提问/停止 UI。

当前同 UID/独占 VM 内的 journal 是工程门禁，不是对拥有 Full Access/sudo 的进程的防篡改边界；外部 VM 控制仍是独立权威。未实施跨云接管、release 性能、满盘注入或完整长期 Goal 结算测试。
