# 后台更新与缓存：原生隔离升级验收（2026-10-04）

## 验收边界

本记录补原先缺失的真实安装包链路：原生进程下载并验签 → 完整缓存落盘 → 关闭／重启基础进程 → 取实时清单并重新验签复用缓存 → 明确确认 → 停止 Host → 安装原样签名候选 → 重启 → 保留数据并重新加载会话。

- 所有 Rust 编译均在 V100 或 GitHub-hosted 原生 runner；Mac 本机仅做 TS／Node／Python 回归与源码同步。
- 使用临时签名密钥、回环 HTTPS 和合成数据。基础包仅为驱动隔离而插入测试代码／关闭自动检查；目标包不插入测试代码，安装后核对精确包／文件树。
- `nativeUpdateAccepted=false` 是刻意的防误发布标记：临时密钥演练不得伪装成正式渠道发布收据，不是测试失败。
- 不修改现有应用、真实 HOME／配置、3082 服务、生产 feed、正式密钥或发布版本。

## 原生结果

| 平台 | 包型 | 次数 | 状态 |
|---|---|---:|---|
| Linux x86_64 | AppImage | 3 | 通过 |
| macOS Apple Silicon | `.app.tar.gz`，ad-hoc 代码签名 | 3 | 通过 |
| macOS Intel | `.app.tar.gz`，ad-hoc 代码签名 | 3 | 通过 |
| Windows x86_64 | NSIS | 1 | 通过 |

Unix [运行 37182218394](https://github.com/123123213weqw/x-harness-rs/actions/runs/37182218394) 成功。三个平台各三轮独立安装／状态目录，9/9 通过；原始收据及重复轮摘要位于 `desktop-native-updates-20261004/`。

逐轮验证：真实签名下载；不可用更新源不停止 Host；坏包拒绝；新进程缓存重验签复用；正常包只下载一次；已准备缓存再篡改时安装被拒绝且 Host 继续运行；未确认不能安装；Host 停止后抓取完整 journal 清单；原样目标安装／重启；会话标题和模型选择重新进入目录；journal／合成配置、凭据文件、工作区及哨兵文件 SHA-256 保留；测试自有进程树清理。

Windows 首次演练在**生成临时签名密钥前**暴露 Python 找不到 `npm.cmd` 的兼容问题，未进入安装阶段。已修为直接以 Node 运行其发行版 `npm-cli.js`，不使用 shell 字符串或放松签名。新增三个契约测试；首次失败[运行 37182390340](https://github.com/123123213weqw/x-harness-rs/actions/runs/37182390340) 保留，重跑[运行 37182922451](https://github.com/123123213weqw/x-harness-rs/actions/runs/37182922451) 已成功完成。

Windows 原始 `PASS.json` 和 `cache-reopen.json` 位于同目录的 `windows/`。新旧窗口确认为 `0.0.901 → 0.0.902`；两端 Host 健康、会话标题／模型可查询；配置／合成凭据／工作区和 journal 哈希一致；一次完整包下载；缓存篡改时 Host 继续运行。真实 WebView 的 frontend hydration／first frame 打点存在，但单次打点不构成启动速度 A/B。

## 源码绑定与回归

- Unix 原生包基于 `16e4d439efb38ab01c223c923ef2623832152bfe`；到 Windows 修复提交 `92d8e00c8ee042f703aaca17db86eff8a58c9cc7`，生产 Rust、UI 和 Unix 驱动源码未改变。逐文件哈希校验见 `desktop-native-updates-20261004/unix-source-binding.json`；之后只补 Windows 演练调用与报告，不拿文档 SHA 冒充安装包 SHA。
- V100 桌面库 **46 项**、全目标 check、全目标 Clippy `-D warnings` 通过。46 是整个桌面库测试数量，不是 46 个独立缓存测试。首次隔离目录缺 Tauri sidecar 资源，按既有暂存脚本补齐后重验；该 V100 lib 测试不冒充真实安装，真实 Host 在原生 runner 从同一源码重新编译。
- Node updater **22 组**；严格 TS、确定性构建／漂移检查、干净隔离 UI 构建通过。
- Chromium／WebKit：启动首屏各 **30** 场景，更新器交互各 **24 + 4** 场景；完整 53 模块图启动、设置、模型强度与工作中心导航通过。
- Unix 隔离／升级契约 **43** 项、发布构建契约 **48** 项、Windows 演练来源／隔离 **18** 项；原正式 Windows 来源、签名与发布门禁未削弱。
- 详细本地日志保存在 `/tmp/xharness-background-20261004/`，完整 CI 和原生运行日志在上面的 Actions 及 PR #215。

## 不包含的证明

没有测量或宣称原生启动速度更快。没有宣称正式生产签名、Apple 公证／浏览器首次下载 Gatekeeper 批准、Windows Authenticode／SmartScreen、Linux `.deb` 包管理器升级、多旧版本迁移矩阵、下载部分续传或普遍自动回滚已经验收。首屏是生命周期／交互改造，不是性能基准结果。

真实用户对话内容未用于演练；保留的是合成会话标题／模型／完整 journal 和合成配置／凭据／工作区，不宣称覆盖所有历史版本的生产数据迁移。
