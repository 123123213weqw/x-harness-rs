# 三平台更新回归验收 · 2026-09-08

## 结论与证据等级

核心改动 [CI 34171760874](https://github.com/123123213weqw/x-harness-rs/actions/runs/34171760874)
**11/11 Job 成功**。PR head 为 `27489d513cf0864522aaaf66a1c39d2a95b68993`；
原生演练实际检出的 PR 合并快照为 `9dbd5e834404cde9f1cdbbd68a42edd1ee2af9a3`，
三平台构件与验收收据均绑定此 SHA。后续文档提交不应被误称为这个 Run 的被测提交。

通过的是正式更新代码的隔离演练与常规回归，**不是正式 Apple 签名/公证候选验收**。
所有演练收据保持 `scope=isolated-production-handler-rehearsal`、
`nativeUpdateAccepted=false`，不能拿这个 CI Run 授权发布正式更新。

## 原生升级：9/9

每个平台构建一次临时 BASE 0.0.901 和未插入测试驱动的目标 0.0.902；
连续三轮重用同一构建产物，每轮单独创建 HOME、状态、工作区及安装目录。
测试调用已有生产 updater 命令，没有重写一套安装器，没有改动目标包。

| 平台 | 升级轮数 | 每轮实际恢复的会话数 | 结果 |
|---|---:|---|---|
| Linux x64 AppImage | 3 | 1 / 2 / 2 | 全部通过 |
| macOS Apple Silicon | 3 | 1 / 1 / 1 | 全部通过 |
| macOS Intel | 3 | 1 / 2 / 2 | 全部通过 |

每轮都验证：包签名、503 更新源错误、并发检查排斥、篡改下载拒绝、未经确认禁止安装、
安装产物精确匹配、进程重启、新 Host 健康、全部会话恢复、模拟凭据/配置/工作区保留。
`candidateModified=false`；已知会话的正文与所有会话 Journal 文件摘要精确一致。

公开证据在该 Run 的 `desktop-rehearsal-<platform>` Artifacts 中：

- 根目录及 `repetitions/2`、`repetitions/3` 的 `acceptance.json`、`evidence.json`。
- `repetition-summary.json` 绑定三个成功轮次、各份收据摘要与同一候选身份。
- 任意一轮失败会撤销顶层 acceptance，正式发布还会独立检查整个验收 Run 的最新 Attempt 成功。
- 不上传临时私钥、TLS 私钥、HOME、源码副本或真实 Provider 凭据。

## 其余 CI

- Linux、Windows、macOS 的 Rust workspace check/test/clippy；Rust 编译全部由远程 CI 执行。
- Linux Tauri shell check/test/clippy，以及 macOS/Windows 原生包构建和既有安装回归。
- Chromium/WebKit 的 Context、模型控件、Subagent 导航与桌面更新层回归。
- 三操作系统发布契约：签名、版本/平台集合、构件来源、不可变 Draft、发布后公开源校验。
- 新增/扩展的 Python 契约包括统一协议 36 项、编排 30 项、Unix 隔离及恢复 20 项。

## 本轮实际修复的问题

1. Windows 默认编码及 file URL 到路径转换；测试统一使用 UTF-8 与本机路径 API。
2. 临时 TLS 链缺少严格验证要求的证书扩展；修证书，不关闭证书/主机名验证。
3. Tokio Runtime 在 supervisor 首次 poll 前退出时的子进程保护，以及 Runtime 消失后的收尸。
   真实 Linux/Mac 回归保持严格 ESRCH 与原超时，没有把 zombie 视为成功。
4. 验收固定要求恢复一个会话是错误的：前端可以合法创建默认会话。
   Intel 失败证据显示新 Host 已健康恢复两份会话、无问题。现于生产 Host 停机成功后
   采集完整 Journal 库存，重启后精确匹配数量及全部摘要，不改成松泛的“至少一个”。
5. 发布请求网络异常区分“状态未知”与“已发布但公开核验失败”；记录证据，不自动重发、删除或回滚。

较早一次 Linux 超时未留下足够诊断，不能追溯宣称其根因已被单独证实；
本轮增加诊断后，Linux 的三轮包含两个真实双会话场景，全部按新严格规则通过。

## 尚未授权或完成的正式操作

- 用户暂时没有 Apple Developer ID 与公证凭据，保留硬门禁；不以 ad-hoc 包冒充正式发布。
- 尚需正式四目标构建、对应正式候选的 Windows/Unix 原生验收，再执行 Promote。
- 本机旧 Mac 0.1.4 固定测试源需要一次完整基础包迁移；本轮没有替换、重启用户 App。
- 验收结束时现有 Windows 流水线独立发布了 `friends-v0.2.6`；本轮没有修改其 Release。
  正式 Desktop 版本门禁动态读取实时稳定通道，不硬编码停留在旧 0.2.5。
- Linux DEB/RPM、额外 ARM 目标、数据格式降级回滚等仍见总 TODO，不能冒充已验收。

规范：[三平台稳定更新](../specs/unified-desktop-updates.md)。
