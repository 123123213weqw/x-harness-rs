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

冷加载必须逐行检查 Batch Previous/New Revision 连续性并汇总原始 `LoggedEvent`，然后对完整 Cut
只执行一次 Session Sequence/Revision/生命周期验证。禁止把每行重新作为 Session Append 回放，
否则检查点数量增加时会形成平方级前缀重复扫描。

## I/O 模型

阻塞文件操作必须放到 `spawn_blocking`。同一进程的不同 Store 实例共享 Path Lock；OS
Lock 提供跨进程序列化。Backend 把存储错误映射成 `StoreError::Backend`，禁止泄露凭据。

Store 可以为已完整校验的 Session 保存进程内写穿快照，但快照不能改变磁盘真源语义：

- 每次读取、Append 和 Flush 仍先取得同一路径的进程锁与 OS Advisory Lock；
- 命中条件同时包含 Device/Inode、文件长度、修改/状态变更纳秒时间戳，以及最多 12 KiB 的
  头/中/尾内容采样；快速同长度改写也必须使快照失效；
- Append/Flush 在持有路径锁时可以把快照所有权移出 Cache，避免克隆大 Session；操作完成后以
  新文件指纹写回。失败时允许 Cache 变冷，但不得返回未经验证的数据；
- 独立 Store 或其他进程提交后，旧快照必须在下次访问时失效。Advisory Lock 和磁盘 Revision
  永远负责跨进程 CAS，Cache 不能充当 Fencing Token。

## 启动枚举

`Store::list_headers()` 是 Host 启动恢复的唯一目录发现入口：

- 只把 `<合法-session-id>.jsonl` 当作 Session；`.lock` 和其他普通文件必须忽略。
- 返回结果按 Session ID 升序，禁止依赖文件系统目录顺序。
- 每个候选必须走与 `load()` 相同的 Header、格式、生命周期、Seq/Revision 和 Symlink 校验。
- 发现损坏或符号链接 Session 时整体 fail closed，不能静默跳过，否则产品会把持久任务伪装成
  “不存在”。
- 当前 Store 没有删除操作，因此枚举后文件消失视为后端错误，而不是正常竞态。

## 当前限制

- 保证依赖本地文件系统正确支持 Advisory Lock 和 fsync；不承诺 NFS/Object Store 语义。
- 尚无 Log Compaction、Encryption、Quota、GC 或索引查询。
- 一个 Session 对应一个持续增长的文件。
- 当前快照仍保存完整 Session；它消除了热路径的重复 JSON 解析，但不等于二级索引或 Log
  Compaction。首次启动和外部修改后的第一次读取仍需完整校验。
- 大 Tool Result 必须仍可作为原始审计事件持久化；模型上下文压缩属于独立 Surface/Spill
  策略，禁止通过原地改写 JSONL 伪装成压缩。

## 验收标准

测试必须覆盖 Exclusive Create、单行 Batch、Round Trip、Stale/No-op CAS、进程内和跨
进程竞争、安全 Session ID、拒绝 Symlink、Torn Tail 修复、合法无换行记录、中间损坏、
Revision/Seq 不连续、错误格式、Flush、Not Found、排序枚举、忽略非 Session 文件，以及枚举时
拒绝损坏/Symlink Session。
