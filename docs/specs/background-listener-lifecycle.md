# 后台通知监听器生命周期

## 缺陷

后台通知任务持有 `Arc<BasicHost>`，Host 又持有 Runtime 和广播 Sender；监听器只在 channel 关闭时退出，形成相互等待释放的生命周期环。即使全部外部 Host 引用已释放，旧 Host/会话状态仍可能常驻。这不是每次消息必然泄漏一份 Host，也不是 Windows 访问冲突的根因证明。

## 修复契约

- 后台 turn 与 Goal 变化监听器只持有 Host 弱引用，不跨下一次 `recv().await` 持有强引用。
- 收到事件后临时升级弱引用；已开始的处理正常收敛，不取消已入队消息、不重复执行模型或工具。
- Host 值克隆共享一个生命周期所有者；最后一个所有者释放时取消监听令牌。监听任务只复制令牌，不持有生命周期所有者。
- `stop_background_listeners()` 是幂等、终态操作；即使外部仍持有 Runtime/Sender，也唤醒空闲监听器。已开始的处理和模型任务另由 Runtime shutdown 负责收敛。
- 正式 Host 入口在 Runtime shutdown 后发出停止信号。重启监听需要新建 Host，不在旧 Host 重注册。
- 不引入 unsafe，不修改对话持久化格式、权限或 Provider 请求。

## 回归

- 同一 Tokio Runtime 内重复创建/释放 32 个 Host；保留 Runtime，检查 Weak Host/State 失效及两个广播 receiver 归零。
- 重复启动只注册一次；显式停止重复调用安全且停止后不再注册。
- 处理中释放外部 Host：允许处理期间临时持有，处理完成后 Host 与 receiver 释放。
- 通知积压/滞后时销毁 Host，不接受旧任务。
- 释放一个普通 Host 值克隆不误停其余所有者。
- 原 Goal/Schedule/恢复与 Host 回归一起运行。Windows 长时间运行问题仍需独立采样和崩溃证据。

## 远程验收记录（2026-09-12）

在 WZU_Server 同一源码/测试下仅换回旧 `start_background_turn_listener`：空闲释放测试在 3 秒超时后失败，Host/receiver 未释放。恢复修复函数后 5 项生命周期测试通过。

全 Host 119 项（含新增 5 项）、Goal runtime 20 项、Schedule 5 项通过；Host/Host App 的 Clippy `-D warnings` 通过。共 144 项非重复测试。所有 Rust 编译在远程完成。未测 Windows 安装包及真实长期 RSS，不将对象释放回归等同于已确认 Windows 崩溃根因。
