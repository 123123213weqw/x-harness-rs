# Read 契约修复：V100 回归与 12 次真实编程对照

## 结论

已修复负数分页参数静默默认的真实 bug，并完成字段契约与授权范围内绝对路径只读兼容。旧 `limit` 仍是 UTF-8 字节、`line_limit` 仍是行数；分页实现、返回结构、默认限制、原始内容、历史及缓存策略不改。本报告记录原型验收，随后将生产修复与新增测试单独整理为 PR；**没有部署或替换软件**。

V100 确定性回归 **46 个独立测试通过**（新增 11 个）；旧实现运行相同新增测试为 8 通过／3 失败。真实 DeepSeek 12 次编程对照均完整验收通过；`read` 失败从 2/19 到 0/19。但样本小、任务间有退化，**不能称为稳定泛化提速**。

## 实现

- `crates/xharness-coding-tools/src/lib.rs`：read 每字段说明单位、范围、互斥与合法示例；保留旧字段语义。专用严格 u64 解析拒绝负数／不可表示整数，而非假装参数未传。冲突错误给出合法参数组合。
- `crates/xharness-platform/src/lib.rs`：restricted read 接受 canonical workspace 根下组件匹配的绝对路径，转为既有 FsService 能力；仍由 hardened/no-follow 打开检查，不先 canonicalize 用户路径再 reopen。workspace 外、前缀伪装、父路径、symlink 逃逸均拒绝；附件只读根及 Full access 保持既有行为。
- mutation 的 `resolve_file`、write/edit 权限与既有接口**没有改动**。read 返回的工作区路径仍与相对读取一致，记录同一个版本能力。
- 不新增工具、不新增运行时模式、不改变工具输出裁剪／archive／history，也不把此修改包装成 Token 压缩优化。

## 反证与回归

旧源码在独立服务器目录运行同一套新增测试，三个失败：

1. 字段没有 description/range 注解（契约改进，并非底层读错）。
2. 工作区内合法绝对路径被拒绝（只读兼容改进）。
3. **`offset=-1` 返回成功，实际上读了 offset=0 的正文**（真实参数处理 bug）。

修复版新增 11 项均通过：授权路径与相对路径输出完全一致、mutation 契约不变、越界/组件前缀/父路径拒绝、Unix symlink 文件及目录拒绝、非法数字/overflow 不静默默认、字节/行语义不变、4 字节中文/emoji 页完整重建、40,000 字节长行完整续读、缺失/空/EOF 区分、互斥/stale cursor、取消、字段描述。

coding-tools 5+7+11、fs 16、platform 1+6，共 **46 项**；新增 11 项单独又跑了一遍，不重复计数。4 个需要 live endpoint 的既有测试默认 ignored；本轮实模型验收另列。三 crate 全目标 Clippy、实际 model_view_eval example Clippy/build 通过（原型实验工作区，不代表后续 PR 基线或 CI 的验收）。本机只做 fmt/Python，没有本机 Rust 编译。**没有执行 Windows/macOS 实机回归**，Unix symlink 用例不冒充 Windows reparse-point 验证。

## 实验协议与质量

V100，DeepSeek Flash，thinking enabled/low，三个先前已经测试过的公开仓库任务（Boltons strict chunk、JSON5 sortKeys、stable stringify bigint）。每任务两对，A/B 与 B/A 平衡，6 对／12 次。**这是开发对照，不是新盲测。**

复用此前冻结的原版二进制与同 example 重建修复版，两者 mode=baseline，不启用上一轮 lossless wrapper。一样的 7 个原生/Host tools、sandbox、输出/步骤预算；每个请求验证其它工具定义原样，仅 read 描述/Schema 改动。最多 12 次任务或 200,000 未缓存输入；实用 **126,182 未缓存输入 Token**、**57,074 输出 Token**，203 个带 usage 的生成请求（不是只有 12 个 API 请求），未继续追加消费。reasoning usage 另报 38,329，不与 output 再简单相加计费。

本阶段明确发送允许修改文件和现有测试命令；派生 nyc/esm 缓存不当作改源码，依赖源码仍比较。三个正确控制均通过独立功能/原套件/新自测/范围，原始源码均被新功能门禁拒绝；既有阶段成绩不回写。

两臂均为 Completed 6/6，独立功能、原套件、自测、范围各 6/6；无 approvals 失败、旧前缀改写和 archive 回读。

