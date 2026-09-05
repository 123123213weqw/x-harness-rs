# Tauri 桌面壳与一键更新规范

## 1. 范围

桌面版必须复用同一套 Rust Host、Web UI、Session 日志、Tool Registry 与 Provider
配置，不得在 Tauri WebView 内重写 Agent Loop。浏览器部署仍由 `xharness-host`
直接提供；桌面版只是负责启动、认证、监督、更新和安装的原生壳。

```text
Tauri WebView
  └─ http://127.0.0.1:<随机端口>/
        └─ xharness-host sidecar
             ├─ Web/API/WS
             ├─ Durable Agent + Loop
             ├─ Tools/Platform/Sandbox
             └─ Session/Control/Debug State
```

## 2. 进程与数据边界

1. 桌面壳必须把 `xharness-host` 和与目标架构一致的 `rg` 作为 Tauri external binary
   打包；Windows 还必须携带 `xharness-windows-sandbox-runner.exe`，否则 restricted execution
   会 fail closed。Host 仍是唯一后端，桌面壳不得代理每个 API 请求。缺失 `rg` 会让 fresh
   install 的 `glob/grep` 第一调用失败，因此不能假设用户系统已经安装。
2. 每次启动必须让 Host 自己绑定 `127.0.0.1:0`，再通过原子 Ready File 返回实际地址；
   禁止桌面壳先占用再释放端口造成 TOCTOU 竞争，Host 也禁止绑定公网地址。
3. Workspace、Session State、Provider Config 和临时 Shutdown 文件必须使用 Tauri
   的系统目录解析，不能依赖启动时 Current Working Directory：
   - Workspace：`app_data_dir/workspace`（可用 `XHARNESS_WORKSPACE` 覆盖）；
   - Session State：`app_data_dir/state`（可用 `XHARNESS_STATE_DIR` 覆盖）；
   - Provider Config：`app_config_dir/providers.json`（可用
     `XHARNESS_PROVIDERS_FILE` 覆盖）；
   - Runtime：`app_cache_dir/runtime`。
4. Provider Secret 由共享 Host 的系统凭据存储或只读环境变量引用解析，不得进入 Tauri
   配置、安装包、更新清单、控制日志或前端 Storage。模型配置通过同一组 Host RPC
   持久化并立即应用；桌面壳不实现另一套设置后端。详见 [模型设置](model-settings.md)。

## 3. Loopback 认证

随机端口不是认证。桌面壳每次启动必须产生 256-bit 随机 Token，只通过 Sidecar
环境变量传入 Host。WebView 首次导航到 `/desktop/bootstrap?token=...`；Host 校验后
设置 `HttpOnly; SameSite=Strict; Path=/` Cookie 并重定向到 `/`。

- `/api/**` 和 WebSocket Upgrade 必须要求 Cookie 或显式
  `x-xharness-desktop-token` Header；
- Host 检测到 Desktop Token 时必须拒绝非 Loopback Bind、少于 32 Byte 或非 URL-safe 的
  Token，不能只依赖 Tauri 调用方“传对参数”；
- `/health/ready` 和静态壳保持公开，但监听器只能绑定 `127.0.0.1`；
- Token 禁止写入日志、URL 之外的前端状态或持久文件；
- 浏览器/服务器模式不提供 Token 时保持既有反向代理认证边界。

## 4. 生命周期

1. 桌面壳启动 Sidecar 后轮询 `/health/ready`，只在返回 200 后把主窗口从启动页
   导航到真实 Web UI。
2. 正常关窗和更新安装必须先创建一次性 Shutdown 文件，触发 Host 已有的结构化
   Shutdown：停止 Admission、保存 Session、取消/收敛 Loop、Tool、Job 和 Process。
3. 最多等待 15 秒；超时后允许桌面壳强制终止 Sidecar，并必须向更新事件投影降级原因。
4. Sidecar 崩溃必须发出 `xharness-host/stopped` 事件，不能让 UI 误报 Host 仍在运行。
5. 启动超时、端口竞争、配置错误和资源缺失必须停掉已启动的 Child，不能遗留孤儿进程。

## 5. 更新契约

桌面更新使用 Tauri v2 Updater。正式发布 CI 必须注入不可变的更新地址和公钥，更新产物
必须使用 Updater 签名；品牌安装包还应使用平台代码签名。所有私钥只存在于 CI Secret。

1. Web UI 只在检测到 Tauri Bridge 且 `updaterConfigured=true` 时显示更新控件；普通
   浏览器部署完全不显示。
2. 自动检查可以提示新版本，但下载/安装必须由用户点击。
3. 同一进程最多允许一个 Check/Download/Install；重复调用返回 Busy 错误；退出与更新
   共用互斥门，退出开始后不能再提交新的更新操作。
4. 下载与安装必须拆开。下载完成且签名验证成功后进入 `downloaded`，不停止 Host。
   用户点击“重启更新”后必须再次确认停止 Agent/Tool/Job，才安全停止 Host、安装和重启。
   如果安装器在 Host 停止后失败，桌面壳必须尝试恢复当前版本 Host，不能留下一个仍打开但
   完全不可用的 UI。
