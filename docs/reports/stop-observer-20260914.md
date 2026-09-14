# Host 停止状态卡住修复验收

基于主分支 09b452f（#82）；本次仅修复运行观察器，不包含 Compact/队列卡片/输出截断提示的 UI 修改。

## 原因与修改

提前为排队输入订阅的广播可能落后。旧实现将 Lagged 当作模型失败，Host 提前观察后续输入；后续输入再被 Steer 消费时没有独立 TurnStarted，观察器可能永远等不到自己的 TurnFinished。持久日志已停止，但 Host 的 running/control 收尾没有执行。

本次将观察器集中到 `crates/xharness-host/src/runtime/observer.rs`，复用日志按 input ID 定位轮次、按该轮结束事实恢复结果。Steer、删除、Parked、Idle、Closed 有收敛路径，落后不触发模型失败或工具重放。原有 Host 收尾和停止门禁继续复用。

## 验证

所有 Rust 编译、测试和 Clippy 均在 WZU_Server 执行；本机只格式化及同步源码。

- `cargo test -p xharness-host -p xharness-agent -p xharness-core -p xharness-session`：301 passed，0 failed，3 项原有 ignored。
- `cargo clippy -p xharness-host --all-targets -- -D warnings`：通过。
- 默认 2048 事件容量，2200 片流式输出：落后订阅随后 Steer/删除，用户停止后观察器退出。
- 完整 Host RPC：queue → steer → cancel → running=false/control=None；内部 settlement 不能恢复停止门禁。额外连续重复 3 次，3/3 通过。
- 旧观察器晚于四个后续轮次恢复：只返回原轮回答和消息，没有多执行输入。

Fake Provider 用于可控触发边界，不访问真实模型或用户工作区。尚未发布或替换桌面安装包。
