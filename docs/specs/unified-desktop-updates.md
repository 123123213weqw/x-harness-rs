# 三平台稳定更新通道规范

> 2026-09-08。本规范区分“代码可用”“CI 验收通过”“正式更新已发布”。
> 三者不能互相替代。当前 Windows 0.2.5 已在原通道发布；Mac/Linux 的正式
> 发布必须满足本规范门禁。Apple 凭据缺失时明确阻断，不退化成 ad-hoc 正式包。

## 1. 支持范围与复用边界

不新增第二套更新器、Agent Loop 或前端。复用 Tauri 原生更新器、已有左下角下载入口、
Host 有序退出、持久会话和 Windows 安装器验收。新增的是统一构建、清单聚合、候选包
验收与正式发布的流水线。

| 系统 | 目标 | 自动更新产物 | 清单键 |
|---|---|---|---|
| Windows x64 | x86_64-pc-windows-msvc | 当前用户 NSIS `.exe` | `windows-x86_64` |
| Linux x64 | x86_64-unknown-linux-gnu | AppImage | `linux-x86_64-appimage` |
| macOS Apple Silicon | aarch64-apple-darwin | `.app.tar.gz` | `darwin-aarch64` |
| macOS Intel | x86_64-apple-darwin | `.app.tar.gz` | `darwin-x86_64` |

Linux 本次**不发布 `.deb/.rpm` 的自动更新包**，也不提供 `linux-x86_64` 通用回退条目。
锁定的 Tauri updater 2.11.0 先匹配包类型，再回退 OS/架构键；若通用键指向 AppImage，
DEB/RPM 客户端会选到错误包。未来支持 DEB/RPM 时必须新增独立键、提权/取消/安装失败
测试与对应发布门禁，不能只把 AppImage URL 复用过去。Linux ARM64 和 Windows ARM64
也不冒充已覆盖。

## 2. 一个稳定入口，一个签名信任链

稳定入口保持：

`https://github.com/123123213weqw/x-harness-rs/releases/latest/download/latest.json`

- 沿用现有 Windows `XHARNESS_FRIENDS_PRIVATE_KEY`、`XHARNESS_FRIENDS_PASSWORD`、
  `XHARNESS_FRIENDS_PUBLIC_KEY`。Secret 名字保留兼容，不代表只给 Windows 用。
- 不生成替代公钥，不轮换旧信任链；密钥与正式通道不匹配必须失败。
- 编译时同时投影版本、同一公钥和同一 HTTPS 更新地址。包内应用标识保持
  `com.xlang.xharness`，禁止更换标识导致数据目录和单实例身份分裂。
- 公钥、签名、SHA256SUMS 可以公开；私钥、Apple 凭据、模型 Key、运行环境文件不能
  出现在构件、收据、日志、Release 或截图中。
- 新正式版本使用 `desktop-vMAJOR.MINOR.PATCH`，须高于所有已发布的 `friends-v*`
  与 `desktop-v*` 稳定版本。版本已存在（包括 Draft）不覆盖，失败后按运维流程处理。
- 首次统一正式版发布后，旧 `friends-v*` Windows-only 发布脚本拒绝继续发布，防止
  下一次 Windows 更新把 Mac/Linux 平台清单删除。未发布的 Desktop Draft 不使现有
  Windows 维护通道提前失效。

## 3. 正式流水线

```text
master 精确提交的最新 CI 成功
             │
     desktop-vX.Y.Z 标签
             │
     版本 / SHA / 签名配置门禁
             │
     四个原生 Runner 并行构建
      ├─ Windows x64
      ├─ Linux x64 AppImage
      ├─ Mac Apple Silicon
      └─ Mac Intel
             │
     独立验签 + 平台构建收据
             │
     单个聚合任务验证四份收据
             │
     完整 latest.json + SHA256SUMS + 不可变候选
             │
       创建完整 Draft（不推送更新）
             │
    Windows / Linux / Mac 原生升级验收
             │
     发布任务重新核对 CI、包、签名、证据、当前通道
             │
       一次发布为 Public Latest
             │
     客户端静默发现 → 用户下载 → 用户确认重启
```

### 构建和清单

矩阵任务只有读取权限，不各自写 Release。每个平台收据包含版本、源 SHA、CI 身份、
构建 Run/Attempt、目标架构、包名、包 SHA-256、签名、公钥指纹、二进制摘要及内嵌更新地址。

聚合器只接收规定的四个平台和公开文件。缺包、多包、同名覆盖、版本混合、构建重跑混合、
外部下载 URL、路径穿越、符号链接、错误密钥、损坏签名、错误架构与意外敏感文件均失败。
`latest.json` 只生成一次，所有平台是同一版本，不靠矩阵任务竞争覆盖文件。

### 验收和发布

- CI 编译成功不等于原生升级成功。候选包必须在一次性 Runner 中被真正安装/启动/更新，
  验收证据绑定候选 SHA、Manifest Hash、Package Hash、构建 Run/Attempt 与验收来源。
- Windows 复用现有 NSIS 实包单跳测试：从当前稳定包升级，损坏包拒绝、未确认不安装、
  Host 恢复、配置/模拟凭据/工作区与 Session Journal 保留。
- Unix 使用隔离基础包驱动生产 `check/download/install`，目标为未修改的正式候选包。
  “基础包带测试驱动”和“正式目标包没有驱动”必须写进证据，不能把两个临时测试包
  的演练冒充正式候选包已升级。仅签名验证或启动 Smoke 不能授权发布。
