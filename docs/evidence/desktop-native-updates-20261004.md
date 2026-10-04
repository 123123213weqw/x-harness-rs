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

- Unix 原生包基于 `16e4d439efb38ab01c223c923ef2623832152bfe`；到 Windows 修复提交 `92d8e00c8ee042f703aaca17db86eff8a58c9cc7`，生产 Rust、UI 和 Unix 驱动源码未改变。逐文件哈希校验见 `desktop-native-updates-20261004/unix-source-binding.json`；后续仅补验收测试和报告，不拿测试／文档 SHA 冒充安装包 SHA。
- V100 桌面库 **46 项**、全目标 check、全目标 Clippy `-D warnings` 通过。46 是整个桌面库测试数量，不是 46 个独立缓存测试。首次隔离目录缺 Tauri sidecar 资源，按既有暂存脚本补齐后重验；该 V100 lib 测试不冒充真实安装，真实 Host 在原生 runner 从同一源码重新编译。
- 原移植 Node updater **22 组**；合并主线侧栏锚定回归后为 **24 组**；严格 TS、确定性构建／漂移检查、干净隔离 UI 构建通过。
- Chromium／WebKit：启动首屏各 **30** 场景，更新器交互各 **24 + 4** 场景；完整 53 模块图启动、设置、模型强度与工作中心导航通过。
- Unix 隔离／升级契约 **43** 项、发布构建契约 **48** 项、Windows 演练来源／隔离 **18** 项；原正式 Windows 来源、签名与发布门禁未削弱。
- 详细本地日志保存在 `/tmp/xharness-background-20261004/`，完整 CI 和原生运行日志在上面的 Actions 及 PR #215。

## 全量 UI 门禁失败的定位与测试修复

