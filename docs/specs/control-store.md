# Host Control Log 规范

**Crate：** `xharness-control`
**状态：** Workspace、Settings 与首批 9 个通用 Mutation Receipt 已实现。

## 为什么不能放进 Agent Session

Agent `Session` 只描述某个模型会话可审计的 Turn、Step、Message、Provider 与 Tool 生命周期。
Workspace 列表、用户排序、Settings 和全局 RPC 回执跨多个 Session，并且绝不能进入模型上下文。
因此它们使用独立的 Append-only Host Control Log，而不是伪造 Session Event。

## 数据模型

每个 `LoggedControlEvent` 具有从 0 连续递增的 `seq` 和 CAS `ControlRevision`。一个非空
Mutation Batch 必须：

1. Revision 恰好加一；
2. 包含零个或多个状态事件；
3. 最后一项且唯一一项是 `mutation_committed`；
4. 状态与 Receipt 全部写入同一 JSONL Batch Record；
5. `flush()` 完成后 Host 才更新 Web Projection、广播事件并返回成功。

当前状态事件：

- `workspace_defined`：稳定 ID/Path/CreatedAt，允许更新 Title、UpdatedAt 与 Session Order；
- `workspace_removed`：删除 Tombstone；
- `workspace_order_set`：全局顺序；
- `archived_sessions_set`：归档集合；
- `settings_set`：Namespace 的 User/Effective Document 与连续 Revision；
- `mutation_committed`：RPC ID、Method、规范 Payload SHA-256 与原始成功 Response。

## Exactly-once

Workspace Create/Rename/Delete/InsertBefore/InsertSessionBefore/ArchiveSession，以及 Settings
Update/Replace/Mutate 均先取得 Host-global Mutation Gate：

1. 计算 `version + method + payload` 的确定性 SHA-256；
2. 已有相同 RPC ID、Method 与 Fingerprint 时，逐字返回旧 Response，不再验证路径、Revision 或
   重做状态变更；
3. 同一 ID 对应不同 Method/Payload 时返回冲突；
4. 新请求先基于当前投影生成事件，再以 Expected Revision CAS Append；
5. 跨进程 CAS 冲突后重新加载：只有发现本请求 Receipt 才按成功重放，否则 fail closed 并要求新请求。

这保证“状态已经落盘但 HTTP 成功响应丢失”不会重复 Create、重排或增加 Settings Revision。

## JSONL 与崩溃恢复

生产文件为 `<state-dir>/control/host-control.jsonl`，旁路 Lock 文件用于进程内 Mutex 与跨进程
Advisory Lock。Header 使用 `create_new + O_NOFOLLOW + 0600`；首次创建和每次显式 Flush 都同步
文件与父目录。加载严格校验格式、Seq、Revision、每批唯一 Receipt、Workspace Identity、Settings
Revision 与 Receipt 唯一性。只有未换行且 JSON 不完整的最后一条记录可作为 Torn Tail 忽略并在
下次 Append 前截断；完整中间损坏必须阻止 Host 监听。

Host 启动顺序是：先重放 Control Log，再枚举 Agent Session 并恢复 Session→Workspace 归属，最后
再次应用 Control Workspace 排序和 Tombstone。这样自定义元数据与 Session 真源都不会互相覆盖。

## Secret 边界

Control Log 只保存 Settings 文档和安全 Response，不保存 Credential Value。任何非空字段名命中
Password、Authorization、API Key、末尾 Token 或 Secret 时，Append 整批原子拒绝；空的
`secrets: []` 协议占位允许存在。未来 Credential 功能只能把 Secret 存进 OS Keychain/外部 Secret
Provider，Control Log 记录不含值的 Reference 与状态。

## 验收

- Memory/JSONL 使用同一投影与 CAS 语义；两个 Store 实例只能有一个同 Revision Writer 成功；
- State Event 和 Receipt 不可能只落一半；Torn Tail 恢复后 Revision 不前进；
- 并发相同 RPC 只产生一个 Revision，跨 Host 重启逐字重放原 Response；
- 自定义 Workspace Title、顺序、Session 顺序、归档和 Settings Revision 重启后不变；
- Secret 字段拒绝且失败 Batch 不改变 Revision；
- 真实 `xharness-host` 子进程在同一 State Dir 重启后恢复 Workspace/Settings，并继续提供 WebSocket；
- Rust Check/Test/Clippy 只在 `WZU_Server` 执行。

## 尚未完成

- Session/Goal/Preset/Attachment 等其他变更 RPC 还未统一接入通用 Receipt；
- Queue 是 Durable Inbox 的派生投影，但还没有独立可游标查询接口；
- Credential Reference、Profile 文档和多用户 Owner/Scope 尚未进入 Control Log；
- Control Log 目前是单文件单 Writer，不提供远程分布式共识或二级查询索引。
