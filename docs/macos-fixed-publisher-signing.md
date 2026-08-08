# macOS 固定发布者签名（未公证预览）

## 边界

`all-macos-selfsigned` 是显式选择的新发布策略，不改变 `all` 的 Developer ID / 公证门禁，也不改变现有 `all-macos-preview` 的 ad-hoc 策略。

固定自签不是 Apple 认可或公证。首次安装、从 ad-hoc 或个人本机重签迁移时，仍可能需要「仍要打开」以及重新授予隐私权限。保持签名身份是减少重复授权的前提，而不是保证。Homebrew 的安装升级及 macOS TCC 必须分别进行交互验收，CI 的原生代码签名测试不冒充这两项验收。

本次改动不重签、重新发布或重绑已经生成的 0.2.35 候选。新策略仅用于以后新版本的固定源码构建。

## 一次建立身份

在可信机器运行（不执行 Rust 编译）：

```sh
# 密码不要写进命令参数、脚本、仓库或聊天；交互输入。
read -rs 'XHARNESS_MACOS_PREVIEW_P12_PASSWORD?P12 password: '
export XHARNESS_MACOS_PREVIEW_P12_PASSWORD
python3 -B scripts/macos-stable-signing.py create --output "$HOME/.xharness/publisher-signing"
```

输出目录必须不存在，权限 0700；`publisher.p12` 加密且权限 0600。脚本删除临时私钥 PEM，保留公开证书与指纹。默认证书有效期五年；到期/私钥遗失时需要独立的身份迁移，不能静默创建新证书冒充旧身份。加密 P12 和密码分别离线备份。不使用个人日常登录钥匙串的签名私钥作为公共发布者私钥。

## GitHub 配置（完成保护后再上传私钥）

1. 创建 `macos-preview-signing` Environment，限制为可信 `master` 和经过审核的 `desktop-v*` 标签，并设置发布审批人。禁用 PR / 非可信分支部署。确认仓库套餐支持并实际执行该保护。
2. 公开 Repository Variable：`XHARNESS_MACOS_PREVIEW_CERT_SHA1`，内容为 `fingerprint.txt` 的 40 位小写指纹。该指纹绑定发布计划、持久发布任务、每个平台收据和更新清单，不含私钥。
3. 只在该 Environment 配置 Secrets：
   - `XHARNESS_MACOS_PREVIEW_P12`：加密 P12 的 base64。
   - `XHARNESS_MACOS_PREVIEW_P12_PASSWORD`：P12 密码。
4. 现有 `XHARNESS_FRIENDS_*` 更新签名密钥保持不变。

在确认 Environment 保护后可用 stdin 上传，不回显密钥内容：

```sh
base64 < "$HOME/.xharness/publisher-signing/publisher.p12" |
  tr -d '\n' |
  gh secret set XHARNESS_MACOS_PREVIEW_P12 --env macos-preview-signing --repo 123123213weqw/x-harness-rs
printf '%s' "$XHARNESS_MACOS_PREVIEW_P12_PASSWORD" |
  gh secret set XHARNESS_MACOS_PREVIEW_P12_PASSWORD --env macos-preview-signing --repo 123123213weqw/x-harness-rs
gh variable set XHARNESS_MACOS_PREVIEW_CERT_SHA1 \
  --body "$(cat "$HOME/.xharness/publisher-signing/fingerprint.txt")" --repo 123123213weqw/x-harness-rs
unset XHARNESS_MACOS_PREVIEW_P12_PASSWORD
```

不自动修改默认发布 scope；配置完成、CI 和验收通过后，对一个全新版本显式选择：

```sh
python3 -B scripts/release.py NEW_VERSION --repo 123123213weqw/x-harness-rs \
  --platforms all-macos-selfsigned --no-wait
```

已有版本任务拒绝换 scope 或证书指纹，不覆盖已有标签或候选。缺私钥、指纹不符、签名失败时阻断，绝不降级为 ad-hoc。

## 构建与凭据生命周期

- 规划只使用公开 pin；私钥只进入受保护的 macOS 构建/正式验收 worker。
- 自签 P12 导入 runner 临时钥匙串，密码不写进 GITHUB_ENV、收据或 artifact。
- 不修改任何系统证书信任域，也不调用 `sudo` / `add-trusted-cert`。固定 DR 使用精确 leaf pin，而非 `anchor trusted`；签名后仍执行完整 codesign、证书有效期、各组件 pin 与新旧 DR 连续性验证，签不出来就阻断。参见 [Apple 的签名要求说明](https://developer.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/Procedures/Procedures.html)。
- 仅一次性的 GitHub-hosted macOS runner 将临时钥匙串加入 user search list，以便构建嵌入的证书链；先写恢复收据，`always()` 恢复原 search list 并删除私钥钥匙串。不替换默认钥匙串；恢复失败仍尝试删除私钥、保留收据并报告失败。
- 不替换默认钥匙串、不修改客户端信任、不去除 quarantine。密钥不装进 App，不交给用户，不提供关闭系统安全的安装脚本。
- 初始构建可为临时 ad-hoc；随后对 `rg`、Host、主程序及整个 App 按固定标识逐层重签，验证后重新打包，再生成最终包 `.sig`。
- 每个组件的 DR 为固定 identifier 与发布者 leaf certificate 指纹，不依赖每版变化的代码哈希或证书名称。
- 固定策略更新清单明确标注 `self-signed-unnotarized-preview` 与 pin；不能标成已公证。禁止固定签名通道悄悄换 pin、回退 ad-hoc，或把已公证通道降为预览。

## 验收

离线：

```sh
python3 -B scripts/test-macos-signing.py
python3 -B scripts/test-macos-stable-signing.py
python3 -B scripts/test-desktop-release-build.py
python3 -B scripts/test-unified-desktop-release.py
python3 -B scripts/test-unix-update-acceptance.py
python3 -B scripts/test-release-orchestrator.py
```

CI 新增无生产密钥的原生 macOS 门禁：临时证书、两个 C fixture App 版本，逐个验证 leaf pin、固定 DR 以及新版本满足旧版本身份；全程无 Rust 编译。由于需要临时钥匙串及可恢复的 search-list 变更，该 fixture 明确拒绝在用户本机运行。签名和清理失败同时发生时，保留两个阶段的错误，不让清理错误覆盖原始签名错误。

正式升级验收将仪器化旧版 BASE 用同一证书签名，再由生产更新处理器安装未改动的正式候选；校验所有嵌套组件的新旧身份连续性、重启、数据保留及包签名。仍声明 BASE 是测试构建，不冒充真实历史安装包。

最后必须人工使用两台 Mac / 两个架构验证：Homebrew 首次安装与允许、升级第二版是否再提示、App 内更新、截屏/辅助功能权限、钥匙串、任务和数据保留。不能在这项实测之前承诺「永远只授权一次」。