| 单次任务均值 | 原版 A | 修复 B | B 变化 |
|---|---:|---:|---:|
| 耗时 | 47.38 s | 37.53 s | −20.80% |
| 未缓存输入 | 11,265.17 | 9,765.17 | −13.32% |
| 累计输入含缓存 | 242,283.83 | 167,439.83 | −30.89% |
| 带 usage 请求数 | 18.50 | 15.33 | −17.12% |
| 工具失败总数 | 2.00 | 1.67 | −16.67% |

| Read 观察（六次总数） | A | B |
|---|---:|---:|
| read 调用 | 19 | 19 |
| read 失败 | 2 | 0 |
| 显式 line_limit | 3 | 8 |
| start_line + 不超过 400 字节的 limit | 3 | 0 |
| 相同参数重复 read | 2 | 1 |
| read 成功正文 UTF-8 字节 | 21,356 | 30,614 |
| Bash 含 cat/sed/head/tail 的命令条数 | 47 | 32 |

小字节页本身合法，不将 A 的 3 次直接判作理解错误。B 读取正文更多，**没有通过削掉内容取得这些均值**。Shell 项仅是命令字符串命中，不是精确底层操作次数。

A 两次 read 失败均在 bigint 第二对，使用真实工作区内绝对路径；**B 本轮没有自然调用绝对路径**，因此不能说 live 对照已直接证明绝对路径兼容是消除失败的唯一原因。兼容的执行正确性由确定性测试验证；描述、参数选择与总体工作流变化不可单独归因。

## 为什么不宣称稳定性能收益

- bigint 平均耗时 −54.50%、未缓存 −32.95%，是均值的主要收益来源。
- chunk 耗时 −11.94%，但未缓存 **+13.12%**、累计输入 +0.76%。
- sort 耗时 **+20.83%**，未缓存 −10.94%、累计输入 +2.85%。
- 6 对中仅 2 对时间和未缓存同时不回退。paired bootstrap 90% 收益区间：耗时 [−10.95%, +44.77%]、未缓存 [−6.08%, +29.49%]、累计输入 [−8.53%, +59.22%]，均包含退化。
- 每任务仅两对、一个模型、旧任务；Shared schema/system prefix 的暖缓存及模型随机性可能影响成本/时间。组合修复不是单字段因果实验。

因此，可以说确定性 correctness 修复已通过、真实模型更容易正确按行使用的迹象较好；不能承诺所有编程任务更快、更便宜。

## 源码与设施完整性

- A 二进制 SHA256 `0394b1202b760c874803382e968b074dbc828c79b49af28e4e423c6bc8d8d496`；B `411046060c0d87b5957bd102ca3857a83a0ab585c25be210e1f30e2eb8c84096`。原型与过去冻结源码仅两个生产 Rust 文件不同。
- 本机运行前保存 437 项源码 hash；付费运行后，原冻结文件未改，服务器实际源码 437 项与本机完全相同。
- **设施缺陷保留**：v1 runner 按完整路径排除 `.verification`，导致原 protocol 的 source manifest 为空。不能说事前已经双端 manifest 验证；事后实际核对不覆盖原记录。v2 只排除仓库相对路径，空 manifest 调 API 前直接阻止，补两个回归测试。原 protocol 不追改。
- preflight v1 的部分控制日志共用路径会覆盖；v2 分任务保存验收日志，零 API 重新验证正确控制，旧模型运行结果不改。
- 本机/服务器 Python 7+3+9 共 19 项通过，分析相同结果；完整原始 journal、参数、usage、模型产物和失败、源码 manifest、二进制 hash 都保留。密钥只通过 stdin，不放进 argv/environment/任务工作区。

私有证据目录：`/Users/wangyue/codex-build/read-contract-ab-20261003/`。规范见 `docs/specs/read-contract-ab.md`。

## 独立 PR 基线回归

生产修复重新应用到 master `d705aa6cef998d50f386dd923e4f9c3d1d902ee1`，不携带 Context/Core 工具输出策略或实验 example。将该干净工作树（含修改）同步到 V100 后，再次执行 `cargo test --locked -p xharness-coding-tools -p xharness-platform -p xharness-fs`：46 项通过，4 项 live endpoint 测试 ignored；三 crate 全目标 `cargo clippy --locked -p xharness-coding-tools -p xharness-platform -p xharness-fs --all-targets -- -D warnings` 通过；三份修改的 Rust 源码与服务器 SHA256 完全相同。本机 `cargo fmt --all -- --check`、`git diff --check` 通过。完整输出保存在私有证据目录的 `clean-pr-regression.log`。这次运行没有付费 API 请求，也没有替换应用；GitHub CI 状态以 PR 检查为准。
