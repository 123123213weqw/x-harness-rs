# 四 VM 托管环境实验

日期：2026-10-01。授权测试宿主：`WZU_Server`。这不是生产云控制服务，也不是运行中任务的无缝迁移。

## 验收边界

使用四台真正的 KVM VM，而非四个目录、容器或 Fake Environment。每台部署同一固定指纹的原 `xharness-host`，复用原 `session.create/list/rename/history` API。

验收：四环境隔离、客户端反复切换连接不串历史、Host 重启、客体暂停、单 VM 崩溃、停止确认丢失后的外部核对、原盘恢复和停止清理。断开观察时继续运行的是明确标注的客体测试进程，**不是 Goal 或真实模型任务**。

另有 `xharness-cloud/tests/multiple_environments.rs` 的确定性领域测试，验证四绑定、请求重放、跨环境/世代拒绝、未知结果不抢占旧卷、单任务取消不影响其他任务。它们使用 Fake Environment，不能替代上述真实 VM 测试。

四 VM 全在一台物理宿主上。不能由此证明跨云厂商、跨机房、宿主故障后的接管，或分布式存储 fencing 已实现。完整云接线仍按 `CLOUD-02`～`CLOUD-09` 推进。

## 宿主保护与前置检查

| 项目 | 实验策略 |
| --- | --- |
| 客体 | 每台 2 vCPU、2 GiB RAM、独立 16 GiB qcow2 虚拟盘 |
| QEMU | 每单元 `MemoryMax=4G`、`MemorySwapMax=0`、`TasksMax=128`，启动后读取 cgroup 文件确认生效 |
| CPU | 每台进程及继承线程绑定两个 CPU，四台使用八个不同 CPU；当前用户 cgroup 不支持 CPU quota，不能把 `CPUQuota` 描述成生效 |
| 生命周期 | 独立随机 unit 名、30 分钟运行上限、停止整个 control-group；仅管理本实验的精确 unit |
| 文件 | bwrap 私有 mount/PID/IPC/UTS/user namespace；只可写自己的 VM 目录，基础镜像只读；不映射宿主 Home、工作区、SSH 私钥或其他 VM 目录 |
| 设备 | 仅 KVM 与最小 `/dev`，不透传 GPU、USB 或块设备 |
| 网络 | QEMU user network `restrict=on`；仅 127.0.0.1 的 SSH 与测试 Host API 转发，无公网入口、无客体出网 |
| SSH | 实验专用 client key；提前生成独立客体 host key 并固定 known_hosts；严格主机密钥校验，不转发 agent，不设置明文登录密码 |
| 凭据 | 不传现有模型、云账号或宿主凭据；用合成会话标记验证，不复制用户真实对话 |

VM 内可 sudo，但这不授予宿主 sudo。QEMU 自身以普通用户运行，并启用 seccomp sandbox。CPU 亲和性不是独占核心，也不是磁盘 I/O 配额；共享宿主仍可能有性能竞争。

前置条件：普通 Linux 用户、KVM 可读写、`qemu-system-x86_64/qemu-img/bwrap/cloud-localds/ssh-keygen/systemd-run/python3` 可用、user systemd memory/pids controller 生效、至少 16 个可用 CPU、32 GiB 可用内存，磁盘能容纳四份最坏大小虚拟盘及余量。任一硬门禁失败就停止，不自动改成无隔离启动、换宿主或开放网络。

## 运行步骤

### 1. 同步、远程编译

必须遵守仓库 Rust 远程编译政策。同步当前源码（包括未提交改动），排除 `.git/target/node_modules/dist/.env/.env.*`、私钥、认证 Cookie 等敏感文件。在 V100 执行：

```bash
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_TARGET_DIR="$HOME/codex-build/x-harness-rs/target"
export CARGO_BUILD_JOBS=4
cd "$HOME/codex-build/x-harness-rs/vm-lab-source"
cargo build --locked -p xharness-host-app --bin xharness-host
cargo test --locked -p xharness-cloud
cargo clippy --locked -p xharness-cloud --all-targets -- -D warnings
python3 -B scripts/test-cloud-vm-lab.py
```

实验使用 debug Host，以区分功能验收与 release 性能基准；不得把其磁盘大小或内存数据冒充正式安装包的基准。

### 2. 准备固定镜像

