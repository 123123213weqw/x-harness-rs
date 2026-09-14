# 内部回执队列隔离验收

基于停止观察器修复 df08d77。范围仅为内部回执与用户队列区分，不改变子 Agent 调度或模型上下文内容。

## 修改

- Host 队列投影只把 source.kind=user 作为可操作用户输入；内部消息复用 context placement，保留 ID/content/source。
- RPC 在持久变更之前拒绝编辑、Steer、删除内部输入，错误 reason 为 QUEUE_ITEM_READ_ONLY。
- 恢复来源元数据不再依赖 content 字段同时存在，兼容无来源旧用户消息。
- 已打包的 Web/Tauri UI 原本支持 context 过滤，无需替换组件或重新构建前端资产。

## 验收结果

- WZU_Server：cargo test -p xharness-host -p xharness-agent -p xharness-core -p xharness-session：302 passed，0 failed，3 项原有 ignored。
- WZU_Server：cargo clippy -p xharness-host --all-targets -- -D warnings：通过。
- 本机 Node：node scripts/test-internal-queue.mjs：6 checks passed，已加入 CI。
- 扩展已有子 Agent 集成测试：6 个子任务完成回执去重；三类 RPC 变更拒绝且持久日志/投影不变；回执不唤醒暂停父会话；重启后投影相同。
- 保留用户 Steer → Stop 观察器回归；原用户队列编辑/删除等 Host 回归通过。

使用可控 Fake Provider，不调用付费模型，不触碰用户工作文件。尚未发布、替换或重启现有软件。
