# 内存修复：边界与真实模型验收

规范：[请求审计与内存边界](../specs/request-audit-storage.md)。原始统计的机器可读摘要见同目录 `memory-audit-20260910.json`。

## 1. 发现的问题

本机旧桌面 Host footprint 5.1 GiB（峰值 6.9 GiB），allocator 已分配 4.8 GiB。69 个会话约 2540 MiB，其中 96.6% 是重复 request/header。源码确认启动枚举加载全部历史、无界 JSONL 快照缓存、重复 transcript 和整份计量投影。当前修复不删除历史、不改模型输入。

## 2. 合成内存对照

在 WZU_Server 独立进程运行同一构建的 `memory_replay`；8 个会话、512 个请求、1024 条真实消息事实，固定生成逐步增长的请求输入。分别使用旧式原始审计常驻模式、新运行时读取原日志、新运行时读取去重归档。使用 `/usr/bin/time -v`，不是推测或缓存账面数字。

| 读取模式 | 峰值 RSS | 读取/校验耗时 | 消息事实 |
| --- | ---: | ---: | ---: |
| 原始审计全量驻留（显式无界缓存） | 78 MiB | 5548 ms | 1024 |
| 新运行时、原日志不修改 | 10 MiB | 898 ms | 1024 |
| 新运行时、去重归档 | 9.5 MiB | 87 ms | 1024 |

三组都读取并验证了完整请求快照。原日志运行时视图峰值下降约 **87.2%**。合成原始目录 69,462,248 bytes，新归档整个目录 1,049,236 bytes；合成数据有大量跨会话相同消息，因此磁盘节省不能直接推广到真实任务。

**限定：**这是同一新二进制不同模式的隔离比较，不是旧发布版与新发布版的完整 App A/B；不是 Mac WebKit 的测量；没有清除 OS 文件缓存。不得据此承诺用户原来的 5.1 GiB 一定变成 10 MiB。

## 3. 真实 DeepSeek 产品链路

使用本地已有 DeepSeek 配置、Keychain 凭据经 SSH stdin 传递；模型 `deepseek-flash`。在服务器新建独立工作区，不读取/上传用户会话，不重启已有 App/Web/推理服务。

链路：正式 Host → Goal → Durable Runtime → Core → JSONL 审计归档 → 原生编码工具。任务是 CSV/Decimal 账本库、CLI、测试和文档。

- 初次 3 轮，306,384 ms。模型自测 144 项通过，但独立 12 项验收中有 1 项错误：CLI 无 flags 默认输出人类文本，未满足 JSON 默认输出要求。
- 没有放宽验收或手工修正产物；重启同一个 Host 会话，通过 GoalEdit/Resume 提交明确失败反馈。模型第 4 轮修正，116,253 ms。
- 最终 **151 项模型编写测试独立重跑通过；12 项独立验收通过**。
- 实际 101 次工具调用：bash 39、glob 1、write 3、edit 47、read 7、goal_report 4；100 success，1 error。错误是恢复后未先读取文件触发写入保护，模型自行处理后完成；不能把这种正确拒绝计成静默成功。
- 确认完成、同 RPC ID 重复确认、JSONL 重读全部通过，累计 4 轮。
- 104 份请求归档全部校验 SHA-256，并完整重建 11,023 条累计输入条目；不是把 input 置空后不再可读。
- 热 JSONL **1,755,683 bytes**，冷审计 **1,318,973 bytes**；相同完整请求若逐次内联，光 RequestHeader 约 **26,279,677 bytes**。真实会话消息、工具结果仍独立保留。
- `/usr/bin/time -v` 首次实验峰值 197,696 KiB，反馈轮 109,960 KiB；统计可能包含子进程高水位，不能称为严格隔离的 Host 堆快照，也不能与不同任务的 TTFT/耗时直接比较。

## 4. 自动化回归

- V100：全仓 **564 passed、0 failed、5 ignored**；`cargo clippy --workspace --all-targets -- -D warnings` 通过。
- 存储新增覆盖：无损归档/去重、重启、老日志不改字节、消息事实不变、缓存淘汰/禁用/超大条目/切换模式、旧 cut/CAS、审计缺失/损坏、符号链接、未知完整末条、不带换行追加后的索引、Unicode/图片/opaque reasoning/CRLF。
- Host：请求按需读取、非法/不存在的 session/seq、取消常驻 transcript 后导出仍完整；原审批、恢复、队列、Goal、工具回归一起运行。
- Chromium/WebKit：实际 Context/Harness 组件完整恢复、错误重试、过期响应、切会话、选中范围限制、Diff 前后快照和卸载。
- Node：上下文计量、模型设置、执行检查点、消息编辑、附件契约和资源 hash 回归通过。

## 5. 复现与交付边界

按 AGENTS.md 同步到 V100，远程执行：

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p xharness-session-jsonl --example memory_replay
./target/debug/examples/memory_replay generate-legacy /new/fixture-legacy
./target/debug/examples/memory_replay generate-archive /new/fixture-archive
/usr/bin/time -v ./target/debug/examples/memory_replay replay-raw /new/fixture-legacy
/usr/bin/time -v ./target/debug/examples/memory_replay replay-runtime /new/fixture-legacy
/usr/bin/time -v ./target/debug/examples/memory_replay replay-runtime /new/fixture-archive
```

真实模型使用 `goal_product_eval`（stdin 配置）；`--revise ROOT` 通过环境变量 `XHARNESS_GOAL_EVAL_OBJECTIVE` 接收独立验收反馈，`--confirm ROOT` 先跑独立验收再完成确认。不要把凭据放命令行或仓库。

本次未发布、推送或替换本机软件。**安装包必须配套更新 Host/UI，并保留整个 state（包含 request-audit）**。跨平台 GitHub CI、正式发布以及同一用户历史的升级前后 Mac footprint 仍列为 MEM-06。
