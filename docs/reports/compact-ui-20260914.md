# Compact 既有 UI 协议修复验收

## 问题与修复

1. Rust 日志摘要为 String，直接透传后 `compactSummary()` 不识别，摘要不可展开。Host 的统一 Web 投影现转换为 text 内容块数组，日志存储格式不变。
2. replacement message 原 source=user/restored，`compactSource()` 无法识别。现按 SurfaceReplace.compaction_id 和起始事件建立 plugin=compact 来源；手动 sourceCommandId 保留，用于旧组件单卡片关联。
3. 生命周期 turn 从 Rust 一基坐标转换为前端零基坐标。
4. Context 检查页原只读字符串，因此同时补上新内容块格式兼容；源码、dist、manifest 同步。

复用 CompactionItem、CompactionCommandCard 和原有折叠/Markdown/统计/双语能力，不改压缩算法、预算或模型输入。自动压缩仅展示已落地 checkpoint；本次未新增自动运行中/失败卡片。

## 验证

Rust 均同步源码后在 WZU_Server 执行：

- `cargo test -p xharness-host -p xharness-core -p xharness-agent -p xharness-session -p xharness-compaction`：314 passed，0 failed，4 ignored（3 项已有跳过 + 1 项此前的 max-token 诊断）。
- `cargo clippy -p xharness-host --all-targets -- -D warnings`：通过。
- 自动/手动映射、Unicode 摘要、统计字段、实时前缀/分页/启动尾部/Session 重放一致；失败/取消/输出截断不替换原上下文。
- Rust 导出的实际投影 fixture：`tests/fixtures/compaction-ui.json`。

前端：

- `node scripts/test-compaction-ui.mjs`：消费上述 fixture，执行已打包组件的 fold 和渲染函数；验证自动/手动不重复、重复事件、历史恢复、迟到摘要、展开/收起、摘要缺失禁用、条数/token、Context 新旧格式。
- `test-context-plugin`、`test-context-accounting`、`test-max-tokens-notice`、`test-execution-checkpoints`、`test-internal-queue` 通过。
- 使用独立 `/tmp/xh-compact-ui-deps-20260914` 安装 UI 测试依赖（不改变仓库依赖）。`test-context-layout` 在 Chromium、WebKit 各通过 19 场景，覆盖切换、流式快照、工具、窗口尺寸、输入框及空页面。

当前源码修复已完成，尚未推送、打包、替换或重启用户软件。本次测试未操作用户真实会话，也未调用付费模型。
