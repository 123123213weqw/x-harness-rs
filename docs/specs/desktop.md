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
4. Provider Secret 仍只通过 Host 已有的环境变量引用，不得进入 Tauri 配置、安装包、
   更新清单或前端 Storage。

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
3. 同一进程最多允许一个 Check/Install；重复点击返回结构化 Busy 错误。
4. 下载完成后必须先验证签名，再安全停止 Host，最后安装和重启。
   如果安装器在 Host 停止后失败，桌面壳必须尝试恢复当前版本 Host，不能留下一个仍打开但
   完全不可用的 UI。
5. 可选更新器不能进入 DeepSeek Client Module 依赖图；即使更新脚本损坏，Conversation
   UI 仍必须正常启动。
6. Release 清单、安装包、签名和版本必须由同一个 Tag 构建；禁止更新到未签名 URL。

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
