# 上下文计量修复验证（2026-09-09）

## 问题复现

所审计对话包含 115 次请求，最后一次保守估算为 415,395 tokens。
该次 Provider usage 为非缓存输入 454、缓存读 116,992，总输入 **117,446**。
旧前端优先选 projectedTokens，导致把约 3.54 倍的估算作为主要占用显示。
会话日志还重复保存请求快照，日志字节数不等于模型输入长度。

## 数字脱敏回放

使用 `export-context-calibration-replay.py` 从本地日志导出数字特征、匿名配置指纹和实际 usage，只有数字回放文件发送到远程测试程序，不发送原始会话内容。

- 115 次请求中 112 次有 usage，3 次没有，不捏造观测。
- 91 次达到相似样本要求并进入 calibrated，其余冷启动。
- 112 次中估算低于实际：0 次。
- 校准阶段估算/实际中位数：1.2764。
- 最后一次旧估算 415,395；离线新估算 151,952；实际 117,446。

这是对历史记录表面的离线校准验证，不是重新向服务端发送历史后获得的新精确 token。不能由这一段样本保证所有模型、语言和输入分布不低估。

## 真实 DeepSeek 多轮工具调用

远程执行 `context_accounting_smoke`，凭据只通过 stdin 传递，不写入示例或报告。
使用 deepseek-v4-flash、关闭本项测试的思考、固定合成文本，连续追加 12 轮用户消息、echo 调用和嵌套 JSON 工具结果。

- 12/12 次返回正确工具名、参数与 usage。
- 每次完整重放之前的工具历史；没有减少工具正文。
- 第 10 次起校准生效；第 12 次实际 3,401，估算 4,505。
- 12 次请求中估算低于实际：0 次。
- 请求完成耗时中位数 727ms；这只是小型工具 fixture 的端到端耗时，不代表长上下文 TTFT 或 decode 提速。

## 自动化回归

WZU_Server：workspace/all-targets 484 passed、0 failed、4 ignored；Clippy `-D warnings` 通过。
前端计量、历史回放、插件契约通过；Chromium / WebKit 各 19 个布局用例通过。

跨平台 CI 与安装包交付结果见下。

说明：最终测试使用 stdout/stderr 分开收集，避免并行 Cargo 输出交错导致漏计汇总；69 组结果合计 484 passed、4 ignored。

## 合并与本机交付

- [PR #42](https://github.com/123123213weqw/x-harness-rs/pull/42) 合并提交 `2418bbf01ebd1bdeceafaa9185cec886a06558ba`。
- [跨平台 CI](https://github.com/123123213weqw/x-harness-rs/actions/runs/34306759515) 全部通过，包括 Windows、macOS、Linux 和原生更新演练。
- [macOS 0.2.8 个人测试包](https://github.com/123123213weqw/x-harness-rs/releases/tag/desktop-test-v0.2.8)，[发布构建](https://github.com/123123213weqw/x-harness-rs/actions/runs/34307873287) 成功；仍为 ad-hoc / 非公证个人测试通道，不改变正式发布门禁。
- 下载后用 0.2.7 发布中已有的更新公钥验证 Minisign，再验证 SHA256、codesign，以及包内 47 个 UI 文件和图标与源码一致。
- 替换本机 `/Applications/XHarness.app` 并重启；安装前没有运行中的 Agent。
- 原有 27 个会话全部保留，providers.json 字节哈希不变；完整旧 App / state / Provider 文件已备份。
- 新桌面 Host 对审计会话返回：`pressureTokens=117446`、`projectedTokens=415395`、`accuracy=provider_reported`、`phase=measured`。旧估算作为历史事实保留，新 UI 优先展示实际值。
- 没有重启 3082 独立 Web 服务，也没有更新其他机器。原生 UI 自动化读取超时，未把它算作截图验收；本机验收采用实际桌面 sidecar RPC 和安装包资源比对。