最终报告提交的全量 CI [第一次](https://github.com/123123213weqw/x-harness-rs/actions/runs/37183695252/attempts/1)在 WebKit 的选区保留断言失败；未改源码的[完整复验](https://github.com/123123213weqw/x-harness-rs/actions/runs/37183695252/attempts/2)又在另一项 WebKit 工具折叠测试失败。两次失败保留，不作为通过结果，也没有继续盲目重跑。

在 V100 Linux 上用 `taskset -c 0,1`、Playwright 1.61.1、Node 20.20.2 复现两个原测试：各五轮，共 10 次，3 次失败。诊断确认：

1. 选区测试释放旧焦点后，仅等待一个按钮仍在 DOM，并不代表首行的测量／滚动锚点稳定；目标文本可能在选区建立前已被窗口化。修正为明确滚到首行、等连续三帧的真实几何稳定、收到原生 `selectionchange` 后才滚离；原有“不驱逐选区”断言保留，另加选中文本逐字不变断言。
2. 折叠测试缩小视口后保留读者的焦点／选区，摘要入口的重型按钮可能正当地落在视口外被窗口化。现场工具 3／4 已折叠，0／1／2／5、焦点和选区均正常，错误来自要求屏幕外按钮必须存在。改为检查这两个实际可折叠工具消失、四个受保护工具保留、轻量摘要入口仍驻留，同时新增焦点和选中文本不变断言。前面已有的可见摘要展开／折叠测试没有删除。

修复仅修改两个测试，**不修改生产 UI、Rust 或更新器**。同样 Linux 双核条件的两个测试各五轮 **10/10 通过**；Mac Chromium／WebKit 两个测试 **4/4 通过**。这是 CI 夹具正确性回归，不是性能基准；最终 Node 22 全量门禁仍以 PR 当前提交的 CI 为准。机器可读计数／日志哈希见 `desktop-native-updates-20261004/ci-fixture-regression.json`。

另一次最终提交的 [Linux Rust job](https://github.com/123123213weqw/x-harness-rs/actions/runs/37190968756/job/111402866041)在既有 Cloud 持久化测试重新打开数据库时返回 `EnvironmentBusy`。同一测试进程中还并行运行真实 abrupt-exit 子进程夹具；Linux 的 `flock` 绑定 open-file description，fork 得到的重复描述符也会延续锁的生命周期（[Linux man-pages](https://man7.org/linux/man-pages/man2/flock.2.html)）。因此在测试内用读写锁隔开 open/reopen 与该子进程的 fork/exec 窗口；不是在生产代码重试 `EnvironmentBusy`，也没有移除真实进程退出、单写者或 reopen 断言。V100 16 路并行的原持久化套件先编译运行一次，再重复 30 轮：每轮 14 项通过，真实子进程夹具仍实际运行，合计 **31 轮通过**。记录见 `desktop-native-updates-20261004/cloud-persistence-fixture-regression.json`。该后续修改仍仅涉及测试与报告，原生运行时代码及其哈希不变。

## 主线侧栏更新的再次集成

等待最终 CI 时，主线合入 PR #219（`acf74b5938da2d3b160d6ee2327456ca0273368c`），包含侧栏更新器预留行和已批准的搜索／嵌套浏览器清理。本分支保留这些主线改动，并保留后台 `prepare()`、有界重试、退出取消和显式安装确认；从合并后的 TS 源码重新生成 dist，不对产物做文本合并。

这次集成改变了更新器 TS／bundle，所以前面两次原生运行是**历史基线证据**，不再将旧运行时代码哈希描述为最终合并源码。合并后须再次运行四平台原生演练及当前提交全量 CI；[集成后运行 37193933106](https://github.com/123123213weqw/x-harness-rs/actions/runs/37193933106)的三个 Unix 平台 **9/9 通过**；Windows 缓存重开、单次包下载和篡改拒绝通过，但等待新版本 Host 超时，最后截图显示插件加载失败。该轮明确记为**失败**，并保留 `integrated/windows-first-failure/`，不以旧 Windows 通过结果替代。

只补观测的 `8cd6305c0584f770170ff92e9d98f22f9cca24a5` [Windows 运行 37195181584](https://github.com/123123213weqw/x-harness-rs/actions/runs/37195181584)已完成下载／缓存重开／篡改拒绝／原生安装／目标重启／合成数据保留。记录显示安装停止旧 Host 时，**旧端口**尚在加载的插件资源收到 `ERR_CONNECTION_REFUSED`；随后新端口的 `0.0.902` Host 与 frontend hydration／first frame 均正常。该新观测说明“旧截图中插件错误”不能独立证明目标包插件缺失；它不充分解释首次超时，故不把首轮标为通过，也不声称已完整复现首轮根因。

现在加强夹具：源绑定的 cache 演练必须等**真实原生前端 commit 和 first frame**再开始更新；在旧版本且 Host 已停止的 CDP 页残留时断开观测连接并重新扫描真实调试端口，不重启／修复应用、不放过新版本 Host 失败。六个 readiness／旧连接判别回归加入现有 Windows 契约（合计 **24 项**）；旧正式版本无此启动字段时原门禁保持兼容。生产 Rust／UI／打包源码未改变。

集成后 9 个 Unix 收据、Windows PASS／缓存与状态观测位于 `desktop-native-updates-20261004/integrated/`；完整 `crates`、`ui/src`、`ui/dist`、桌面 frontend／src-tauri Git tree 逐项一致，见 `integrated/source-binding.json`。最终提交的原生夹具复验和 CI 仍以 PR #215 对应 Actions 为准；临时签名结果不用于正式发布门禁。

## 不包含的证明

没有测量或宣称原生启动速度更快。没有宣称正式生产签名、Apple 公证／浏览器首次下载 Gatekeeper 批准、Windows Authenticode／SmartScreen、Linux `.deb` 包管理器升级、多旧版本迁移矩阵、下载部分续传或普遍自动回滚已经验收。首屏是生命周期／交互改造，不是性能基准结果。

真实用户对话内容未用于演练；保留的是合成会话标题／模型／完整 journal 和合成配置／凭据／工作区，不宣称覆盖所有历史版本的生产数据迁移。
