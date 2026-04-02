# Mac 未公证预览版与旧通道迁移

## 目标

面向明确选择未公证版本的小范围用户，保留严格 Updater 签名，但不要求 Apple Developer ID 与公证。Apple Silicon / Intel 的后续发布均复用已有 `all-macos-preview` 构建及原生更新验收，不另造桌面更新器。

首次安装可能需要“隐私与安全性 → 仍要打开”；受管理的机器可能不允许。不得关闭系统安全机制。未公证不等于不验证更新包。

## 根因与修复

旧 App 0.2.18 固定读取 `desktop-test-v0.2.18/latest.json`，该清单仍返回 0.2.18。正式 0.2.19 只有 Windows/Linux，且长期通道与旧测试通道的签名密钥不同。

- Desktop Release 的手动默认和 tag 默认改为 `all-macos-preview`；保留显式 `windows-linux` / 正式 `all`。
- 新包仍使用既有 `releases/latest/download/latest.json` 与 Friends 公钥，两个 Mac 平台均纳入。
- 既有代码禁止发布时丢掉清单已有平台，禁止把已公证 Mac 通道降级为未公证；这些保护不变。
- 旧客户端无需读取新版配置：旧 feed 提供一份旧密钥签名的新包；安装后的二进制已内置长期地址与新公钥。

## 迁移 CI

`Mac Preview Channel Migration` 只允许配置的仓库从 master 手动运行。输入 `legacy_version`（默认 0.2.18）、已公开发布的 `target_version`、`publish`（默认 false）。本流程不编译，不接触用户数据。

1. 获取旧清单、公钥和校验和；核对仅为该版本的 ARM 测试通道。
2. 获取已发布长期版本的 ARM 包；校验新公钥、签名、版本、固定下载 URL。
3. 验签后安全解包，验证 codesign、Info.plist、二进制内置长期地址与公钥。
4. 包字节不变，用旧测试私钥重新签归档；复用签名库独立校验新旧两条信任链。
5. 输出迁移清单、旧清单备份和包哈希凭据。默认只产生 Artifact。
6. 显式 publish 才创建不覆盖旧包的独立 prerelease。发布成功之后才替换指定旧 release 的 latest.json 及对应 SHA256SUMS；不写统一清单，也不改变 GitHub latest 指针。
7. 修改前再次检查旧清单哈希；若被其他维护者改动则停止。与正式桌面发布共用并发组。

失败处理：源版本缺 Mac、下载/验签失败、版本回退、密钥不匹配、非预期内置通道一律停止；新桥接 release 已创建后部分失败不自动覆盖重试，先检查远端状态。发布包和推进 feed 非跨资产事务，残留草稿或校验和短暂不同步需人工恢复；保存原始清单及完整旧校验和用于恢复。旧 release 的原始安装包不改。

## 发布顺序

1. PR 全量 CI 绿后合并。
2. 在 CI 通过的 master 创建新 desktop-v 版本，显式 `all-macos-preview`；按现有流程完成原生验收后 promote。
3. 执行迁移 workflow，先 publish=false，核对 Artifact；再 publish=true。
4. 本机旧版点检查更新，验证版本与包；用户确认后才重启安装。检查会话、模型配置与下一次长期通道请求。
5. 需要迁移其他旧测试版本时分别执行，不批量覆盖所有历史 feed。

## 测试与边界

- Node 合同：版本增加、非法输入、跨仓库拒绝、草稿/预发布源拒绝、缺失 Mac 拒绝、错误 URL/签名/内置地址/公钥、旧清单版本或平台漂移、SHA256SUMS 一致性。
- 复用现有签名测试：错误公钥、篡改包、旧签名桥接与新签名后续版本。
- 复用 all-macos-preview 原生候选验收：安装、重启、会话保留、错误签名拒绝；未公证模式不冒充 Gatekeeper/公证验收。
- 合同测试不是实际安装证据。首次线上桥接与本机实际升级未完成前，TODO 保持未勾选。
