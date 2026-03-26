# 推理能力发现回归（2026-09-14）

## 结果

- V100 `WZU_Server:~/codex-build/x-harness-rs`：`cargo test -p xharness-host-app -p xharness-host`，182 passed、4 ignored、0 failed。忽略项未计作通过。
- 同一服务器：`cargo clippy -p xharness-host-app -p xharness-host --all-targets -- -D warnings` 通过。
- `node scripts/test-model-controls.mjs` 与 `node scripts/test-model-settings-ui.mjs` 通过，包括实际打包资源 schema、哈希、重复打补丁。
- 服务器 Chromium：`test-model-controls-browser.mjs` 通过，包括点击刷新能力（RPC 标志）、保存后重载、思考档位保留、切换模型、未知能力、输入校验、返回/Escape、网络错误与布局。
- 服务器 WebKit：安装浏览器后仍因系统缺少 `libgstcodecparsers-1.0.so.0`、`libavif.so.13` 无法启动，**未通过/未执行页面测试**。没有擅自修改系统依赖。

## 重点覆盖

实际 HTTP fixture 返回原生 brief 档，经 `session.models(refreshCapabilities=true)` 更新为 deep，再遇到 503 保留 deep 并标记 stale；不是用模型名猜测能力。另覆盖缓存跨启动恢复、密钥/协议身份隔离、配置省略与显式 null、非法请求映射、模型切换和原请求映射回归。

此次不调用付费模型生成请求，没有读取或改写正在运行的软件对话/凭据，没有替换 Desktop 或 3082 服务。Rust 只在远程编译，源代码（含未提交改动）经排除敏感文件的 rsync 同步。

## 待完成

跨平台 CI、WebKit/macOS 实机回归、合并、重新打包发布。当前安装版本不因这次源码修改自动升级。
