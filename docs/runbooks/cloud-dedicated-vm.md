# 专属测试环境：V100 VM-1

日期：2026-10-01。复用已授权四 VM 实验的 **VM-1**，不创建第五台、不占用 V100 GPU，不修改现有模型服务。

> 更新边界（2026-10-03）：本文保留 10-01 专属基础设施操作与验收记录。后续原 Host 门禁、唯一 Goal 与真实 DeepSeek 验收已完成，见 [10-02 Goal 报告](../reports/cloud-goal-bootstrap-20261002.md)；仍没有生产云端 Submit/Gateway/客户端路由。下文的“待完成”属于当日记录，不代表后续未开展。

## 当前能做什么

固定身份、持久磁盘、人工启动/停止、原 Host API、合成会话与工作区恢复。**暂不能提交长期 Agent 托管任务**：原 Host Prepared/Active/Sealed 门禁和停止收据已有[首切片](cloud-native-execution-gate.md)，控制器阶段接线、Goal 引导、可信恢复授权/终态核对、真实 DeepSeek 与本机 UI 仍待完成。不能把“Host 重启后能读会话”称为“取消的任务不会重跑”。

| 项目 | 已验证策略 |
| --- | --- |
| 身份 | VM UUID `89ac0170-3edd-473c-8f86-c698f0ce4451`，沿用实验 VM-1 的磁盘和 SSH 身份 |
| 宿主根 | `~/codex-build/x-harness-rs/cloud-vm-lab-20261001`（WZU_Server） |
| 控制库 | `~/codex-build/x-harness-rs/cloud-control-dedicated-20261001`，独立 SQLite，不复制会话历史 |
| 环境引用 | `v100-dedicated-1/v1`，可信管理 owner `owner-wangyue` |
| 生命周期 | 人工启动；停止保留磁盘；物理宿主重启后不自动启动；没有自动销毁/清盘策略 |
| 资源 | 2 vCPU、2 GiB 客体 RAM、QEMU 4 GiB MemoryMax/SwapMax=0/TasksMax=128；沿用 16 GiB qcow2 虚拟容量 |
| 未实现的硬配额 | CPU 仅绑两个核心，不是 CPU quota；qcow2 虚拟容量不等于宿主磁盘配额 |
| 网络 | 无客体出网、无公网入口；宿主 127.0.0.1:24000 转发客体 SSH，24001 转发原 Host |
| 凭据 | 无模型 Key、无用户真实聊天；实验专用 SSH key/seed 仅在服务器私有目录 |

VM 内实验用户能 sudo，不代表生产 `standard-user` 权限身份已经正确配置；真实任务适配必须额外验证身份与停止策略。

## 可信操作

在 WZU_Server 的同步源码目录执行。脚本持有实验根锁，只操作固定 VM/unit，不停止其他服务。

```bash
ROOT="$HOME/codex-build/x-harness-rs/cloud-vm-lab-20261001"
python3 -B scripts/cloud-dedicated-vm.py promote --root "$ROOT"
python3 -B scripts/cloud-dedicated-vm.py status --root "$ROOT"
python3 -B scripts/cloud-dedicated-vm.py start --root "$ROOT" --operation-id manual-start-001
python3 -B scripts/cloud-dedicated-vm.py stop  --root "$ROOT" --operation-id manual-stop-001
```

同一 operation ID 是同一操作，只查询/返回旧收据，不代表重新执行。需要有意重新启动时使用新 ID，但有未核对的旧启动必须先查询或由明确外部停止收据封住；换 ID 不得隐藏未知副作用。历史启动经停止封存后再次查询，不能把后来另一代 VM 进程归给旧操作。

操作 Pending 写入在外部副作用之前，Applied 只在 UUID/QMP、原 Host Ready 和资源探测正确后写入；停止需要 unit/MainPID/cgroup/端口全部证明已停。超时保留未知，不当作“没启动”。这里的运维操作 JSON 是实验环境生命周期证据，**不是原 Host 的任务执行许可或分布式数据库事务**。

专属启动使用 `RuntimeMaxSec=infinity`。实测该服务器 `RuntimeMaxSec=0` 会立即触发 runtime timeout；不把 0 解释为无限。原四 VM 实验的默认 1800 秒上限保持不变。

本机要观察已有 Host，可建立仅本机可访问的隧道：

```bash
ssh -N -o ForwardAgent=no -L 127.0.0.1:34001:127.0.0.1:24001 WZU_Server
```

它只提供原 Host 测试 API，当前没有完整 Web Bundle 或模型配置，不是软件的远程环境选择器。

## 登记与任务拒绝门禁

```bash
python3 -B scripts/cloud-control-dedicated-register.py \
  --root "$ROOT" \
  --control-dir "$HOME/codex-build/x-harness-rs/cloud-control-dedicated-20261001" \
  --binary "$HOME/codex-build/x-harness-rs/target/debug/xharness-cloud-control"
```

必须先有九项实机验收，并在停止状态登记。登记、进程重开、重复登记保持同一环境；`single_writer/full_access/managed_cleanup/model_reachable/material_reachable/retention` 等任务级能力尚未验证，仍为 `unknown`。脚本提交合成 readiness canary，必须 `CapabilityUnavailable` 且零 Task。不能为了能演示而把未知手工改成 supported。

## 验收与证据

```bash
python3 -B scripts/test-cloud-vm-lab.py
python3 -B scripts/test-cloud-dedicated-vm.py
python3 -u -B scripts/cloud-dedicated-acceptance.py --root "$ROOT"
```

15 项实验 guard、16 项专属 guard 与 9 项真实专属验收在 V100 通过。专属 guard 后补四项“停止证明已落盘但前序 tombstone 修复失败”“旧停止不封存后来的启动”“外来收据身份”“状态路径符号链接”也已远程重跑通过；前次 SSH/rsync 阻塞没有回退另一宿主或本机编译 Rust。实机已验证：同一盘/UUID、重复启动收据、无时长到期、独立 SSH 再连接保留文件、原 Host 重启、客体 reboot、外部停止/冷启动、最终四台均停止。原生门禁独立 fixture 的 8 项补充验收见[报告](../reports/cloud-native-execution-gate-20261001.md)，不能当作真实长期任务完成。

- 成功报告：`dedicated/acceptance-430278a03db24108-report.json`。
- 登记门禁：`dedicated/control-registration-report.json`。
- 环境与运维收据：`dedicated/environment.json` 与 `dedicated/operations/`。
- 早期 RuntimeMaxSec 失败报告保留，不覆盖、不删除实验磁盘。
- 本机完整非敏感测试日志与当前源码 Hash：忽略目录 `dist/regression/cloud-02-03-20261001/`，其中 `summary.json` 明确区分最后通过版本、后补 guard 与未接产品路径；未下载 SSH key/seed/磁盘。

本次无真实模型调用、无 Goal/Agent 恢复验收。所有 VM 最终已外部核实停止，之后用户人工启动才会继续计资源。下载证据仅选 JSON/测试日志；不得复制 `auth/seed.iso/user-data/disk.qcow2` 到源码、公开报告或 Git。

## 下一门禁

先接原 Host 原生执行许可，封住启动恢复、Goal/Schedule/子 Agent/Job/PTY/辅助模型路径；然后接 StageExecutor，验证临时停机续跑与取消后不可复活。通过后才配置 VM 内模型、用真实 DeepSeek 做多轮故障验收，最后接原 UI。保持环境专属不等于已解决任务终态。
