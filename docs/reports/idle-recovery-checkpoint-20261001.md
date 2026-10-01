# 闲置恢复快照验收（2026-10-01）

## 范围与状态

已实现 `HISTORY-02b1`：有效闲置快照恢复、受限设置尾段折叠、坏/旧/超界旁路回退，以及标题终态的后台加载保护。规范见 [闲置恢复快照](../specs/idle-recovery-checkpoint.md)。

原 JSONL 仍是权威数据，未删除、裁剪或迁移真实聊天。模型执行继续读取完整 Session；这里的快照不是模型 Compact，也不允许自动重执行中断工具。
活动 Inbox、审批/问题/迟到答案、Goal、Schedule、Compaction 和模型轮次仍完整恢复；其快照加速 `HISTORY-02b2` 单独留在 TODO，不能把本阶段说成已经优化所有 Runtime 恢复。
未推送、发布或替换已安装 App/Web，macOS/Windows 安装验收尚未执行。

## 远程回归

源码与未提交修改通过 rsync 同步到 `WZU_Server:~/codex-build/x-harness-rs/`，排除 `.git/`、`target/`、`node_modules/`、环境文件和密钥。
所有 Rust 编译、测试、Clippy 均在 V100 服务器运行，本机只做格式/差异检查。

```sh
# 在远程项目目录执行
~/.cargo/bin/cargo test --workspace --all-targets
~/.cargo/bin/cargo clippy --workspace --all-targets -- -D warnings
node scripts/test-atomic-history.mjs
```

结果：**917 项通过、0 失败、14 忽略**；Clippy `-D warnings` 通过；历史原子映射/分页前端回归通过。
不重复统计 Control/JSONL 跨进程验收打印的 4 个子进程结果。
忽略项包括显式性能/真实服务/隔离诊断测试，不等于全部已执行；本次另行执行了新增的隔离性能测试。

本阶段新增 21 项普通测试：

- JSONL 11 项：原字节不变、重启及原始游标、来源变化、坏/缺失/未知/超大旁路、破损/CAS/Seq 尾部、发布失败、符号链接、v2 压缩、事件/解压预算及并发追加。
- Host 9 项：快照/完整恢复摘要与回执一致、精确设置尾段、未启用 Runtime 回退、新模型轮次/损坏回退、当前配置默认值、中断工具暂停且不重执行、非法语义仍报错、标题后台不重新物化历史。
- Metrics 1 项：每个事件切点序列化私有状态后继续折叠，跨日 Usage 修正、工具耗时、模型变化与 Fork 重置都与完整结果一致。

远程另有不属于本改动的 `edit_mode_ab.rs` 实验文件，已有 `&PathBuf` Clippy 告警；全目标验收临时将远程副本移出并在退出时原样还原。本机原文件保留，未纳入改动。

## 隔离合成性能：release 对照

额外在 V100 构建优化版 Host 测试 executable：

```sh
~/.cargo/bin/cargo test --release --locked -p xharness-host --lib --no-run --message-format=json
```

release Host 单元测试 **190 通过、0 失败、6 忽略**。编译器输出的实际 executable 再用于隔离测试，不在本机构建。
与下面 debug 对照采用相同内容规模的合成日志，快照为 1,924 字节；最终标题终态字段也包含在这一轮构建中。

| 场景 | 完整恢复中位耗时 | 快照路径中位耗时 | 完整恢复峰值 RSS | 快照路径峰值 RSS |
| --- | ---: | ---: | ---: | ---: |
| 源日志未改变 | 1.944098 s | 0.607 ms | 28.62 MiB | 9.00 MiB |
| 快照后追加 1 个 Plan 设置事件 | 1.960915 s | 0.944987 s | 30.01 MiB | 9.50 MiB |

无变化快照的第一次恢复为 **2.048 ms**，其后两次为 0.607 / 0.370 ms；不要把中位数理解成每次整台软件冷启动都只需这个时间。
每个场景的完整/快照六次状态摘要都一致，且与下面 debug 摘要相同；快照路径完整加载计数始终为 0。
日志增长后的前缀哈希仍然占主要开销，不能将其宣传成常数时间。以上只是只读 Host 恢复测试，未包含历史页面渲染、标题实际生成、Tauri 或 WebKit。

## debug 对照及测试口径

同一 fixture：512 个已关闭轮次，每轮 256 KiB 旧内嵌请求审计及约 32 KiB 正文；原日志 **151,673,202 字节（144.65 MiB）**。
旁路快照约 **1.9 KiB**，不含完整 Transcript。该大小只属于此 fixture，不代表真实会话的指标/去重状态始终这么小。

