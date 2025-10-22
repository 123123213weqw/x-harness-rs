# JSONL Session Store 规范

**Crate：** `xharness-session-jsonl`
**状态：** 已为本地文件系统实现。

## 磁盘格式

每个合法 Session ID 映射为 `<root>/<id>.jsonl` 和一个内部 Lock 文件。第一行是不可变
记录，包含固定 Format Tag、Version 和 `SessionHeader`。后续每行是一个完整原子 Append
Batch，包含 Previous Revision、New Revision 和全部事件。

Session ID 必须使用受限 ASCII 白名单并限制长度，禁止指向隐藏文件、路径分隔符或符号链接。

## 并发与持久性

- Create 使用 Exclusive Create，禁止替换已有 Session。
- Append 在 Load、Expected Revision 校验、Write、Sync 整段持有 OS Advisory File Lock；
  两个进程竞争同一 Revision 时，必须一个成功、一个 Revision Conflict。
- 非空 Append 编码为一行，完成同步后才返回成功。
- `flush` 先校验 Log，再同步 Session 数据。
- Create 和持久化屏障必须同步 Parent Directory，确保崩溃后文件名仍存在。

## 恢复与损坏

只有当最后一条无换行记录在语法上确实不完整时才忽略；下一次 Append 必须先截断/修复
该 Tail。完整但非法的最后记录、任何中间损坏、Seq Gap、Revision 不连续、Header 不匹配
或生命周期违规都必须 fail closed。合法但没有结尾换行的记录必须保留，并在 Append 前
补上分隔。

## I/O 模型

阻塞文件操作必须放到 `spawn_blocking`。同一进程的不同 Store 实例共享 Path Lock；OS
Lock 提供跨进程序列化。Backend 把存储错误映射成 `StoreError::Backend`，禁止泄露凭据。

## 当前限制

- 保证依赖本地文件系统正确支持 Advisory Lock 和 fsync；不承诺 NFS/Object Store 语义。
- 尚无 Log Compaction、Encryption、Quota、GC 或索引查询。
- 一个 Session 对应一个持续增长的文件。

## 验收标准

测试必须覆盖 Exclusive Create、单行 Batch、Round Trip、Stale/No-op CAS、进程内和跨
进程竞争、安全 Session ID、拒绝 Symlink、Torn Tail 修复、合法无换行记录、中间损坏、
Revision/Seq 不连续、错误格式、Flush 和 Not Found。
