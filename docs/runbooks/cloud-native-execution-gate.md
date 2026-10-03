# 托管模式：原 Host 门禁与唯一 Goal 引导（CLOUD-04a/b1 / 05a）

## 交付边界

这是原 Host 的**可选接线**，不是新 Loop，也不是已上线的云端任务产品。

- 未指定 `--hosted-permit-dir` 时，本机/Web/桌面的运行方式不变。
- 当前托管启动仅支持 Linux、监听地址必须是 loopback；尚未实现公网鉴权 Gateway。
- 无 bootstrap manifest 的 `Prepared`：保持原休眠行为，只持有 State ownership 并验证部署身份。
- 带 manifest 的 `Prepared`：初始化原 Host/唯一 Goal，记录 PreparedReady，但模型/工具/RPC 门禁关闭，HTTP ready 未就绪；不探测远程模型能力、不唤醒 Goal/Schedule/历史恢复。
- `Active`：短事务领取原生 launch generation，然后启动原 Host，复用原模型/工具注册、Goal、Schedule、子 Agent、恢复及停止流程。
- `Sealed`：拒绝启动；运行中约每 100ms 观察一次许可并走原 shutdown。启动中封存则放弃启动，不伪造停止收据。
- 核心 `ExecutionGate` 不依赖云 DTO、SQLite 或网络协议。云适配只在 Host-app 组合根安装。

**已新增**：幂等根 Goal、原生 PreparedReady/Ready/精确激活 ack 与 `NativeStageExecutor`；真实模型证据见文末。**尚未交付**：生产 VM 生命周期服务、材料/凭据版本授权、外部停止与终态 CAS、只读终态 Host、任务归属/根与子 Session Gateway、UI。

## 原生权威与恢复规则

VM 内每个 Binding 使用独立、私有的 permit 目录，数据库为 `native-permit.sqlite3`（SQLite WAL + FULL）：

1. `NativePermitBinding` 固定 Task/Binding/VM instance/volume/epoch、root Session、Host SHA256、workspace、state dir；只允许同一 specification 重放初始化。
2. 初始化从 `Prepared` revision=1 开始。只能向 Active 或 Sealed 前进；Sealed 不可解除。
3. 操作携带稳定 operation id、scope、expected revision。相同操作丢回执后重放旧 ack，不改变当前权威；同 id 改内容拒绝。
4. launch 单独单调计数，记录 Starting / PreparedReady / Ready / Stopped；不每轮记录整个聊天历史。bootstrap 通过独立不可变 reservation 与原 Session receipt 去重，不保存第二套 Goal 状态。
5. 临时停止不封存许可，但只有上一次原生 Runtime 有可靠 graceful stop 收据时，才允许下次 launch。
6. SIGKILL、启动失败、停止提交不确定、非优雅清理：不得猜测已经停止。旧 Starting/Ready 或失败 Stopped 保留，自动重启拒绝；需要外部 VM/进程核对。外部核对后的受信恢复授权尚待接入，不能用重新初始化绕过。
7. 原 Host 原有 state-dir lease 仍是进程唯一写者。`claim_launch` 只允许持有此 lease 的组合根调用，管理 CLI 不暴露 claim。
8. journal 丢失/错误版本/非法数据/路径替换/Unix inode 改变都拒绝。运行中观察到身份或 revision 回退后当前 Host 永久 fence，不能因文件“恢复正常”悄悄继续。

完整 SHA 验证每次启动读实际原生可执行文件，使用 64 KiB 缓冲，不把整个二进制放进内存。debug 大体积二进制的验证成本和 release 不同；不能用放宽测试等待时间宣称 release 性能已验收。

## 接线覆盖