Session 内存缓存关闭。`full` 是同一源码的完整恢复回退，`checkpoint` 是来源有效的快照恢复；每种模式各启动一个独立测试进程，在进程内连续创建 3 个全新 Host。Store 只复用小型文件戳、不保留完整 Session。
这是**进程恢复冷、操作系统文件缓存暖**的 debug 测试，不是磁盘冷启动，不含 WebKit/前端/已安装 App，也不是与旧发行版的黑盒比较。
`/usr/bin/time -v` 测测试 executable 的峰值 RSS，不把 Cargo/Rust 编译器算作软件内存。

| 场景 | 完整恢复中位耗时 | 快照路径中位耗时 | 完整恢复峰值 RSS | 快照路径峰值 RSS |
| --- | ---: | ---: | ---: | ---: |
| 源日志未改变 | 25.875872 s | 2.359 ms | 40.14 MiB | 20.00 MiB |
| 快照后追加 1 个 Plan 设置事件 | 25.901207 s | 11.566925 s | 40.14 MiB | 20.50 MiB |

无变化快照不调用完整 `Store::load`；六次恢复摘要 SHA-256 均一致：
`19ed7ad49f89a04cd466776eb62402b71d68bdaadfadfab04bd8afc564cb0936`。
追加设置尾段后六次摘要也一致：
`001647127fb3678e21b94823a2e5c12ad3cf7487af7da8ba383be84645b9b8f8`。

**增长尾段并非常数时间**：冷进程必须流式计算已验证旧前缀的 SHA-256，防止同一文件被改写后冒充追加。
它不解码/保留旧事件，但仍有 O(旧日志字节数) I/O/CPU；debug 中这部分很明显。热发布复用增量 SHA 状态，完整同步后能把快照重新锚定到最新边界。
因此不能把“2.359 ms”推广到有尾段、无快照、未支持工作或所有真实软件启动。

## 复现方式

显式忽略测试入口：`restore_checkpoint::tests::recovery_checkpoint_performance_acceptance`。
它只接受临时目录下、带合成标记的 fixture；测试 Runtime 在尝试执行模型工作时直接失败，不依赖真实 DeepSeek 额度验证只读存储。

```sh
# 必须在远程项目目录执行；EXE 从 Cargo compiler-artifact 的 executable 取值。
~/.cargo/bin/cargo test --locked -p xharness-host --lib --no-run --message-format=json
ROOT=$(mktemp -d /tmp/xh-recovery-bench.XXXXXX)
TEST=restore_checkpoint::tests::recovery_checkpoint_performance_acceptance
XHARNESS_RECOVERY_BENCH_MODE=fixture XHARNESS_RECOVERY_BENCH_ROOT="$ROOT" \
  "$EXE" --ignored --exact "$TEST" --nocapture
for mode in full checkpoint; do
  /usr/bin/time -v env XHARNESS_RECOVERY_BENCH_MODE="$mode" \
    XHARNESS_RECOVERY_BENCH_ROOT="$ROOT" "$EXE" --ignored --exact "$TEST" --nocapture
done
XHARNESS_RECOVERY_BENCH_MODE=append-tail XHARNESS_RECOVERY_BENCH_ROOT="$ROOT" \
  "$EXE" --ignored --exact "$TEST" --nocapture
# 再分别运行 full/checkpoint，验证追加后的精确尾段及摘要。
```

原始完整输出已返回本机：

- `/tmp/xh-recovery-checkpoint-full-regression-20261001.log`
- `/tmp/xh-recovery-checkpoint-performance-20261001.log`
- `/tmp/xh-recovery-checkpoint-release-build-20261001.log`
- `/tmp/xh-recovery-checkpoint-release-host-tests-20261001.log`
- `/tmp/xh-recovery-checkpoint-release-performance-20261001.log`

合成 fixture 验收后已定点删除；没有清理真实会话目录。

## 尚未通过的门禁

1. GitHub macOS/Windows CI、真实最大旧日志与 App 安装后的启动/历史分页端到端验收。
2. 活动 Runtime 快照：仍复用原完整恢复，不改变 Inbox CAS、审批、问题、Goal/Schedule 及工具副作用保护。
3. 历史索引增量维护；追加/压缩失配时索引可能要求完整解析，不能承诺整个“打开对话”始终只有快照开销。
4. 无快照的首次完整恢复仍需读全文件；巨型去重/指标状态超过旁路限额时也完整回退，原数据不缩减。
