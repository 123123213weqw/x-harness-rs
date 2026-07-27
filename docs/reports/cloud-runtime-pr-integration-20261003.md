# 云端 Runtime 基础 PR：最新主分支整合（2026-10-03）

## 提交范围与未交付边界

当前目标为恢复公开开发的 `123123213weqw/x-harness-rs`，基线 master `4a508031db275143bda156fef952d9f1afcc793a`。从本地保留的云端提交 `649fa88`、`52393d7`、`7a4184c` 显式移植，生成独立公开提交，不推送私有主分支历史、私有发布流水线或部署记录：

- `xharness-cloud` 领域核、`xharness-cloud-app` 持久控制与 native 收据适配。
- 原 Host 中立执行门禁、唯一 Goal bootstrap，原 Host-app 的 opt-in Linux 托管组合根。
- 全批 Standalone 预检拒绝回写为未执行 Tool error，允许模型纠正，不静默执行子集。
- 四 VM、专属环境、原生门禁、真实 DeepSeek 实验脚本与离线 guard。
- 设计、TODO、操作手册和 10-01 / 10-02 历史验收报告。

保留最新 master 的 native browser 和 ToolAllowlist 及 executor 校验，不回撤主分支新功能。
没有复制独立 `edit_mode_ab.rs`、旧 JS UI patch、旧生成包、VM 磁盘、seed、SSH key 或认证材料。
10-02 环境选择器文档只是历史实验记录；迁移最新 owned TS 和 Gateway/RuntimeConnection 仍待完成。

本 PR **不是完整云端托管产品**：生产 VM 生命周期/材料与凭据授权、可信崩溃恢复、外部静止/retention 与 Task 终态、鉴权 Gateway/根子 Session 范围和客户端路由未完成。未知能力保持 unknown，不能以改 supported 绕过门禁。
无安装包发布、本机 App 替换、3083 Web 更新、VM 启停或模型服务修改。

## 验收分类

- 本次整合：`cargo fmt --all --check`（只格式检查，无本机 Rust 编译）；架构检查 38 crates / 8 extracted processors、架构 guard 5、VM guard 15、专属 guard 16、native guard 3、Goal guard 6、CI tiering 6 全通过。
- 10-01 / 10-02 历史测试：冻结源码的全仓 1060 passed / 19 ignored、六模块 Clippy 与真实 DeepSeek 7/7，详见当日报告。**不把它们当成本次整合 SHA 的回归结果。**
- 先前 WZU_Server 同步未完成，未执行该次 Rust 编译。私有整合 head `52393d7` 随后的三平台 Rust CI 已通过，详见下面分阶段记录；不把该结果冒充当前公开迁移提交的验证。当前提交重新执行原公开仓库 GitHub CI，仍无本机 Rust 编译。
- GitHub PR 自动执行原有三平台 Rust CI，新加 Ubuntu `cloud-offline-guards`。离线 CI 不创建/启动 VM、不访问厂商模型，不依赖用户私有配置。

## 实时只读核对

10-03 V100 的四个实验 unit 均 inactive/dead，MainPID=0，八个 loopback SSH/Host 端口关闭，四份持久磁盘保留。只读检查没有启动实验 VM。

源码摘要见 `../evidence/cloud-runtime-pr-20261003/source-sha256.json`（当前公开迁移源码的相对路径与 SHA，无配置或凭据）。当前提交的公开 GitHub CI 通过前不合并，产品上线另行验收。

## 首轮 CI 的整合遗漏修复

PR head `649fa88` 的 Linux / Windows / macOS Rust 检查及 GUI macos-host 均报同一 `E0063`：最新主分支 `runtime/tests/observer_tests.rs` 的内部 `DurableTurnFactory` fixture 没有初始化新增 `execution` 字段。是本次移植遗漏，不是四个平台各有一个运行故障。

补齐 fixture，并扩展原 `deployment_policy_fences_host_injected_history_and_goal_tools`：未安装门禁（本机）、Active、inactive 三种状态 × allowlist 限制/无限制两种策略；本机和 Active 保留原工具注入策略，inactive 构建前拒绝。保持原 CI 测试，不跳过或减弱门禁。当前修复的 Rust 结果以新 head CI 为准；本机只有 fmt 与静态 guard。

## 前端回归的异步状态观察修复

head `52393d7` 的三平台 Rust、Tauri Linux、GUI macos-host 和其他合同检查均通过；前端 job 在 WebKit / legacy 的 `test-question-continuation-browser.mjs:57` 失败：deferred 已提交，但正文仍有一个 textarea。

同一测试及 UI 在本次云端移植中没有修改。QuestionFlow 通过 passive effect 在 deferred 属性提交后更新 minimized；Playwright `count()` 不等待该更新，立即读数存在时序竞争。测试改为先等待该 textarea 真正 detached，再保留原零正文断言、8 秒上限及后续草稿、重复通知、审批隔离等检查；没有固定 sleep、增加超时、跳过测试或改变产品折叠行为。

本机原 WebKit / legacy 重复 5 次均通过，说明本机未复现 CI 的调度窗口，不据此否定 CI 失败。修改后 Chromium / WebKit × source / legacy 各 3 次，12 次定向浏览器回归通过。完整 Linux 前端回归仍须以新 head GitHub CI 为准，未全绿不合并。

## 公开迁移边界

恢复公开入口由原仓库 PR #207 处理；云端改动单独提交，原链接、Issue、安装包和更新入口不改。保留 Apache-2.0 和第三方 notices。两个新 crate 的 `publish=false` 只是禁止直接上传 crates.io，不改变其继承的开源许可证。

提交前检查本次变更文本中的厂商密钥、GitHub token、私钥头及带凭据 URL；唯一 URL 命中是继承的 `example.test` 脱敏单元测试，非认证材料。仅推送从公开 master 派生的当前分支，不推送本地归档分支、私有历史、环境文件、VM 磁盘、seed、完整 CI 诊断日志或生成包。