5. 可选更新器不能进入 DeepSeek Client Module 依赖图；即使更新脚本损坏，Conversation
   UI 仍必须正常启动。
6. Release 清单、安装包、签名和版本必须由同一个 Tag 构建；禁止更新到未签名 URL。

### 5.1 左下角更新入口与状态机（0.1.1）

- 左下角常驻低干扰入口，有更新/下载中/待安装时使用蓝色下载图标；正常浏览器与未配置签名源
  的开发构建不显示。检查是静默的，不自动展开面板，失败也不遮挡对话。
- 启动 1.5 秒后检查一次，随后页面可见时每 6 小时检查。Release 文本只作为纯文本渲染。
- `desktop_update_status()`：返回进程级权威快照，含单调 `seq`、`phase`、当前/目标版本、
  说明、下载进度、错误与 `retryAction`。先订阅再读快照，丢弃旧序号，刷新 WebView 不重置状态。
- `desktop_check_update()`：检查新版本；已有已验证下载时直接返回原状态，不替换安装候选。
- `desktop_download_update()`：下载并验证，成功后只进入 `downloaded`。
- `desktop_install_update({confirmStop:true})`：拒绝未下载/未确认的安装；取消确认、按 Escape、
  关闭面板均不调用安装。安装失败尝试重启 Host，保留已验证包，重试前再次确认。
- 下载失败重试下载，检查失败重试检查，安装失败重试安装，不能统一退回重新检查。
- 元数据检查 30 秒超时，下载最多 30 分钟；进度事件最多约 10 次/秒，最终状态不节流。
  传输完成回调不代表签名验证完成，只有插件 `download().await` 成功才能显示可安装。
- 关窗取消正在进行的检查/下载并收敛 Host；安装已开始则等待安装完成，不在文件替换中强退。
- 安装字节暂存当前进程内并与版本描述配对，不落入 Session/Provider 配置。WebView 刷新保留；
  整个应用退出后需重新下载。断点续传、跨进程安装缓存不在此版范围，不能宣称已支持。
- 当前采用**显式确认停止任务**，不声称自动等待所有任务结束；后台命令不保证恢复副作用。

### 5.2 发布和图标门禁

- 推送 master 仅运行 CI，不向用户自动推送每个 Commit；`desktop-v<版本>` Tag 才进入发布。
- Release Workflow 必须先确认同一 Commit 的 master CI 已通过，再构建三平台签名包与
  `latest.json`。产物保持 Draft，完成升级验收后才发布。CI Artifact 不等于正式 Release。
- CI 在 macOS 打包后运行 `scripts/test-desktop-assets.py --app <XHarness.app>`，比较包内 ICNS
  与源码哈希、版本号、更新脚本以及 Host/rg，防止“源码已改、安装包仍旧”的问题。
- 只更新源码/重启 Host 不会替换 `/Applications/XHarness.app`。必须从 CI 获取完整新应用包；
  不直接覆盖已签名应用内部图标，否则会破坏原包签名。对话与配置继续位于 Application Support。
- 2026-09-05：已配置独立的演练 Updater Secrets；正式 Developer ID/公证与生产更新签名
  配置仍未完成。演练 Pre-release 不等于正式签名版本，不替代用户手动升级验收。

CI Secret：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `XHARNESS_UPDATER_PUBKEY`
- macOS：`APPLE_CERTIFICATE`、`APPLE_CERTIFICATE_PASSWORD`、`APPLE_SIGNING_IDENTITY`、
  `APPLE_ID`、`APPLE_PASSWORD`、`APPLE_TEAM_ID`
- Windows 正式品牌发布：代码签名证书相关 Secret（没有证书时 Updater 签名仍能防篡改，
  但 SmartScreen 信誉较差）

## 6. 构建与验收

Rust 禁止在本机编译。Host 与 Desktop 必须在目标系统或 CI 原生编译：

```bash
cargo build --locked --release -p xharness-host-app
python3 scripts/stage-tauri-sidecar.py \
  target/release/xharness-host x86_64-unknown-linux-gnu
python3 scripts/stage-tauri-sidecar.py \
  "$(command -v rg)" x86_64-unknown-linux-gnu --name rg
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
```

Windows x64 使用 `x86_64-pc-windows-msvc`，并在 Tauri build 前额外编译、Stage
`xharness-windows-sandbox-runner.exe`。Pull Request CI 生成关闭 Updater Artifact 的 NSIS
安装包用于验收；Tag Release 才使用 CI Secret 生成签名更新元数据。

最低验收矩阵：

- Host Token：无凭据 401、错误 Token 401、Bootstrap 303 + HttpOnly Cookie、Cookie API 200；
- Shutdown：文件触发与 SIGTERM 走同一结构化收尾；
- Sidecar：随机端口、Readiness、崩溃/超时无孤儿进程；
- Updater：未配置、无更新、有更新、离线、签名失败、并发点击、下载中关窗、Host 强停降级；
- UI：浏览器不出现按钮、桌面出现按钮、进度/错误可重试、主 Client Module 启动不受影响；
- 平台：macOS ARM64、Windows x64、Linux x64 原生安装/升级/回滚验证。

