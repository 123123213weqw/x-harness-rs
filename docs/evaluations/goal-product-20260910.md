# Goal 产品链路真实验收（2026-09-10）

## 与前一次实验的区别

前一次验证纯 Controller + Driver，使用实验 Factory 解析最终 JSON。
本次直接使用**正式 Host RPC、DurableLoopAgentRuntime、NativeToolFactory、动态注册的 goal_report、JSONL Store**；没有实验专用报告适配器，也没有每轮由测试程序插入阶段 System Prompt。

只把三阶段编码要求写入用户的 Goal objective。模型自行使用工具并通过 `goal_report` 报告进展，原 Driver 自动推进。

## 环境与隔离

- 编译、Rust 测试和真实模型执行均在 WZU_Server（V100 主机）；本机没有编译 Rust。
- 调用本机已配置的 `https://api.deepseek.com` / `deepseek-flash`，不是 V100 上运行本地权重。
- API Key 从 macOS Keychain 读取，只经 SSH stdin 传递；没有进入源码、日志或 Session。
- 新建一次性工作区，不使用用户当前会话，不部署、不重启用户现有服务。
- 原生工具在独立工作目录处理 Python 文件；任务不需要网络、外部包、后台进程或仓库操作。

## 真实任务与结果

实现无外部依赖的 CSV 账本：严格列头、日期/金额校验、Decimal 精确聚合、Unicode 分类、CLI、BOM、清晰错误、测试和 README。

| 项目 | 实测 |
| --- | --- |
| Goal 轮数 | 3 |
| 正式工具报告 | progress → progress → complete |
| 工作耗时 | 205,389 ms（约 3 分 25 秒） |
| 工具调用 | 46：bash 20、write 3、edit 19、read 1、goal_report 3 |
| 工具结果 | 46 success；另检查工具内容，未发现 `ok=false` |
| 模型编写测试 | 独立重跑，115 通过 |
| 外部独立验收 | 12 通过 |
| 完成语义 | 模型停在待确认；独立验收后用原 goal.complete RPC 确认 |
| 重复确认 | 同 RPC ID 重放返回成功，不重复执行 |
| JSONL 重读 | complete、轮数 3，恢复通过 |

模型在第三轮找到了大数 Decimal 上下文溢出和 CSV 错误类型泄漏并修正；这些是任务代码的正常迭代，不是 Harness 强制编排出来的固定工具序列。

文件 SHA-256、工具统计和回归结果见同目录 `goal-product-20260910.json`。

## 自动化范围

- 全仓 Linux Rust 测试：554 通过、0 失败、5 忽略；`cargo clippy --workspace --all-targets -- -D warnings` 通过。
- 纯决策、原子队列/claim、报告校验、晚到报告、取消/上限、未知结果恢复、后台依赖、owner 隔离、重启队列单次接管、UI 实时/历史同源。
- 浏览器直接加载分发的 React 和上游 GoalBar/GoalDock。Chromium、WebKit 均验证：确认/继续、错误解锁、切目标旧请求、完成保留、阻塞恢复、旧目标启用、预算编辑、375px 窄屏。
- 准备工具期间暂停 Goal：未启动模型、不增加轮数，Host 已订阅的后台运行状态正常收尾，不残留假运行。
- 未来未知持久记录必须失败关闭，并验证文件未被截断或覆盖。

## 复现

先按仓库 AGENTS.md 同步源码到远程，再执行：

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p xharness-host-app --example goal_product_eval
# stdin: {base_url, model, api_key}；禁止将凭据加入 shell 参数、日志或仓库
./target/debug/examples/goal_product_eval /new/isolated/evaluation-root
# 不需要密钥：独立验收通过后，以正式 Host RPC 确认并重读持久状态
./target/debug/examples/goal_product_eval --confirm /new/isolated/evaluation-root
```

浏览器测试由 Node 执行，不涉及本地 Rust 编译：

```sh
UI_TEST_DEPS=/path/to/isolated/deps UI_TEST_BROWSER=chromium node scripts/test-goal-runtime-browser.mjs
UI_TEST_DEPS=/path/to/isolated/deps UI_TEST_BROWSER=webkit node scripts/test-goal-runtime-browser.mjs
```

## 边界

这证明一次真实三轮任务和列出的回归通过，**不是无限运行稳定性证明，也不等价于当前分支 macOS/Windows CI 或安装包升级验收**。没有推送、发布或替换用户当前 App/Web；这些交付动作仍单独列在 TODO。
