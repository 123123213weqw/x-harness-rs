# 前端 CI 并行分片与同轮构建复用

## 为什么改

2026-10-06 检查成功运行：#238 的 `37394602691` 中，原 `Harness layout / Chromium + WebKit` 单 job 用时 84m46s；构建／源码契约 18m49s、浏览器差分 28m24s、布局 20m15s，其余串行步骤约 17 分钟。#237 的同一 job 为 68m57s。Rust 并非这条串行长链路的主因，现有 Rust 缓存不删除、不重做。

目标是缩短 PR 的**墙钟等待**，不是删测试、降低像素断言或承诺 CI 计费分钟减少。首次空缓存、Runner 排队及原生 Rust 仍影响总时长；最终加速比例必须以新提交的 GitHub 实测为准。

## 新链路

```text
                    ┌→ 4 个契约分片 ─────────────┐
锁定依赖 → UI 构建 ─┤                           ├→ 原必需状态检查
                    └→ 2 引擎 × 4 浏览器分片 ───┤   Harness layout / Chromium + WebKit
已提交 UI → 严格像素 → 本轮重建 → 严格像素 ──────┘
```

- `ui-build` 保留 strict TypeScript、Plugin API、构建前一致性检查、实际构建、图标检查和构建后一致性检查的顺序。任一步失败立即停止，不能先重建再把旧生成物错误掩盖掉。
- `ui-contracts` 四分片；`ui-browser` Chromium／WebKit 各四分片。不同 runner 独立 checkout；每个分片内的测试仍用独立进程顺序执行，不在同一个源码目录并发跑会修改 fixture 的测试。
- `ui-parity` 独立检查已提交产物，随后重建并再检验。它不下载构建产物覆盖原来的待检查内容。
- `context-layout` 保留旧的 job ID／required-check 名称。用 `always()` 读取全部依赖，只认可 `success`；失败、跳过、取消、缺失依赖都不能通过。
- 原 Rust／桌面原生／发布作业及 PR 与 master 的分层保持不变。

## 测试清单及无减覆盖证明

`/scripts/ci/ui-plan.json` 是当前执行清单，基线提交 `bd14d189` 的全部 **290 次命令调用**保留：6 次构建、83 次契约、197 次浏览器、4 次严格像素调用。这不是 290 个测试用例；一条命令可以包含多个 Node 测试和多个浏览器场景。

- 保留所有 argv、环境变量、source／legacy、两引擎、缺原生锚点分支，**包括原有重复调用**；本轮不靠推测默认参数相同来去重。
- `/scripts/ci/ui-baseline.json` 是冻结的原始 argv／env 多重集。回归检查每种调用的次数不能减少，实际工作流分片必须恰好执行清单中的每个 ID 一次。
- 静态权重只用于确定性 LPT 平衡，不冒充精确耗时。先将较重命令分散，执行时保留分片内的清单顺序。下一轮用真实逐项计时调整权重。
- 加新测试：在 plan 添加唯一 ID、suite、argv、env、weight；浏览器必须显式选择引擎及需要的实现。新的记录会自动被分片执行。**不要在 workflow 写一个新的长循环，不要删旧基线来过检查。** 新 PR 从旧 workflow 迁移时也必须把新增测试补进 plan。

## 缓存与构建复用边界

1. `setup-node` 缓存 npm 下载；源码工具链仍每次 `npm ci --ignore-scripts`。
2. Playwright／React 也使用独立的锁文件，不再每个 runner 临时解析浮动传递依赖。锁文件固定 Playwright 1.61.1、React／ReactDOM 18.3.1。
3. 浏览器二进制缓存键包含 OS、引擎、完整锁文件 Hash；新 runner 每次仍安装必要 Linux 系统库。
4. 构建产物只取**本次 workflow**上传的 `ui-build-${github.sha}`，不找上次运行、master 或其他 PR 的产物。下载后核对完整 checkout SHA、plan Hash 及生成目录的每个文件 Hash；新增、缺失、变更和 symlink 都拒绝。
5. **不缓存 TypeScript 检查结果，不跳过源码／产物一致性检查**，不缓存失败，不更改生产构建器。因此源码／Vendor／类型策略负向测试仍真实执行。

## 执行与诊断

```bash
node --test scripts/test-ci-ui-suite.mjs
python3 -B scripts/test-ci-tiering.py
node scripts/ci-ui-suite.mjs --suite contract --shard 0 --shards 4 --list
node scripts/ci-ui-suite.mjs --suite browser --browser webkit --shard 2 --shards 4
```

普通测试失败继续收集同分片其他独立失败，但最终非零退出；构建失败不继续“修复”生成物。真实退出码不能由 `tail` 或 shell 管道覆盖。单命令默认 20 分钟超时；job 有额外上限。取消／超时终止该测试的进程组和后代，保存已完成检查点，不执行后续命令。

逐项耗时、退出码、信号、超时和取消状态写入 `dist/ci-ui-timings/`，持续原子保存；job summary 展示表格。每个分片用唯一 artifact 名保存计时和 `dist/` 证据，失败也上传。旧平台像素／工作区目录／审批截图并未删掉，只是分散到各分片 artifact。

## 验收边界

本机只运行 Node／Python／浏览器，禁止本机 Rust 编译。本轮没有修改产品逻辑、安装版本或运行中的 Host。全量跨平台 CI 与真实时长验收见对应 PR；尚未全部通过前不能说已完成全绿或达到指定分钟数。
