# 桌面后台准备更新回归记录

2026-10-03，在主分支 `ca87936` 的隔离开发分支 `fix/desktop-background-updates-20261003` 上完成源码回归。没有发布版本、改线上更新清单、安装候选或重启用户的软件；未替换 3083 Web。

## 已通过的测试

| 环境与入口 | 结果与范围 |
| --- | --- |
| macOS `npm run build --prefix ui`、`npm run check:build --prefix ui`、`npm run typecheck --prefix ui` | 严格 TS 通过，53 个自有模块和 154 个产物构建一致；只变更 updater 及其产物 Hash |
| macOS `node --test scripts/test-desktop-updater.mjs` | 22 项断言组通过，涵盖后台检查到下载、并发互斥、显式安装确认、离线退避、IPC 无新序号重试、旧重试计时器取消、页面退出、乱序事件和产物一致性 |
| V100 `cargo check`、`cargo test`、`cargo clippy -- -D warnings` | desktop lib 46 项通过，包括缓存重开、身份六字段漂移、签名篡改、半包／缺失／损坏、符号链接、长度与描述容量边界，以及缓存失效后的重新下载门禁 |
| V100 Chromium 与 WebKit `scripts/test-desktop-updater-layer.mjs` | 各 24 个真实布局层级场景及 4 个后台准备场景通过；启动下载、已有 Ready、实时清单缓存命中、离线到在线均不弹面板、不调用安装，草稿可编辑、取消确认后继续工作 |
| macOS `scripts/test-updater-signature.mjs` | ED／Ed 签名、包／trusted comment 篡改、错误公钥与非法输入通过 |
| macOS 更新通道桥接、本机预览桥接、安装归属 Node 契约 | 通过；临时密钥与草稿目录，不向真实通道发布 |
| Python `scripts/test-desktop-release-build.py` | 45 项通过 |
| Python `scripts/test-unified-desktop-release.py` | 49 项通过 |
| Python `scripts/test-unix-update-acceptance.py` | 43 项通过，包含真实隔离 HTTPS 服务、停止／清理和归档契约；不是候选软件的实际原生更新 |
| Python friends release／macOS signing／Windows bundle 契约 | 分别 8／3／7 项通过 |

Rust 仅在 `WZU_Server` 运行。同步目录 `~/codex-build/x-harness-rs/background-updates/`，包括未提交源码；排除 `.git/`、`target/`、`node_modules/`、环境文件与密钥。现有 V100 预览服务目录和进程不改动。远程复用桌面 target 缓存，测试命令为：

```sh
. ~/.cargo/env
cd ~/codex-build/x-harness-rs/background-updates
export CARGO_TARGET_DIR="$HOME/codex-build/x-harness-rs/apps/desktop/src-tauri/target"
cargo check --offline --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
cargo test --offline --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib
cargo clippy --offline --locked --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings
```

浏览器使用 Playwright 1.61.1，UI 依赖按本分支 lock 在隔离目录安装。Python 最终使用本机 Python 3.14，而非系统 3.9。

## 回归中发现并解决的边界

- IPC 断开时，本地错误可能没有新的原生 `seq`。重试定时器不能只用序号去重，现以序号、操作及退避时间识别；成功、等待确认或操作开始后清除过期定时器。
- Unix 原生验收的旧定时器注入锚点不能识别新的 `prepare`。新增精确匹配版本，在仅用于验收的基础包中禁用统一后台入口，防止恢复网络／退避与原生驱动争抢；真实候选包及生产代码不被禁用。缺失、重复、改动锚点仍拒绝验收。
- Linux UI 构建器按锁定包真实路径校验依赖，拒绝跨工作区 `node_modules` 符号链接。改为隔离目录 `npm ci --offline --ignore-scripts`，未放宽构建门禁。
- 系统 Python 3.9 不支持已有发布测试用到的 API，切换至 Python 3.14 重跑。未为了测试改坏已有发布脚本。

## 仍需发布验收

Windows 与 macOS 原生编译、跨平台 GitHub CI、使用真实候选安装包的下载／停 Host／安装／重启／数据保留链路尚未执行。本轮浏览器使用原生桥接模拟器，Rust 测试验证生产缓存及状态代码；不能把这些结果表述为已完成实际软件升级。

完整包缓存不是下载中断后的 HTTP Range 续传；离线启动仍需取得最新清单才可复用缓存。没有新增通用新版启动失败自动回滚，也没有改变 Apple 公证或 Gatekeeper 策略。后续独立验收项见任务清单。

## 后续原生验收（2026-10-04）

原先缺失的原生隔离链路已补齐：Linux AppImage、macOS arm64／x64 各 3 轮，Windows NSIS 1 轮，合计 10/10。详情与源码／包哈希绑定见 [原生升级记录](desktop-native-updates-20261004.md)。临时签名演练不替代正式发布／首次下载 OS 门禁，不替换本机应用。
