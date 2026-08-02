# 轮次结束契约第一阶段验收（2026-10-04）

## 范围和源码

- 仓库：`123123213weqw/x-harness-rs`，基线 `c8440aec11969c1bae1a9c90881e128336f80459`。
- 分支：`refactor/generated-turn-end-contract-20261004`。
- 第一阶段仅迁移 turn/end；不表示所有 RPC/Tool View 已统一，也没有更换 Windows 原生执行边界。
- Rust canonical DTO 同时进入持久投影和 Core 驱动；Chat、Trajectory、Runtime Session 采用生成 codec。
- 生成 schema/fixtures 来自远程实际 Rust 输出，不是根据 TypeScript 手造；最终重导出 `--check` 通过。

## 结果

| 门禁 | 结果 |
| --- | --- |
| 远程 `cargo fmt --all --check` | 通过 |
| 远程 `cargo test --locked --workspace --all-targets` | 根 Workspace 未过滤 harness 1134 passed / 15 ignored / 0 failed；另有 4 次子进程过滤探针通过，共 1138 次通过执行 |
| 远程 `cargo clippy --locked --workspace --all-targets -- -D warnings` | 通过 |
| 远程 Projection 实际 DTO/Schema 导出专用测试 | 1 passed；七种 durable 终态及 Core 驱动 DTO 对照 |
| 本机 UI 门禁组合 | 56 条命令全部退出 0；Node reporter 合计 567 passed / 0 failed / 0 skipped，另含直接断言脚本及 5 项 Python 架构单测 |
| 最终专用跨语言 Node 测试 | 12 passed / 0 failed；含坏终态恢复和 pending approval/question 保留 |
| Chromium 整轮/工具/窗口化与真实终态 DOM | 通过；42 个实际组装窗口 |
| WebKit 整轮/工具/窗口化与真实终态 DOM | 通过；42 个实际组装窗口 |
| 严格 TS、Plugin API、产物一致性和干净独立构建 | 通过；53 模块、165 资源；生成文件漂移在发布产物前阻断 |
| 架构和源码差分 | 原 38 crate / 8 processor 边界保持；源码/冻结业务差分、分页、重连、异步恢复继续通过 |

84 个真实窗口 = 7 durable reasons × live/history × success/error/outcome-unknown × 两浏览器。
断言包括唯一常驻结束按钮、完整正文、失败工具保留、折叠/重开、未知结果保护。
原 80 工具的高度折叠、浏览器滚动锚点、键盘焦点、原生 details/Think/Compaction 状态、
边界历史、图片/无正文、observer 清理回归仍通过。

读兼容覆盖 aborted/stop、旧 error/failure 和无错误详情；固定 v1 语料双向检查、u32
边界、缺字段/错类型/未知终态、Schema 未支持约束、重复/重叠 oneOf 和生成漂移均有门禁。
已提交 seq 的坏重复帧不会污染 UI；坏实时 terminal 保留旧窗口，权威历史修复后恢复，
审批与问题状态不因历史重拉被清除。未知外来事件及扩展字段继续保留。

## 执行环境与原始证据

Rust 全部在 `WZU_Server:~/codex-build/xharness-wire-contract-20261004/` 编译、测试。
每次执行前同步当前源码，排除 .git、target、node_modules、.env、.env.*、密钥和敏感环境文件。
最初共享构建目录带有不属于当前源码的旧实验 examples；没有删除它们，改用新独立目录，
不将污染目录的失败或成功记作本轮完整验收。没有在本机编译 Rust。

本机完整输出：

- `/tmp/xh-wire-final-remote-regression-20261004.log`（远程最终测试、Clippy、明确成功 marker）
- `/tmp/xh-wire-local-regression-20261004.log`（56 条门禁、全部 Node/Python 输出）
- `/tmp/xh-wire-local-regression-20261004.sh`（命令顺序）
- `/tmp/xh-wire-node-contract-20261004.log`（最终 12 项跨语言测试）
- `/tmp/xh-wire-browser-chromium-20261004.log`
- `/tmp/xh-wire-browser-webkit-20261004.log`
- `/tmp/xh-wire-export-final-20261004/`（实际 Rust 导出与提交物一致）

这些 /tmp 原始证据不是产品日志，不会打进安装包。

## 限制

- GitHub CI 已加入强制重新导出/漂移校验和真实消费回归；本次没有提交 PR、合并、发布或触发
  GitHub 的 Windows/macOS 原生构建，不宣称跨平台 CI 已绿。
- Linux 根 Workspace 的 cfg(windows) 原生测试不在 Linux 执行；其余平台和 Tauri 桌面构建仍由
  对应 CI/实机验证，不能用上述测试替代 Windows 内存崩溃验收。
- 浏览器用真实 Session/Assembler 的输出渲染，不是修改现有软件中的对话；没有替换或重启
  本机 XHarness.app / 独立 Web，也没有迁移、删除聊天记录。
- 本批没有调用付费模型，不更改模型配置或密钥；这是协议/生命周期的确定性回归，非模型行为实验。
