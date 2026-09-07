# Unix 原生更新验收：证据边界与复现

支持三个原生目标：`linux-x86_64-appimage`、`darwin-aarch64`、`darwin-x86_64`。
不向 deb/rpm 客户端提供 AppImage fallback；不将 ARM 仿真运行算作 Intel 原生验收。

## 两种不同的证据

- **正式 candidate 更新验收**：仅临时 BASE 注入自动驾驶代码，直接调用生产
  `desktop_check_update` / `desktop_download_update` / `desktop_install_update`。
  下载目标是已签名、已生成 receipt 的 **完全未修改 candidate**。
  成功范围固定为 `instrumented-base-to-signed-candidate`，`baseInstrumented: true`。
  它证明当前生产处理链可安装此候选，但**不证明所有历史安装包都配置了正确 feed、公钥或可直接迁移**，
  也不等同于按钮点击的 UI 验收。
- **无正式凭据 rehearsal**：相同真实安装链路，但使用一次性 updater key、macOS ad-hoc 签名。
  `--rehearsal` 永远输出 `nativeUpdateAccepted: false`，不能进入正式 promotion。
  `candidate-native` 只是验签与原生启动 smoke，同样永远为 false。

正式 macOS 路径还必须通过 `codesign --verify --deep --strict`、`spctl --assess`
以及 `xcrun stapler validate`。缺少 Apple Developer ID / notarization 凭据时，
保留正式发布门禁；一次性 key 的 rehearsal 不能替代这些检查。

## Workflow 与 CLI

`.github/workflows/desktop-unix-update-acceptance.yml` 接受 `mode: candidate|rehearsal`。
正式模式下载并核实指定 release run 的不可变候选资产；可复用的 CI 模式仅允许无 secret rehearsal。
所有实际桌面启动必须满足 `GITHUB_ACTIONS=true`、`RUNNER_ENVIRONMENT=github-hosted`
及对应原生 OS/CPU。**不在本机编译 Rust**；所有下述构建由 CI 执行。

```sh
python3 scripts/unix-update-acceptance.py prepare \
  --source "$PWD" --root "$RUNNER_TEMP/unix-update" \
  --platform linux-x86_64-appimage \
  --base-version 0.0.901 --target-version "$CANDIDATE_VERSION" \
  --public-key "$CANDIDATE/release/updater.pub"
```

`prepare` 不执行 Cargo：

1. 新建 mode 0700 的一次性目录，排除 `.git`、`target`、`node_modules`、环境与私钥文件复制源码。
2. 只在复制的 BASE 中注入 `scripts/fixtures/unix-update-driver.rs`，统一 BASE 版本。
3. 生成私有一天有效 CA/localhost leaf，输出 `build-env.json` 与 `rehearsal.json`。
4. BASE 的 `bundle.createUpdaterArtifacts=false`，不需要正式 updater 私钥。
5. BASE 添加已锁定的 reqwest 依赖，并通过 updater `configure_client` **只添加该 CA**。
   保持证书、主机名与更新包签名校验；不更改全局证书/钥匙串。
   这是必要的跨平台处理，因为 macOS 的 reqwest 原生证书验证不能依赖 Linux 的 `SSL_CERT_FILE` 行为。

在 CI 中加载 `build-env.json`，用已分发的 native Host/rg 编译 `root/source/apps/desktop` 中的 BASE。
Linux 使用 AppImage，Mac 使用 `.app`，然后将 BASE `.app` 打包为 `.app.tar.gz`（BASE 不需要 `.sig`）。
候选原件不能被该编译步骤重建或重新签名。

```sh
python3 scripts/unix-update-acceptance.py candidate-update \
  --root "$RUNNER_TEMP/unix-update" \
  --base "$DISPOSABLE_BASE" --candidate "$SIGNED_CANDIDATE" \
  --signature "$SIGNED_CANDIDATE.sig" --public-key "$CANDIDATE/release/updater.pub" \
  --receipt "$CANDIDATE/release/$PLATFORM.receipt.json" \
  --manifest "$CANDIDATE/release/latest.json"
```

仅测试身份运行时显式增加 `--rehearsal`。不可通过删除该参数绕过 Apple 签名与公证检查。
`--timeout` 默认 240 秒，范围为 0–1800 秒（不含 0）；不含构建时间。

## 真正检查的行为

- receipt 的平台、target、包名、size、SHA-256、公钥 key packet digest、签名、版本与 manifest URL 绑定；
  验收来源绑定实际 `git rev-parse HEAD`，而非可前进 control branch 的 dispatch SHA。
- 真实本地 HTTPS 下，503 检查失败不会停止 Host；并发检查仅一个成功。
- 无 available update 时下载、无已验证下载时安装被拒绝；更改签名包字节被生产下载处理器拒绝。
- 未确认安装被拒绝，下载完成前后 Host 仍运行。
- 创建真实 session、中文标题、fixture 模型；记录 journal 字节与 workspace/config/credential sentinel hash。
- 确认后由生产 updater 安装并重启。新候选不含 driver：以其**新 ready 文件**关联正常生产 debug trace，
  确认相同 state dir 的 `host.restore` 恢复 1 个 session、0 个问题。
- Linux 安装文件必须逐字节等于签名 AppImage；Mac 安装树必须与签名 tar 的安全解包树一致，
  包含文件内容、可执行权限与内部符号链接。journal 与用户 fixture hash 必须保持。

## 隔离、清理、产物

- 运行环境使用 allow-list，不继承账号、模型、代理或签名凭据。
  HOME/CFFIXED_USER_HOME、XDG、workspace、state、providers、临时文件均在私有 root 内。
- macOS 使用 `sandbox-exec` 拒绝 root 外的文件写入；若工具不可用或隔离目录不可写则失败，
  不修改 `/Applications`、用户生产 HOME、系统证书或全局钥匙串。
  Python 3.11+ 通过 `process_group=0` 建立同 session 的独立进程组，避免 Darwin 跨 session 的 killpg 权限错误。
- Linux 使用独立 Xvfb 与 D-Bus。显示服务在生产 restart 后继续存活；结束、异常与超时
  均仅清理本次创建的进程组，不按应用名称杀进程。
- 任意失败只生成 `FAIL.json`；清理失败会撤销成功 acceptance。
- `acceptance.json` 是供 promotion 严格验证的紧凑 schema；详细范围、hash 与 replay 来源在
  `evidence.json`。原始日志另行导出；不要上传 root/source、私钥、整个 HOME 或用户数据目录。
- `scripts/test-unix-update-acceptance.py` 是 harness 单元/组件测试，包含真实 HTTPS 与 Minisign
  验证、路径与超时/失败测试；它的通过**不是** native 更新通过。

TLS hook 的上游 API：[Tauri updater configure_client](https://docs.rs/tauri-plugin-updater/2.11.0/tauri_plugin_updater/struct.UpdaterBuilder.html#method.configure_client)、
[reqwest tls_certs_merge](https://docs.rs/reqwest/latest/reqwest/struct.ClientBuilder.html#method.tls_certs_merge)。
