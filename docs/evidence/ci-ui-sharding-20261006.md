# CI 前端分片首轮本机验证（2026-10-06）

基线：master `bd14d189633cf25ffe3638ed393d92b63c571532`。变更只涉及 CI、测试执行器、测试清单、锁文件和文档，不修改生产 UI／Rust。没有在 Mac 编译 Rust，也没有升级、重启或替换已安装应用。

## 慢在哪里：真实 GitHub 旧运行

- PR #238，run `37394602691`：原前端 job 从 `2026-10-06T00:33:12Z` 到 `01:57:58Z`，84m46s。
- 其中构建／源码契约 18m49s，源码与 legacy 浏览器差分 28m24s，布局回归 20m15s。
- PR #237，run `37394364301`：同一个前端 job 68m57s。
- 不拿失败后提前退出的 #242 运行当作加速证据。

## 本机通过项（真实执行，不是模拟时长）

- `actionlint .github/workflows/ci.yml`；`git diff --check`。
- 新 Node 回归 14 项：冻结 290 次命令多重集覆盖、所有分片恰好一次、确定性平衡、顺序门禁、真实退出码、失败继续收集、失败构建不得修复、超时、信号取消与后代清理、SHA／plan／完整文件 Hash、文件新增删除、symlink 拒绝和锁文件版本。
- CI 分层 Python 7 项，确认旧 required-check 名称保留且失败／跳过／取消无法变绿。
- UI 构建执行器完整 6 个命令通过，包括 strict types、Plugin API、构建前一致性、实际构建、图标和构建后一致性。生产 `ui/dist/` 与基线相同，没有为 CI 优化更改生成物。
- 完整契约分片 0：18 个命令通过，包含 standalone 干净复制／离线重建／负向修改测试，不绕过真实编译／一致性检查。
- Chromium/source、WebKit/legacy 的工具浏览器回归通过。
- 两引擎的严格平台像素与完整 UI source/legacy differential 通过（两个入口命令包含多个浏览器场景）。
- Python 发布门禁相关回归：desktop-release 7 项、release-orchestrator 36 项、windows-desktop-bundle 7 项、browser-windows-manifest 3 项。

本机 `/usr/bin/python3` 是 Python 3.9；额外 unified-desktop-release 回归因已有代码使用 `Path.write_text(newline=...)` 而报版本不兼容，改用本机 Python 3.11 后 54 项全部通过。GitHub 原契约 job 的 Python 3.12 配置未修改，不为这个本机版本问题改产品代码。

## 本机证据不能代替什么

上述仅证明执行器、覆盖及定向行为。它不证明 GitHub Linux 全量测试已绿，不证明全部 PR CI 已完成，不证明原生启动或安装升级变快。GitHub 的第一次空缓存运行和后续热缓存运行需分别记录；墙钟时间、Runner 排队、测试总计算量和 Rust／桌面原生作业不得混为一谈。

下一步：独立 PR 跑全部 CI；按逐项计时收据分析最慢分片，不删除重复调用或减弱像素断言来制造加速。当前 PR 只提交审核，不自动合并。
