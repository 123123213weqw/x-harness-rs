# Windows Computer Use：取消时间型观察过期（2026-10-06）

## 变更

- 移除 Host adapter 的 `FRAME_TTL=30s` 及 `captured` 计时门禁。模型/传输耗时不再直接使观察失效；没有换成另一个固定有效期。
- 把原有观察引用绑定提取到私有、可离线测试的 `state.rs`。输入仍需要当前 driver 的观察；显式旧/外来 frame_id、非当前 node_id/surface_id 仍拒绝。保留 frame_id 可选的现有 Windows 契约，不增加模型工具/参数或 RPC 字段。
- 原生 worker 的屏幕布局、前台窗口身份、指针操作窗口几何、UIA Runtime ID/进程身份、控件可见/可用校验均未删除。
- 原生 dispatch 消耗旧观察的规则不变。`outcome_unknown` 不自动重放；取消/Job/输入释放/45 秒原生 worker 执行上限不变。worker 执行上限与模型思考耗时不是同一计时区间。
- 没有添加持续截图、完整 UI 树比较、自动重新定位或自动点击重试。已有检查并不能识别同窗口内所有内容变化/遮挡，也不是绝对原子性保证。

## 回归

新增 5 个跨平台可执行引用绑定测试，覆盖各输入动作必须先观察、外来/旧 frame、旧控件/窗口引用、缺失 native frame、无观察的 observe/window-list/wait、当前 native target 的绑定及拒绝前不消费观察。

新 `computer-probe.exe --freshness-acceptance` 是真实 Windows 原生实验入口，仅 `native-acceptance` feature 和指定独立克隆 UUID 可用，不进入日常产品：

1. 观察后真实等待 65 秒，再通过同一 driver/node/frame 输入；用独立 Win32 GetWindowText 验证文本。
2. 观察后实际移动窗口，旧坐标点击必须拒绝；独立按钮命令计数仍为 0。
3. 进入 worker 后旧观察被消耗，不能复用来输入。
4. 观察后实际禁用编辑框，旧 node 操作必须拒绝且文本不变。

仅写好实验入口不代表已完成真实验收；执行状态见本目录日志及后续记录。未用模型自评代替原生断言，未修改既有 Qwen/DeepSeek A/B 结果。

## 运行

Rust 只在远程编译。源码（含未提交改动）先 rsync 到 WZU_Server `~/codex-build/x-harness-rs/`，排除 .git/target/node_modules/.env/密钥等。

```sh
cargo test --locked -p xharness-computer -p xharness-computer-windows --features xharness-computer-windows/native-acceptance
cargo clippy --locked -p xharness-computer-windows --all-targets --features native-acceptance -- -D warnings
cargo check --locked --target x86_64-pc-windows-msvc -p xharness-computer-windows --all-targets --features native-acceptance
cargo clippy --locked --target x86_64-pc-windows-msvc -p xharness-computer-windows --all-targets --features native-acceptance -- -D warnings
```

Windows check 是编译检查，不能声称执行了 Windows unit tests 或原生实验。交互式克隆拿到匹配源码的构建产物后，设置 `XHARNESS_DISPOSABLE_COMPUTER_VM=66b64058-bdcc-43e9-85ee-55a79fe2e875`，单独运行 `--freshness-acceptance`，避免在实验期间人工操作其桌面。

## 本轮实际验证结果

- WZU_Server Linux：26 项单元测试通过（其中新增 5 项引用绑定测试）；严格 Clippy 通过。
- WZU_Server 交叉编译检查：Windows MSVC target 的 all-targets + native-acceptance check 与严格 Clippy 通过；这不是 Windows 上执行测试。
- 远程与本地参与测试源码哈希逐项一致，见 `source-SHA256SUMS`。完整最终 Cargo 输出已回传到 `logs/`。
- Windows 原生 16 项回归 + 4 项 freshness 实验已在独立克隆真实执行并全部通过；观察后等待 65.004 秒仍可输入，变化/消费/禁用目标仍拒绝。改版 Qwen 任务对照仍在推进。
- 本机软件/用户 VM/模型服务未重启、替换或发布；没有因本轮验收调用 DeepSeek。

## 2026-10-06 早期实机验收尝试（历史记录，不是当前结论）

