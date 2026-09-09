# 三平台稳定更新通道规范

> 2026-09-08。本规范区分“代码可用”“CI 验收通过”“正式更新已发布”。
> 三者不能互相替代。验收结束时 Windows 原通道为 friends-v0.2.6；Mac/Linux 的正式
> 发布必须满足本规范门禁。Apple 凭据缺失时明确阻断，不退化成 ad-hoc 正式包。

## 2026-09-09：显式 Windows/Linux 发布范围

维护者可在 `Desktop Release` 的 master 手动运行中选择 `release_scope=windows-linux`。
这次正式发布只包含 Windows x64 NSIS 与 Linux x64 AppImage，不构建、不发布、不修改
macOS 固定测试通道。默认 `all` 和标签自动触发仍要求四个平台及 Apple 正式凭据；
不是自动降级，也不会把 ad-hoc Mac 包混入稳定源。

范围写入不可变 plan 和每份平台 receipt。构建矩阵、包清单、签名检查和 Promote 证据
均从同一个计划推导，必须恰好覆盖选定平台。Unix candidate 验收先验证真实构建来源、
聚合包签名和计划，再生成矩阵；不提供独立“跳过 Mac 验收”输入。无 Secret 的 CI
rehearsal 继续跑 Linux 和两种 Mac 架构。

稳定源平台只能增加，不能减少：如果未来 live latest.json 已包含 Mac，windows-linux
发布将被 Promote 拒绝，必须恢复 all 或先设计独立平台通道，不能静默删除 Mac。
旧无 release_scope 的计划按 all 验证，旧客户端协议、版本号格式、公钥和标识不变。

操作：创建已通过精确 master CI 的 desktop-vX.Y.Z 标签，再从 master 显式 dispatch
Desktop Release（release_tag=该标签，release_scope=windows-linux）。标签触发的 all
运行在缺 Apple 凭据时会在构建前拒绝；它不能作为候选或发布证据。记录成功的 scoped
构建 Run ID，继续原来的 Windows + Unix(candidate) 验收和 Promote，不能跳过任一项。
首次 Linux 用户仍需安装新的 AppImage 基础包；macOS 用户保持原样。

以下“四个平台”描述是默认 all 范围的要求；windows-linux 对应上述严格两平台集合。

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
- 每个 Unix 目标复用同一编译产物连续运行三轮，安装目录、HOME、配置和会话数据每轮新建；
  任意一轮失败均撤销整体验收。生产 Host 停稳后快照全部 Session Journal 的文件名和摘要，
  升级后精确核对全部库存与恢复数量，不假设前端只产生一个会话，也不以“恢复至少一个”替代。
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
   流水线以不携带 Token 的请求核对公开滚动入口的 `latest.json` 与 `updater.pub` 原始字节，
   CDN 延迟或网络异常最多读取四次（等待 0/2/5/10 秒，每次请求超时 15 秒）。
   如果发布后的公共网络核验失败，状态明确为“已发布但核验失败”，不得把异常视为
   未发布后重复覆盖。排查网络/缓存，必要时另发修复版本。
   PATCH 网络超时则记录“发布状态未知”，保留 Release ID 与请求意图，先人工核实，
   不自动重试发布；这两种异常都有独立可下载证据，不删除已经发布的包。

无 Apple 凭据时第 2 步应阻断，这是设计行为。无 Secret 的 CI `rehearsal` 构件只能作
测试证据，不提供给用户当作正式基础包，也不能拿其 Run ID 通过正式发布门禁。

验收控制工作流从可信 master 启动，再显式 checkout 候选构建 SHA；发布期间主干可继续
前进，但构建、被测程序与验收源码绑定仍保持一致。旧版本固定测试地址不修改，首次
安装新基础包的迁移流程见第 4 节。

## 8. CI 首轮暴露的回归修复

- Windows 默认代码页不是 UTF-8：发布脚本、GitHub JSON 子进程输出及源码测试明确使用
  UTF-8，CI 也统一 PYTHONUTF8，避免中文说明导致发布测试在 Windows 上解码失败。
- Tokio Runtime 在监督任务首次 poll 前销毁，不能依赖任务体内才构造的进程组 Guard。
  Guard 在调度前同步创建并持有 Child；异常退出后用不依赖 Tokio 的 OS 收尸路径，避免
  杀死根进程却仍留下 zombie。加入从不 poll 的确定性回归；原 3 秒/ESRCH 检查不放宽。
- Unix 原生验收固定 Python 3.12；Mac 保持同一 session、使用独立 process group，Linux
  使用独立 session。BASE 构建复用当前 Runner 的 Cargo target 缓存，正式候选字节不修改。
- 原生演练发现固定 `restoredSessions == 1` 的验收假设不成立：前端可能创建默认会话，
  Intel Mac 的失败证据确认新 Host 已健康恢复两份会话、无 restore issues。改为停机边界的
  精确库存校验，并增加双会话成功、库存丢失/变更/符号链接/数量不符的回归。
  较早一次 Linux 超时缺少同等级诊断，不能追溯断言必为同一根因。

## 9. 草稿 Release ID 绑定

GitHub 的 `GET /repos/{repo}/releases/tags/{tag}` 仅返回已发布版本，不用于读取草稿。
创建草稿前分页检查所有 Release，拒绝复用同标签的既有草稿或已发布版本。通过创建
响应取得 Release ID，记录创建意图和返回的身份，再上传附件；不自动重试创建请求，
也不覆盖既有附件。创建、上传或校验失败时单独保留公开元数据证据，不生成成功候选包。

完整候选的 `draft-snapshot.json` 已包含 ID、标签、源码 SHA、草稿状态和附件身份。
之后在验收证据汇总及发布前复查时，均按这个绑定的 ID 读取，并逐项比较原始快照。
ID 丢失、草稿被删除、已公开、标签或源码改变、附件变动都应失败，不退回搜索同名草稿。
该规则由共享发布脚本执行，对 Windows、Linux 和 macOS 一致；不改变更新密钥、更新源
或用户数据，也不把失败构建留下的草稿直接认定为已通过升级验收。