当前实现完成了代码、Token/Shutdown 回归、独立更新 UI，以及 macOS ARM64、Linux x64、
Windows x64 CI 发布骨架。Windows 包同时包含原生 Host、固定版本 ripgrep 与 ACL runner，
不会把只能打开 WebView 的空壳当作 Coding Agent。正式对外发布仍以平台签名安装测试和 Release
Secret 配置完成为门禁；Windows ARM64 与 Authenticode 品牌签名仍是后续项。Updater 签名能验证
更新完整性，但没有 Authenticode 证书的安装器仍可能触发 SmartScreen 信誉警告。

## 7. macOS 手动升级演练通道

`Desktop Update Rehearsal` 是仅手动触发、仅 master 的 macOS ARM64 演练 Workflow。
与正式 `desktop-v*` 发布门禁隔离，不绕过正式 Apple Developer ID/公证要求。

- 输入基础版本/目标版本（如 0.1.1 → 0.1.2），同一提交在原生 GitHub Runner 构建两套包。
- 两套包都内置相同的测试公钥，以及目标测试 Release 的固定 HTTPS manifest URL。
- 使用独立 `XHARNESS_TEST_UPDATER_PRIVATE_KEY`、`XHARNESS_TEST_UPDATER_PASSWORD`、
  `XHARNESS_TEST_UPDATER_PUBKEY` Secrets；不与生产签名密钥混用。
- macOS 应用使用 ad-hoc 代码签名，更新 tar.gz 仍执行 Tauri Updater 签名校验。
  这不是公证版本，不保证其他用户首次下载后能免确认启动。
- CI 必须检查包内品牌/版本、codesign、独立 Ed25519/Minisign payload + trusted-comment
  签名，然后发布 `desktop-test-v<目标版本>` Pre-release；`latest=false`，不污染稳定通道。
- 已发布测试版本不可覆盖；测试时先安装基础包，再由用户点击发现/下载/确认重启。
  没有编译进公钥/更新源的旧开发包不能只靠发布一个 JSON 就自动启用更新。
- 本演练是固定目标版本的通道，未来升级到新测试版本需要显式配置新通道；不能冒充可滚动
  跟踪所有未来测试版的生产自动更新。正式版本仍使用正式 latest 地址。

### 7.1 原生桥接与发布回归（2026-09-05）

- 真实 macOS 基础包验收发现：只有 `core:default` 时，Loopback UI 调用应用命令会得到
  `Command desktop_status not allowed by ACL`。普通浏览器 Mock 不能覆盖此边界。
- `build.rs` 使用 `AppManifest::commands` 生成五个 Desktop 命令权限；`desktop-main`
  为主窗口的 Loopback URL 显式授予这五项权限，不授予任意 Shell 或文件系统插件权限。
- 初始化失败不得静默移除更新入口：保留可展开的错误提示、禁用安装操作，不打断对话。
  JS 回归覆盖 ACL 失败以及 Manifest/Capability 的五项命令配对。
- 编译期 Rust 环境变量与 Tauri Bundler JSON 必须使用同一公钥；否则应用能读到公钥，
  Bundler 仍会因空 `plugins.updater.pubkey` 拒绝签名。CI 测试同时检查三处版本和公钥投影。
- 如果 GitHub `GITHUB_TOKEN` 创建 Release/Tag 返回 403，不能放弃校验或冒充发布成功。
  维护者可先创建指向已审核构建提交的测试 Tag，再重跑发布；或验签后发布同批 CI 产物。
  上传必须保持 Draft，全部产物与清单齐备后才公开；已公开版本不得覆盖。

### 7.2 本机验收记录

- 构建提交：`a6b5d011d73a3efbe97512cbfebd694907a961bc`；CI Run
  [33945463459](https://github.com/123123213weqw/x-harness-rs/actions/runs/33945463459)
  的回归、双版本打包/验签、产物上传和 Pre-release 发布全部成功。
- [desktop-test-v0.1.2](https://github.com/123123213weqw/x-harness-rs/releases/tag/desktop-test-v0.1.2)
  已公开，仅 macOS ARM64 测试通道，不是稳定版。
- 本机 `/Applications/XHarness.app` 已替换为带测试更新源、公钥和显式 IPC 权限的 **0.1.1**。
  使用 CI 原始 tar.gz；本机再次用保管的公钥验签，并验证 codesign、版本、图标和更新脚本。
- 重启前记录的 25 个 Session/Workspace/Provider 文件的原有内容前缀全部保留。
  浏览器 3082 独立服务未重启。
- 真实原生窗口已显示「发现 XHarness 0.1.2」和「下载更新」，不是浏览器 Mock。
  首次清单请求出现网络失败，手动重试成功；没有绕过 TLS 或签名验证。
- **用户尚待验收：** 点击下载、确认停止任务、安装重启后版本变为 0.1.2，以及升级后继续会话。
  准备基础包与发现更新通过，不等于整个用户手动升级流程已经通过。