- 用户明确批准仅推送现有测试分支构建，未批准合并或发布。本次提交 `9837341741632e5a6ebd83e3169573abb9f40698` 已推送。
- [Windows CI 37461478729](https://github.com/123123213weqw/x-harness-rs/actions/runs/37461478729) 通过；Native job 用时 5m41s。可执行文件 provenance 与提交匹配，SHA256 `95e09749e205b788954e11f2c6d058aa98f8726b87af5fa903880b2a9f5abd19`；PE 导入审计未发现外部 MSVC Runtime 依赖。
- 在独立克隆的 noVNC 控制台尝试启动实验时发生严重 SSH 链路重传/延迟；HTTP 读取也出现 10 秒超时。只读 TCP 诊断观察到数秒 RTT、十几秒 RTO 与大量累计重传。这是本次验收基础设施阻塞，不是已证明产品工具失败。
- 关闭临时浏览器后从服务器本地读取 collector：latest 为 `{}`，不存在 `browser-results.jsonl`。因此新版 Windows 原生套件和 Qwen 重测均不得标记为已执行/通过。详见 `runtime-test-status.json`。
- 持久化 stop job 后仅终止本轮 collector；关闭本轮独立 SSH tunnel。不修改/重启原机、用户软件或模型服务。不调用新 Qwen 推理或 DeepSeek，不合并、不发布。链路恢复后从原生套件开始，不能跳过它直接宣称模型对照成功。

## 更新：原生实机门禁已通过

同一 `9837341` 源码 / 已核验构建产物在 UUID 隔离的 Windows 克隆真实执行，原生 16 项及新增 4 项均通过，重复运行也通过。原始 JSON 断言和 suite exit=0 收据见 `native-acceptance-records.json`、`native-suite-receipts.json`。

模型对照尚未完成。两次启动前置检查分别观察到非浏览器前台与 `desktop_unavailable`，都在 Qwen 请求之前停止，不能算模型任务失败或通过。实验启动的临时 console/前台切换需与工具实际缺陷区分。为避免网络拖慢模型实验，控制器与模型服务放在服务器同机；因此与旧结果不是严格仅改变 TTL 的因果 A/B，必须记录传输和启动条件差异。输入操作不因超时自动重放。

### Additional repeat failure (preserved, not averaged away)

A later independent attempt again passed the 16 original regressions, but `--freshness-acceptance` exited 1 with `missing expected fixture control` before any freshness assertion or model request. Its controller rejected model admission. The first two 20-case passes remain valid observations, but repeated execution is not yet uniformly stable. Whether the missing role reflects fixture foreground/startup timing or a real UIA read defect remains unconfirmed; no runtime check has been weakened to get green.

## Completed Qwen execution, NOT complete controlled acceptance

Runtime artifact/source remain `9837341`. The successful admission repeat passed 16+4 native assertions (real wait 65.015s). Qwen performed two bounded tasks without human intervention: filter 10 model responses / 9 successful tool calls / 451.263s; scroll-detail 6 responses / 5 successful calls / 168.131s. The native bridge exited (`probe_alive=false`, 22 operations including setup). No DeepSeek calls, merge, release or installed-app replacement.

Independent original oracle **does not pass either complete trial**; see `qwen-quality-report.json`:

- Filter answered the expected names/prices, but its events file contained only initial events. The last tool screenshot actually shows **18103**, not this attempt's 18106. Matching filter/sort/select/compare effects were recovered in the old 18103 collector during this trial's time window (`logs/fixture-scope-diagnostic.log`). That corroborates real actions, but cannot be relabelled as a primary controlled 18106 pass. Many old lab windows had identical titles; title-only preflight and background initial events were insufficient to prove active trial identity. Root cause of the foreground switch is not yet isolated; no product/runtime defect is asserted from this trace alone.
- Scroll-detail has independently recorded scroll, `navigate_detail(other-779)`, then return, no search or cart effect. Answer facts are correct. Its final message contains introductory prose followed by unfenced JSON, rejected by the **unchanged original parser**. A separately labelled, post-hoc unique-object extraction passes semantic checks; this is not a retroactive primary pass or a promise of strict JSON compliance.
- The 808-product fixture deliberately positions Accessory 779 at the twelfth list entry for this bounded navigation task. This is a DOM-load/navigation check, not evidence of searching to the end of 800 rows.

Both replies include extra prose; strict JSON-only compliance is false. Prior/current transport and shared-model load/cache also differ, so these are qualitative comparisons, not clean single-factor causal A/B or a reliability percentage. One later native startup repeat failed before the 65s test (`missing expected fixture control`); earlier passes do not erase that failure.

Added `scripts/computer-shopping-lab/fixture_identity.py`: private lab-only foreground-address identity gate. It rejects old port/case, matching background nodes, missing/ambiguous UIA addresses and unknown/failed observations. Nine local stdlib unit tests passed, including the duplicate-title/background-page negative scenario. Next private reset controller invokes a semantic read after Enter and checks expected active origin **before model admission**; no input is automatically retried, no production rules/tools/RPC changed, and the guarded real-model repeat is not yet run.

SSH jitter interrupted full evidence/media transfer. Compact commit/hash-correlated native receipts, oracle reports, scope diagnosis and one complete final screenshot are preserved here; full raw remote trial data remain under `/home/data/wzu/windows-computer-freshness-qwen-repeat-20261006`. Do not claim that every PNG has been locally verified or that all transient services were cleaned without a receipt.
