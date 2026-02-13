# 自动会话标题回归记录

日期：2026-09-07。执行环境：`WZU_Server`，`~/codex-build/x-harness-rs/`。

源码通过 rsync 同步（包括未提交改动），排除 `.git/`、`target/`、`node_modules/`、
`.env`、`.env.*`；本机只运行 `cargo fmt`，未在 Mac 编译 Rust。

## 验收命令与结果

```sh
cargo test --locked --workspace --all-targets
cargo clippy --locked --workspace --all-targets -- -D warnings
```

两条命令均成功。新增 `xharness-host::titles::tests` **14 项全通过**；已有 Workspace
回归通过，现有需外部环境的 ignored 测试仍保持忽略，并不视为通过。Clippy 无警告。

关键证据：

- 真实 Host RPC `session.create → session.prompt → Durable Loop → session/title → title projection`，
  一个主请求＋一个标题请求，不需要用户再发消息才更新标题。
- 主 Provider 阻塞回复期间提交临时标题，之后主 Turn 正常完成，历史仅包含原用户与
  Assistant 消息；后台元数据不污染模型上下文。
- 旧会话生成成功后重启 Host，标题模型调用数仍为一次；手动标题竞态优先。
- 切模型或删除发生在标题请求中途，旧标题结果不提交。
- 空白/不完整输出、输出上限、工具调用、401/429、Retry-After、未知 finish reason 合约、
  超时取消和崩溃 Pending 预约均有隔离测试。
- 14 项包含 UTF-8 截断、进度序列化/校验、问候延后、关闭 Worker 和低推理档位隔离。

## 验收范围

Provider 使用可控 Fake Stream 和实际 Durable Runtime/Memory Store，不代表真实厂商的标题
质量或真实网络延迟测量；Store 机制的文件/跨进程回归由现有 Workspace 测试覆盖。
尚未制作或安装包含本改动的桌面更新包，也未重启用户当前 Web/桌面或 GPU 模型服务。
