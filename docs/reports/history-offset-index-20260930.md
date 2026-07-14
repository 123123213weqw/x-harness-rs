# 历史偏移索引验收（2026-09-30）

## 范围

本次 `HISTORY-02a` 只优化已恢复、闲置会话的历史分页。规范见 [历史偏移索引](../specs/history-offset-index.md)。
原日志、模型上下文和 Agent 恢复算法均未改变；没有迁移真实聊天、没有替换 App/Web、没有发布。

## 远程回归

服务器：`WZU_Server`，Linux；源码包含当前未提交修改，以 rsync 同步到 `~/codex-build/x-harness-rs/`。
本机只执行格式化，所有 Rust 编译、测试、Clippy 均在远程执行。

```sh
~/.cargo/bin/cargo test --locked --workspace --all-targets
~/.cargo/bin/cargo clippy --locked --workspace --all-targets -- -D warnings
node scripts/test-atomic-history.mjs
```

结果：全工作区 896 项通过、0 失败、13 忽略；Clippy `-D warnings` 通过；前端历史原子替换/分页回归通过。
结果统计不重复计算 Control/JSONL 跨进程测试产生的 4 个子进程结果。
默认忽略项包含显式性能/真实服务/隔离诊断测试，不能当作已经执行。

新补 13 项测试覆盖：

- 所有分页游标、页大小、越界游标、重启和原日志字节不变。
- 追加/压缩失配与完整重放后重建；缺失、损坏、超大索引和发布失败。
- 索引符号链接、并发追加、破损尾部、语义损坏和旁路文件无法删除。
- 偏移/长度/revision 的极端整数、构建上限和解压前预算门禁。
- 索引/全量路径完整 RPC JSON 等价；工具卡片、附件来源、Compact、已完成/中断块的跨页依赖。
- 闲置有效索引不调用完整 Runtime load；运行中或索引无效时确实回退；历史查看不启动模型工作。
- 已有匹配的内存权威快照时保持原缓存路径，不反向强制重复磁盘读取。

期间修正了测试 fixture 的原子边界：assistant 与其镜像 ToolCall 必须同一批提交，不能将两者拆成无效中间日志。
本次实现的两个 Clippy 告警已改为来源参数对象和枚举 revision。
远程目录另有不属于本改动的 `edit_mode_ab.rs` 未提交实验，首次全目标 Clippy 报该文件既有 `&PathBuf` 告警。
最终回归临时将该文件移出包目录，结束自动原样还原；本机原文件始终保留，未改写或删除。

## 隔离合成性能对照

512 个完整 turn，512 个物理批次；每轮 256 KiB 旧内嵌请求审计和约 32 KiB 正文。
日志 151,514,737 字节（144.50 MiB），索引 84,798 字节（82.81 KiB，约原日志 0.056%）。
Session 缓存禁用；读取末尾 50 条可分页消息，返回 174 个原始事件。
`full` / `indexed` 使用同一源码、同一 fixture，分别在独立进程内运行三次；以 `/usr/bin/time -v` 记录测试进程峰值 RSS。
文件缓存为暖缓存，测试为 **debug 编译**，不包含前端渲染；`full` 是当前代码的完整重放回退，包含旁路索引维护，不是旧发行版的黑盒测量。

| 指标 | 完整重放 | 索引分页 |
| --- | ---: | ---: |
| 第一次耗时 | 14.380 s | 0.740 s |
| 第二次耗时 | 14.324 s | 0.715 s |
| 第三次耗时 | 14.327 s | 0.711 s |
| 中位耗时 | 14.327 s | 0.715 s |
| 测试进程峰值 RSS | 30.00 MiB | 12.50 MiB |

该 fixture 中分页约快 20 倍，测试进程峰值 RSS 下降约 58%。六次页面 SHA-256 一致：
`cf165f9950e26edf8b8243530623e067fb664ac9b89e058dc4db9ae6c94913f6`。

补充 `cached` 模式：预先完整恢复并保留内存快照后，三次读取为 0.099 / 0.059 / 0.056 s，页面摘要仍相同。
暖快照比重新读取索引更快，所以实现会优先保留既有缓存路径；上述 20 倍是**无内存 Session 缓存**时的对照，不是所有会话的普遍收益。
`cached` 独立进程峰值 30 MiB 包括预热阶段的完整恢复，不能用它当作一次暖读取的增量内存。

复现：先远程构建 JSONL 集成测试，取 Cargo 返回的测试 executable，设置位于 `/tmp` 的隔离目录：

```sh
# 必须在远程项目目录执行；EXE 来自当前 cargo test --no-run 构建结果。
~/.cargo/bin/cargo test --locked -p xharness-session-jsonl --test jsonl --no-run
ROOT=$(mktemp -d /tmp/xh-history-index-bench.XXXXXX)
XHARNESS_HISTORY_BENCH_MODE=fixture XHARNESS_HISTORY_BENCH_ROOT="$ROOT" \
  "$EXE" --ignored --exact history_index_performance_acceptance --nocapture
for mode in full indexed; do
  /usr/bin/time -v env XHARNESS_HISTORY_BENCH_MODE="$mode" \
    XHARNESS_HISTORY_BENCH_ROOT="$ROOT" "$EXE" \
    --ignored --exact history_index_performance_acceptance --nocapture
done
```

原始完整输出保留在执行机本地：

- `/tmp/xh-history-offset-clean-regression-20260930.log`
- `/tmp/xh-history-offset-fixture-20260930.log`
- `/tmp/xh-history-offset-performance-20260930.log`
- `/tmp/xh-history-offset-warm-cache-20260930.log`

验收后已删除远程隔离合成 fixture，只保留测试代码及输出；未清理真实聊天目录。

## 未完成的门禁

1. 本文验收时首次冷恢复仍完整重放；2026-10-01 已补 [HISTORY-02b1 闲置恢复快照验收](idle-recovery-checkpoint-20261001.md)，活动 Runtime 加速仍单独待办。
2. 每次追加/压缩后索引失效，索引增量维护/缓存命中刷新尚未实现。
3. 32 MiB 是优化路径读取预算，不是 RSS 硬上限；大批次/超大索引仍退回旧路径。
4. GitHub macOS/Windows CI 和已安装软件真实最大历史的验收尚未执行，不能用本表宣称 WebKit 或整个 App 降低同样内存。