- `AgentRuntime`：普通消息 admission/start、resume、manual compact。
- 共享 `DurableTurnFactory`：Goal/Schedule/子 Agent 的 acquire、prepare、build。
- `ModelProvider` wrapper：capabilities、真实 token count、stream（含压缩/辅助模型的新请求）。本地同步估算与元数据不发网络，仍委托原 provider。
- Tool Executor：保留原 middleware，在最内层 handler 前再检查许可，覆盖审批/其他 middleware 等待结束后被封存的情况；不替换原审批/调度/生命周期。
- `ApiBackend` wrapper：在 BasicHost lazy hydration 之前拒绝封存后的调用、dynamic RPC、问题答复、导出。已有观察流仍由原服务关闭。
- Hosted 模式不挂载独立 Web PTY 执行入口；本机 PTY 保持原行为。需要 Gateway 单独接线后才能启用。

门禁只拒绝**新工作**，不通过丢弃 future 冒充在飞操作已清理。运行后封存复用原 Runtime shutdown（Job/MCP/Agent）、标题、后台恢复、PTY 和 transport drain；boot 被放弃时没有可靠 stop proof。

## 停止收据不是整台 VM 的证明

`NativeShutdownOutcome` 仅记录原生 Runtime graceful / forced workers / cleanup errors 及提交时的许可是否 Sealed。

- 收据写入发生在原 cleanup 返回、debug flush 之后。
- 封存与写停止元数据竞争时，最多重读一次再提交；只重试收据，不重做工具或任务。
- 停止后旧 gate 不再允许工作，即使临时停止仍是 Active。
- **不能**直接把 NativeShutdownOutcome 变成控制器 task complete/cancelled。还要核对控制器 CAS、Goal 验收、所有已接纳工作、外部 VM quiet/保留证据。
- Full Access 中由 `nohup` 等留下、没有纳入原 Job 管理的进程，尤其不能只凭 Runtime receipt 判断整 VM 已静止。

## 可信管理入口

管理 CLI 是 VM 本地/可信 SSH 管理面，**不注册为模型工具，不开放给公网**：

```sh
xharness-native-permit --journal-dir <binding-private-dir> initialize # stdin: NativePermitBinding JSON
xharness-native-permit --journal-dir <binding-private-dir> get
xharness-native-permit --journal-dir <binding-private-dir> transition # stdin: NativePermitCommand JSON
xharness-native-permit --journal-dir <binding-private-dir> launch <generation>

xharness-host --bind 127.0.0.1:3080 \
  --workspace <canonical-vm-workspace> --state-dir <canonical-binding-state> \
  --hosted-permit-dir <binding-private-dir>
```

也可通过 `XHARNESS_HOSTED_PERMIT_DIR` 选择模式。Journal 不包含 API Key。Host SHA 使用部署到 VM 的准确产物摘要，不能用版本号/本机路径替代。

**禁止把旧任务 state dir 绑定到一个新 Task，借新 Active 许可恢复旧 Goal。** 真实适配必须准备独立 Binding state，或同 Binding 原生恢复；根/子 Session 范围还需原生/Gateway 补齐，因此能力登记目前仍保持 unknown，不能接生产 Submit。

该 journal 是同 UID/独占受控 VM 内的工程门禁，不是对拥有 Full Access/sudo 的进程的防篡改证明。外部 VM 身份/资源上限/停止权威仍由宿主控制，生产权限身份和材料/凭据隔离仍待验收。

## 回归执行

Rust 仅在 WZU_Server 编译；先 rsync 当前未提交源码并排除 `.git/target/node_modules/dist/.env/.env.*/密钥/认证文件`。本批使用独立源码 `~/codex-build/x-harness-rs/cloud-04-source-20261001/`、独立 target `~/codex-build/x-harness-rs/cloud-04-target-20261001/`，不与其他 worktree 并发写同一个 Cargo target。