- macOS 的正式验收额外要求 Developer ID 签名、Gatekeeper 和公证票据校验。
- 原生测试不访问真实模型，不启动生产任务；使用模拟配置与数据哨兵，不碰用户安装目录。
- 发布时重新检查当前通道版本/信任链/平台集合；原通道平台不得减少，不能降级。
  对照 Draft 快照及资产摘要，验收后包被替换也必须拒绝。
- Stable 发布工作流共用并发锁，禁止旧 Windows 发布与统一发布互相踩踏。
- 最后才将完整 Draft 发布成 Latest。检查/下载不强制安装，用户仍需确认停止正在运行的
  Agent、Tool 和 Job。历史消息保留不代表后台副作用任务会自动恢复。

## 4. Mac 从旧测试通道迁移

目前本机 0.1.4 内嵌的是固定 `desktop-test-v0.1.4/latest.json`，不是稳定滚动入口；
地址与公钥是编译期数据。仅修改 Web、仓库配置或发布新 Tag，不能改变已经安装的 App。

首次接入需要安装经过正式验收的新基础包：

1. 确认没有未完成的任务，或明确确认停止；备份应用外的状态目录。
2. 从官方 Release 获取对应架构的完整包，核验包签名及 Apple 信任状态。
3. 退出旧 App；整体替换应用，不修改已经签名的包内部文件。
4. 保持应用标识和数据位置，启动后检查历史、Provider 配置和工作区。
5. 验证客户端内嵌稳定入口和原通道公钥；以后可在左下角按按钮更新。

不修改或覆盖旧固定测试 Release，不伪造旧公钥签名，不全局关闭 Gatekeeper。
本次开发不自动结束本机任务，也不替换 `/Applications/XHarness.app`。

Linux 未配置更新器的旧包同样需要一次新基础包安装。AppImage 应放在当前用户可写位置；
只读目录、权限不足、缺运行依赖要报清晰错误，不能使用提权覆盖其他安装。

## 5. 凭据和正式发布的真实阻塞

当前已配置 Updater 信任链；缺少的 Mac 凭据：

- `APPLE_CERTIFICATE`：Developer ID Application 证书的 P12 Base64；
- `APPLE_CERTIFICATE_PASSWORD`：P12 解密密码；
- `APPLE_SIGNING_IDENTITY`：匹配证书的 Developer ID Application 身份；
- `APPLE_ID`、`APPLE_PASSWORD`（App-specific password）、`APPLE_TEAM_ID`：公证凭据。

通过 GitHub Actions Secrets 配置，不能在对话中粘贴私钥。证书和公证失败时正式构建失败，
不会切换到 `APPLE_SIGNING_IDENTITY=-`。独立临时密钥/ad-hoc 只允许隔离演练，不发正式源。

Tauri 更新包签名不等于 Apple 公证，也不等于 Windows Authenticode。Windows 延续现有
免费更新签名能力；购买发布者证书及 SmartScreen 信誉不是本次已经完成的能力。

## 6. 不夸大保证

- 自动发现更新不等于强制更新，不是每次推 master 都让用户升级。
- 保留会话配置不等于数据库格式可以任意降级；新事件可能无法被旧二进制读取。
- 当前进程下载缓存不是跨重启断点续传；完整数据迁移回滚、断电、磁盘满及跨发行版系统
  提权的专项验收单独跟踪。出现正式发布事故优先停止继续推广、发布修复版；不盲目把
  已升级用户切回旧程序。
- GitHub 管理员可以绕过工作流手动编辑 Release。仓库权限、Tag 保护和环境审核应另行
  设置；不能将源码里的检查当作 GitHub 管理面的绝对防篡改保证。

## 参考

- [Tauri Updater 官方协议](https://v2.tauri.app/plugin/updater/)
- [锁定版本 2.11.0 的包类型匹配](https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.11.0/plugins/updater/src/updater.rs)
- [GitHub 原生 Runner 矩阵](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)

## 7. 维护者操作顺序

1. 合并源码到 `master`，等待该提交的完整 CI（含无 Secret Unix 原生更新演练）成功。
2. 配好上述 Secrets，选择比所有稳定版都高的新版本，创建并推送 `desktop-v<版本>` Tag。
   也可从 master 手动运行 `Desktop Release`，但指定 Tag 必须指向同一已通过 CI 的提交。
3. 等 `Desktop Release` 成功，记下 Run ID。此时仅有完整 Draft；用户仍看到旧稳定版。
4. 分别运行 `Desktop Windows Update Acceptance` 和 `Desktop Unix Update Acceptance`，
   两者传入同一个 Release Run ID；Unix 选择 `candidate`，不是 `rehearsal`。
5. 两项全部成功后运行 `Desktop Promote`，传入 Release Run ID 和两个验收 Run ID。
   流水线重新验证 GitHub 来源、所有平台、最新 Attempt、证据内容、Draft 和当前稳定源。
6. 查看发布证据与公开 `latest.json`，确认四个平台版本一致、包 URL 与签名准确。
   如果发布后的公共网络核验失败，状态明确为“已发布但核验失败”，不得把异常视为
   未发布后重复覆盖。排查网络/缓存，必要时另发修复版本。

无 Apple 凭据时第 2 步应阻断，这是设计行为。无 Secret 的 CI `rehearsal` 构件只能作
测试证据，不提供给用户当作正式基础包，也不能拿其 Run ID 通过正式发布门禁。

验收控制工作流从可信 master 启动，再显式 checkout 候选构建 SHA；发布期间主干可继续
前进，但构建、被测程序与验收源码绑定仍保持一致。旧版本固定测试地址不修改，首次
安装新基础包的迁移流程见第 4 节。