在一个全新、权限 0700 的实验根目录下创建 `images/`，下载 [Canonical Ubuntu 24.04 cloud image](https://cloud-images.ubuntu.com/releases/noble/release/) 和同站 HTTPS 的 `SHA256SUMS`。用完整 SHA-256 流式校验，成功后才将 `.part` 改名为 `base.img`。保存 `images/verified.json`：

```json
{"url":"https://cloud-images.ubuntu.com/releases/noble/release/ubuntu-24.04-server-cloudimg-amd64.img","sha256":"实际校验的64位小写SHA256","bytes":625612288}
```

示例字节数是本次镜像，不是固定协议限制。重新下载必须重新绑定准确指纹；`prepare` 再次验证镜像及单层 qcow2 格式，不允许已有 backing chain。这里使用 HTTPS 发布清单校验，并未声称完成独立 GPG 签名验证。

### 3. 建立四台独立 VM

以下命令**在 V100 上执行**：

```bash
python3 scripts/cloud-vm-lab.py prepare \
  --root "$HOME/codex-build/x-harness-rs/cloud-vm-lab-20261001" \
  --host-binary "$CARGO_TARGET_DIR/debug/xharness-host"

python3 -u scripts/cloud-vm-lab.py experiment \
  --root "$HOME/codex-build/x-harness-rs/cloud-vm-lab-20261001"
```

`prepare` 不启动 VM。它创建四个独立磁盘和 seed、固定 SSH 身份、VM UUID、二进制指纹、端口和 CPU 绑定。端口占用直接拒绝，不擅自换端口或停止已有服务。

实验脚本通过 cloud-init NoCloud seed 离线初始化，不要求客体从公网安装软件。[cloud-init NoCloud 说明](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html)

每个有副作用的入口持有本实验独占文件锁。脚本异常时 `finally` 停止本实验全部 VM；若控制进程被 SIGKILL 或 SSH 意外断开，不能假设 `finally` 执行，必须用下面的 `status/stop` 核对。30 分钟 QEMU 单元上限是额外兜底，不是控制服务的持久恢复机制。

### 4. 核对和停止

```bash
python3 scripts/cloud-vm-lab.py status --root "$HOME/codex-build/x-harness-rs/cloud-vm-lab-20261001"
python3 scripts/cloud-vm-lab.py stop   --root "$HOME/codex-build/x-harness-rs/cloud-vm-lab-20261001"
```

停止证明要求外部 systemd unit inactive/failed、MainPID=0、cgroup 无存活进程，且两个转发端口不再接受连接。仅 HTTP 超时、客体 `paused` 或 QMP 失联不算停止。

TCP `TIME_WAIT` 不代表 VM 存活。启动探测允许 `SO_REUSEADDR` 复用已关闭连接状态，但不使用 `SO_REUSEPORT`；真实监听者仍拒绝。单元停止证明与端口探测分别检查，不互相代替。

### 5. 修复实验脚本后重跑

只有所有 VM 都有外部停止证明才允许 `experiment --rerun`。旧 `report/checks` 自动改名保留，实验盘和身份不删除，不把旧错误报告覆盖成成功。

重跑只复用本实验合成 Session，创建前检查是否存在。真实宿主 Session 的持久化、标题投影和恢复仍由原 Host 决定，实验脚本不写业务 JSONL。

## 证据与保留

- `lab.json`：环境身份、固定镜像/Host 指纹和资源配置。
- `checks.json`：逐项结果，失败也写入。
- `report.json`：最终结果、外部停止证明、资源采样、磁盘元数据。
- `report-attempt-*.json/checks-attempt-*.json`：前次失败证据。
- `vm-N/disk.qcow2`：合成会话与工作区，停止后保留，**不自动删除**。

内存数据是四个 QEMU 服务的 `memory.current` 每 500ms 采样的同步求和，包含 QEMU 与客体承载内存，但不含编译进程和宿主 OS。各服务 `memory.peak` 不是同时发生，不能简单相加当成实测总峰值。

`auth/`、`seed.iso`、`user-data` 含实验 SSH 私钥，不能提交 Git、上传公开报告或带回通用源码同步。只下载 JSON 报告和非敏感测试输出。

资源隔离依据 [QEMU 安全文档](https://www.qemu.org/docs/master/system/security.html)；user network 与 hostfwd 参数依据 [QEMU Invocation](https://www.qemu.org/docs/master/system/invocation.html)。实验实际使用宿主 QEMU 6.2，不假设新文档所有新增选项都可用；每次启动必须实测门禁和监听范围。