```sh
export PATH="$HOME/.cargo/bin:$PATH"
cd "$HOME/codex-build/x-harness-rs/cloud-04-source-20261001"
export CARGO_TARGET_DIR="$HOME/codex-build/x-harness-rs/cloud-04-target-20261001"
export CARGO_BUILD_JOBS=4 TOKIO_WORKER_THREADS=2
cargo test -p xharness-cloud-app -p xharness-host -p xharness-host-app -p xharness-tools
cargo clippy -p xharness-cloud-app -p xharness-host -p xharness-host-app -p xharness-tools --all-targets -- -D warnings
cargo test --workspace
python3 scripts/regression/check-architecture.py
python3 scripts/test-cloud-native-acceptance.py
python3 scripts/test-cloud-dedicated-vm.py
python3 scripts/test-cloud-vm-lab.py

# 只针对已授权、全部处于停止状态的实验环境；不创建 VM，不注入模型凭据。
python3 -u scripts/cloud-native-acceptance.py \
  --root "$HOME/codex-build/x-harness-rs/cloud-vm-lab-20261001" \
  --host-binary "$CARGO_TARGET_DIR/debug/xharness-host" \
  --permit-binary "$CARGO_TARGET_DIR/debug/xharness-native-permit"
```

原生进程 fixture 使用隔离临时目录、无模型凭据，测试 dormant→activate→ready→seal、临时重启、SIGKILL 禁止复活、错误 workspace 和非 loopback 拒绝。它不等于专属 VM / 真模型 / Goal 引导验收，也不替换当前本机 App 或 Web。

专属 VM 验收脚本复用原 VM-1 和资源上限，在独立私有目录和独立 systemd 单元部署固定 SHA 的 fixture；原 Host 二进制/服务不替换。逐项检查 prepare 重放、dormant、activate/Ready、临时重启、seal/Stop、封存后拒绝复活、外部停止与盘保留。`finally` 清理 VM；SSH 不稳定时应在远程受限 systemd 作业内运行，并设置外层 RuntimeMaxSec 和 ExecStopPost 的同 VM 清理，不能仅依赖客户端连接存活。

2026-10-01 本批 8 项真实 VM 门禁验收已通过，四 VM 随后从宿主再次核实停止。详见[验收报告](../reports/cloud-native-execution-gate-20261001.md)。这不是完整任务 bootstrap 或真实模型工作验收。

## 完整 Prepared 引导（可选，2026-10-02）

在可信部署端准备 `HostedGoalBootstrap` JSON：`scope`、版本引用型 `task_spec`、原生 `goal: GoalBootstrapSpec`。原生 Goal 的 objective/验收清单必须与 TaskSpec 一致；Session 为 binding 固定 root，workspace 为绑定的规范路径，权限为 danger-full-access，operation ID 为原 prepare ID。模型路线用固定 CLI provider/model；API Key 仍从原 credential/env 机制读取，不写入 manifest。

```sh
# bootstrap.json 必须是 permit 私有目录的直接子文件，普通文件、0600、≤256 KiB。
xharness-host --bind 127.0.0.1:3082 \
  --workspace <canonical-vm-workspace> --state-dir <canonical-binding-state> \
  --hosted-permit-dir <binding-private-dir> \
  --hosted-bootstrap-file <binding-private-dir>/bootstrap.json \
  --provider <fixed-provider> --model <fixed-model> --base-url <authorized-endpoint> \
  --context-window <verified-context> --max-output-tokens <output-budget>
```

也可指定 `XHARNESS_HOSTED_BOOTSTRAP_FILE`；没有 permit 目录不能单独启用。当前固定模型引导拒绝 providers-file，以免 Prepared 启动时联网探测能力。

