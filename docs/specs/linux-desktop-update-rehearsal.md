# Linux 桌面更新演练

## 范围与边界

- 使用 `scripts/linux-update-rehearsal.py` 与 `scripts/fixtures/linux-update-driver.rs`。
- 只允许在 Linux 执行；在 `dist/linux-update-rehearsal-时间戳/` 下创建独立源码、配置、工作区、状态目录和临时签名密钥。不能对真实用户的软件、模型任务或配置运行测试。
- 在临时源码中注入自动驾驶入口，直接调用现有 `desktop_check_update` / `desktop_download_update` / `desktop_install_update`，复用 `sidecar::start` / `graceful_stop` 和真正的 Tauri Updater；正式源码不增加绕过确认的测试入口。
- 构建 0.0.901 和 0.0.902 两个真实 AppImage，由 HTTPS localhost 服务提供更新元数据和签名包。临时 CA 只通过测试进程 `SSL_CERT_FILE` 注入，不关闭 TLS 验证、不导入系统证书库。
- 使用 Xvfb 运行原生应用，安装后执行真实 `app.restart()`；验证磁盘文件 SHA-256 与目标包一致。
- 这是原生更新后端端到端测试，不代替真实鼠标点击、不同发行版桌面环境、`.deb` / `.rpm` 提权安装及正式 GitHub 更新通道的验收。

## 验收项

1. 旧版 Host 启动，并通过真实 HTTP RPC 创建持久会话。
2. 更新元数据 HTTP 503 时检查失败，但 Host 继续运行。
3. 并发检查只允许一个更新操作。
4. 未下载完整包时拒绝安装。
5. 下载内容被修改时签名验证失败，不能停止 Host 或安装。
6. 正常下载验签后进入 `downloaded`，不自动停止 Host。
7. 未确认停止任务时拒绝安装，已验证包保持可用。
8. 明确确认后停止 Host、替换 AppImage、重启到 0.0.902。
9. 新 Host 恢复原会话；配置、状态与工作区哨兵文件保持原内容。
10. 新版本检查同一个更新源时返回 `up-to-date`。

## 运行

先按仓库规则 rsync 当前源码到 WZU_Server 的 `~/codex-build/x-harness-rs/`，排除 `.git/`、`target/`、`node_modules/`、根目录 `dist/`、环境文件与密钥。**必须保留 `ui/dist/`，不能因为排除根目录产物而一起排除静态 UI。**

以下命令只在远程 Linux 执行：

```sh
cd ~/codex-build/x-harness-rs
export PATH="$HOME/.cargo/bin:$PATH"
python3 -u scripts/linux-update-rehearsal.py
```

依赖：Python 3、Node.js、Rust、Tauri Linux 构建依赖、OpenSSL、ripgrep、Xvfb、dbus-run-session、可用的 AppImage/FUSE 环境。CLI 固定 2.11.4，下载 npm 官方包并验证 SHA-512，不运行 npm 安装脚本。

结果保存在演练目录 `events.jsonl`、`app.log`、`result.json`。目录权限 0700；不要上传包含临时密钥的整个目录。测试产物只连接临时 localhost 更新源，不应发给真实用户。

## 平台能力澄清

当前锁定的 `tauri-plugin-updater 2.11.0` 源码已有 AppImage、Deb、RPM 安装分支，Deb/RPM 会尝试提权调用包管理器。因此“Linux Updater 只能支持 AppImage”不是这个版本的准确描述；但代码存在不代表本产品已经完成对应发行版、签名发布和提权交互验收。

## 2026-09-07 验收结果

在 WZU_Server 上，使用真实签名 AppImage，0.0.901 → 0.0.902 **连续 3 次通过**。每轮都验证目标文件 SHA-256、重启后的版本号、持久会话恢复及数据哨兵；503、并发检查、篡改包、未下载/未确认安装均按预期处理。原有生产服务未替换。

本机证据：`dist/linux-update-acceptance-20260907/result-run-{1,2,3}.json`。既有回归：远程桌面 Rust 13 项、前端更新器 14 项、发布检查 3 项、签名正反例全部通过。

环境与测试夹具修正（不伪装成产品修复）：

- GitHub 构建依赖下载超时：从官方地址经 Tokyo_Server 中转到构建缓存，未更换系统网络配置。
- linuxdeploy 扫描 PATH 遇到系统受限链接：使用测试目录中的可访问工具链接视图，不修改原系统链接/权限。
- 缺少 libfuse2：使用 AppImage 官方支持的 `APPIMAGE_EXTRACT_AND_RUN=1`。因此本次不覆盖 FUSE 挂载启动方式。
- AppRun 注入 PYTHONHOME/PYTHONPATH 导致测试 RPC 辅助 Python 找不到 encodings：仅为测试辅助程序启用 `python3 -E`。不能据此认定生产 Coding Tool 一定失败或已经修复；生产 ProcessManager 有独立环境构建，另需覆盖实际工具链。
- TLS 夹具必须由临时 CA 签发独立服务端叶子证书，不能把 CA 证书直接当服务端证书。
- Xvfb/DBus 的生命周期必须长于旧应用进程，才能验证真正的应用重启；否则是夹具提前关闭显示服务，不是更新器安装失败。

已有包可在同一台远程机器重复执行（测试证书仅有效一天）：

```sh
python3 scripts/linux-update-rehearsal.py --run-existing /绝对路径/dist/linux-update-rehearsal-时间戳
```

未覆盖：真实桌面鼠标点击、GitHub 正式更新通道、跨发行版/架构、`.deb` / `.rpm` 提权、安装中断电、磁盘满、回滚和长时间运行任务的升级恢复。
