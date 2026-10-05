# Engine 公开插件分发

## 边界

- 源：公开的 `123123213weqw/xharness-plugin-registry` 主分支，只导出目录引用的 ZIP／安全 SVG。不导出仓库其他文件，不执行包中的脚本，不触碰私有插件仓库。
- 目标：`https://engine.xxdevs.com/plugins/catalog.json` 与同根的不可变 `packages/`、内容寻址 `icons/`。不写 `downloads/`、`updates/`，不修改 XS 配置或重启服务。
- 安装程序与插件同步是两条独立链路。更新服务器目录不会偷偷安装／启用插件，也不会改变正在运行的 Tool 快照。

## 准备与验证

```sh
git clone https://github.com/123123213weqw/xharness-plugin-registry.git public-registry
python3 -B scripts/test-plugin-distribution.py
python3 scripts/plugin-distribution.py prepare --registry public-registry --output plugin-export
python3 scripts/plugin-distribution.py bundle --export plugin-export --output plugin-upload.tar
```

导出清单绑定源提交、每个文件的长度和 SHA-256。接收端再次验证，限制归档总大小、文件数和解压大小，拒绝链接、路径穿越、额外文件及主动 SVG。既有同版本包若字节不同，整批拒绝，旧目录不切换。

发布先复制不可变文件，最后 `fsync` ＋原子替换目录 JSON。并发发布经文件锁串行；中断后重试不会重复执行程序。旧目录备份、收据与暂存位于私有控制目录，公开根不放诊断、密钥或暂存清单。

## SSH 权限与 GitHub Actions

使用独立 ed25519 密钥；私钥仅存维护者本机与 GitHub Secret，不写仓库、命令参数或聊天。SSH host key 从既有已验证的 known_hosts 提取；不动态 `ssh-keyscan`、不关闭主机校验。

- `XHARNESS_PLUGIN_PUBLISH_SSH_KEY`：插件发布专用私钥。
- `XHARNESS_PLUGIN_PUBLISH_KNOWN_HOSTS`：已验证的服务器 host key。
- Engine `authorized_keys` 使用 `restrict,command="…plugin-distribution.py receive …"`，只接受 `publish-plugins v1 <manifest_sha> <archive_sha>`。无 Shell、PTY、agent／X11／端口转发权限。
- 若使用 WZU 跳板，同一密钥仅运行 `plugin-publish-relay.py`，接受 `forward-engine-plugins v1`，固定转发到 Engine SSH，30 秒闲置／180 秒总时限。**仍保留 `restrict`，不启用 OpenSSH 转发权限**，避免放开其他 TCP 或 Unix socket。跳板不保存发布私钥。
- WZU 的当前地址为 Tailscale 内网；GitHub 托管 runner 不天然具有此网络。配置 SSH 权限不等于已建立 runner 网络路由：必须先在 runner 验证直连或另行配置受限网络身份，禁止自动关闭 host key 检查、增加广泛端口转发或改模型服务绕过。

2026-10-04 的托管 runner 只读探针已实际收到了 Engine SSH banner。因此 CI 默认使用 `direct`，不额外授予内网访问权；本机的受限 WZU relay 已通过真实两跳发布与重放验证，留作备用。`XHARNESS_PLUGIN_PUBLISH_ROUTE=bastion` 仅在 runner 已有受控网络路由时启用，不能拿 Tailscale 私网地址当公网入口。

工作流 `sync-plugin-distribution.yml` 每半小时同步已公开的目录，支持手动 dry-run。只有部署到默认主分支后定时触发才生效。PR 的独立发布契约 job 不读取密钥，不执行发布；只读探针记录 GitHub runner 到 Engine 的 SSH 握手能力。

## 验收与恢复

```sh
python3 scripts/plugin-distribution.py smoke --export plugin-export
```

逐个验证全部目录、ZIP 和图标的 HTTP 200、字节数、SHA-256；不会只检查首页。哈希失败、不可变版本冲突、receiver 拒绝或连接失败均让发布失败，不推空目录。恢复可以重新发送已验证的旧导出包，先复核不可变库存，再原子切换旧目录；不删除聊天或覆盖软件安装包。

Rust 实际安装验收须在远端、使用临时状态目录：

```sh
cargo test --locked -p xharness-host-app --lib live_product_engine_package_transport -- --ignored --nocapture
```

该测试使用生产组成函数及注入的共享传输，下载 GitHub 插件并验证 Skill 能读取，不执行 Skill 内容、不读取 GitHub 登录凭据、不改现有软件状态。安装／启用是两步，安装 GitHub Skill 不代表已完成 GitHub OAuth。
