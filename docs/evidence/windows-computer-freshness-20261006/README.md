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
- Windows 的真实 65 秒等待/变化拒绝实验入口已实现并编译检查，**尚未运行**。改版 Qwen 行为对照也尚未运行。
- 本机软件/用户 VM/模型服务未重启、替换或发布；没有因本轮验收调用 DeepSeek。