1. 首次预留要求 root Session 不存在；已存在的外来/旧 Session 不自动接管。
2. `launch N` 查询到 `prepared_ready` 且 applied reservation 匹配，才可让控制器消费 Prepared；此时 HTTP ready 仍是 503，模型请求为零。
3. 原 Active transition 使用稳定 operation ID；收到 ack 后等同一 launch `ready`，不新建 Goal 或追加普通 user 请求。
4. 相同 manifest 优雅重启只重放原 Session receipt。修改过的 Goal/模型偏好保留；删除了已应用 journal 必须报错，不重建。
5. PreparedReady 中临时停止也走原 runtime shutdown；Sealed 后重启不得领取新 generation。更早的 boot 中断没有可靠 Stop 时，等待外部核对，不重置 journal 绕过。
6. `NativeStageExecutor::inspect` 无副作用；激活超时后只查原 ack/Ready。只有 native Stop，控制器仍应停在 Settling；外部 VM 静止/数据保留和 Goal 验收必须另行证明。

### 原 Host + 真模型验收（私有 fixture，不是公网产品入口）

远程编译后，在已经授权的 retained VM-1 内执行；另外三台不得为此启动。仍保留原 VM Host/服务，新 fixture 使用独立目录和固定 SHA 的独立服务。模型 Key 不进入 VM：V100 通过仅 loopback 的测试 relay 提供**固定 DeepSeek model/completions**，客体只拿短期 scoped token；已有 VM 通用公网出网限制不变。

```sh
python3 scripts/test-cloud-goal-acceptance.py  # 离线 guard；不读取真实 Key

# model-config 由可信调用者从既有配置私下提供：0600、≤16 KiB，不进入 rsync/仓库/报告。
# 仅允许 base_url=https://api.deepseek.com，model=deepseek-flash。
python3 -u scripts/cloud-goal-acceptance.py \
  --root "$HOME/codex-build/x-harness-rs/cloud-vm-lab-20261001" \
  --host-binary <remote-fixed-host-artifact> \
  --permit-binary <remote-fixed-native-permit-artifact> \
  --model-config <private-ephemeral-model-config>
```

脚本限最多 24 次模型请求、8192 单次输出、900 秒 relay 使用期；任务显式 3 轮预算，要求两轮自动 Goal 编程、独立 unittest/语义验证、确认等待态重启无模型重放、seal/Stop 与外部 VM 停止。Host fixture 1 GiB/128 PIDs，QEMU 原 4 GiB/128 PIDs 上限不变。保存请求量、usage、artifact hash 和阶段证据，不保存 Key 或模型全文。

必须在远程有界 systemd 作业执行，并配置外层 TTL + ExecStopPost 清理同一 VM 与临时私有 model-config；脚本 finally 清理 scoped token、隧道与 VM。断开本机 SSH 不影响测试，TTL 到期不会遗留无限任务。**不得把 fixture 的示例版本引用与测试 relay 宣称为已完成的生产材料/凭据授权**。

注意 systemd 的边界：`Type=oneshot` 的任务一直处于 activating，**只设 RuntimeMaxSec 不足以限制这一阶段**。必须设置 `TimeoutStartSec=1200s`；或使用 `Type=exec` 配合 `RuntimeMaxSec=1200s`。两者都要配置 TimeoutStopSec 和同身份的 ExecStopPost。一次性验收模板：

```sh
# fixture-command-wrapper 是私有脚本，内含固定产物/实验根/model-config 路径，不含 Key 文本。
systemd-run --user --no-block --unit=<unique-acceptance-unit> \
  --property=Type=oneshot --property=TimeoutStartSec=1200s \
  --property=TimeoutStopSec=60s \
  --property='ExecStopPost=/bin/sh -c "systemctl --user stop <verified-vm-unit>; rm -f <private-model-config>"' \
  <absolute-private-fixture-command-wrapper>
```

不能把通配符或用户输入的 shell 文本拼进停止单元/配置路径。真实 Goal 运行已正常清理；外层 timeout + ExecStopPost 另以短时无 VM 的 sleep fixture 验证，不额外耗用模型额度。

结果见[Goal 引导验收](../reports/cloud-goal-bootstrap-20261002.md)。Linux 实机证据不等同于跨平台桌面或所有 CLOUD-T01～T24 完整验收。本批不替换本机 App/Web，不自动提交、发布或开放新端口。
