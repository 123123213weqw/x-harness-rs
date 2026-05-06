# XHarness 回归与真实模型验收

本流程用于重构、解耦和缺陷修复。Rust 编译只在远程服务器执行；本机只负责同步源码、
触发命名测试并收集证据。测试失败不会自动变成代码修改，必须先区分产品缺陷、测试缺陷、
网络/凭据故障和模型行为波动。

## 套件

| 套件 | 内容 | 使用时机 |
|---|---|---|
| `quick` | 架构边界、fmt、workspace check、关键状态机、无浏览器 UI 契约 | 每个小提交 |
| `full` | 完整 workspace test/clippy、进程清理、UI 契约 | PR 合并前 |
| `live-smoke` | 真实模型单次写文件、受管后台 Job | Provider/工具链改动 |
| `live-full` | smoke + 真实代码修复 + 执行检查点连续性 | 候选版本 |
| `full-live` | full 全绿后才运行 live-full | 合并/发布门禁 |

`full-live` 在离线回归失败时不会消耗真实模型额度。

## 服务器凭据（一次性）

凭据只存放在服务器，不写进仓库、不经 rsync、不作为命令行参数。登录服务器后执行：

```bash
install -d -m 700 ~/.config/xharness
umask 077
read -rsp 'DeepSeek API key: ' KEY; echo
printf 'XHARNESS_LIVE_API_KEY=%q\n' "$KEY" > ~/.config/xharness/regression.env
unset KEY
cat >> ~/.config/xharness/regression.env <<'EOF'
XHARNESS_LIVE_BASE_URL=https://api.deepseek.com
XHARNESS_LIVE_MODEL=deepseek-v4-flash
EOF
chmod 600 ~/.config/xharness/regression.env
```

不要把文件内容输出到终端或 CI 日志。

已有的受限权限 Bench 凭据文件也可以直接复用；Runner 兼容
`DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL`，无需复制密钥：

```bash
scripts/regression/remote-regression.sh --suite live-smoke \
  --secret-file '~/.config/xharness-bench/credentials.env'
```

## 在 WZU_Server 上运行

```bash
# 快速结构回归
scripts/regression/remote-regression.sh --suite quick

# 合并前完整离线回归
scripts/regression/remote-regression.sh --suite full

# 低成本真实模型验证
scripts/regression/remote-regression.sh --suite live-smoke \
  --model deepseek-v4-flash \
  --base-url https://api.deepseek.com

# 最终门禁：离线全绿后自动继续真实模型
scripts/regression/remote-regression.sh --suite full-live
```

辅助 Linux 节点可显式指定，但默认仍使用 V100：

```bash
scripts/regression/remote-regression.sh --host RWKV_Ubuntu --suite quick
```

源码同步至 `~/codex-build/x-harness-rs/runs/<run-id>/source/`，Cargo Target 复用
`~/codex-build/x-harness-rs/target/`，既隔离不同源码快照，也保留编译缓存。
成功运行在证据下载后自动删除远程源码快照；失败运行保留快照以便精确复现。

## 证据

运行结束后证据下载到：

```text
dist/regression/<run-id>/
  source.json
  environment.json
  results.jsonl
  summary.json
  summary.md
  logs/*.log
```

即使部分测试失败，其他测试仍继续，最后统一返回非零状态。修复 Bug 时把失败用例名称写进
提交和 PR；先补稳定复现，再修实现。真实模型失败必须保留完整测试日志、模型路由和源码 SHA，
但日志不得包含 API Key。

## Bug 处理门禁

1. 先确认失败属于产品、基础设施、凭据还是模型行为。
2. 产品缺陷必须转成离线确定性测试；只有无法离线表达的行为才保留真实模型验收。
3. 修复只改变一个职责边界，不顺便重构无关代码。
4. 运行 `quick`，然后运行受影响模块的精确用例。
5. PR 前运行 `full`；Provider、工具描述或 Agent 策略变化再运行 `live-smoke`。
6. 合并/发布前运行 `full-live`，保存报告作为验收证据。

## 解耦期间的额外规则

- `config/architecture-dependencies.json` 冻结当前生产依赖边。删除依赖允许，新增边默认失败。
- 实时/历史投影、Token Admission、Compact、工具生命周期都要使用相同 Fixture 做新旧差分。
- 不对同一个真实副作用同时运行新旧实现；录制 Tool Result 后分别重放。
- Session Event、RPC 和持久化格式的变化必须单独提交迁移测试，不能藏在结构重构中。
