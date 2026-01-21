# 工作区文件系统规范

**Crate：** `xharness-fs`
**状态：** 已在 Linux、macOS 和 Windows 实现并原生测试。

## 权限模型

`FsService` 固定在一个 Canonical Workspace，并暴露 Opaque `FsTarget`/`FsTargetKey`。
调用方必须先 Resolve Path 再做 I/O。Parent Traversal、最终 Symlink、Symlink Escape 和
过期 Parent Identity 都必须 fail closed。

Linux 相对持有的 Directory FD 使用带约束的 `openat2` 解析，并用 `renameat2` 发布。
macOS 通过 `openat(O_NOFOLLOW)` 逐级遍历，用原生 API 校验目录身份/路径，再用
`renameatx_np` 发布。原生差异属于私有实现细节。

Windows 对路径组件执行大小写不敏感的边界比较，拒绝 reparse point 穿越；同目录临时文件在
写入前复制目标 DACL，发布使用 `ReplaceFileW`。Full access 以当前 Workspace 所在卷根为
结构化文件能力根，避免把 `C:` 与其他卷错误视作同一能力。

## Observation CAS

Read 会在 `(session_id, target_key)` 下记录文件 `FsVersion`（Length + SHA-256）或“不存在”。
Replace 必须匹配已观察版本；Create 必须先观察到不存在。Blind Write 和 Stale Write
必须失败。Literal Edit 要求已经 Read、内容是 UTF-8，并且 Old Text 恰好匹配一次。

## 原子发布

Write/Edit 在同目录创建 Exclusive Temporary File，设置 Mode、写入并 fsync，重新校验
原始 Parent Directory，然后原子发布并 fsync 目录。清理也使用已经校验的 Parent FD。
Create-if-absent 在平台支持时使用原子 No-replace Primitive。

## Read 契约

Read 受 Byte、Line、Long-line Policy 限制，返回 Diagnostic、Truncation、Bytes Read、
Text 和权威 Version。“不存在”是强类型 Outcome，不是普通 I/O Error。

底层兼容 `read()` 默认 `max_bytes=256 KiB`、`max_lines=2,000`、`max_line_bytes=16 KiB`。
`read_page()` 接受 Byte Offset、1-based Start Line 或 Opaque Cursor。Coding Tool 默认使用
32 KiB/400 行，允许显式 Byte/Line 起点和限制；下一页 Cursor 同时绑定完整文件 SHA-256 与
原页限制。文件变化后 Cursor 返回 Stale，而不是把不同版本内容拼在一起。底层仍扫描并计算
完整 Version，分页不能削弱 Observation CAS。

## 当前限制

- v0 面向模型的仅是常规 UTF-8 Coding File。
- 分页当前仍需扫描完整文件以计算权威 SHA-256；这是正确性优先的实现，超大文件的增量
  Version/内容寻址索引属于后续性能工作。
- 尚未暴露递归 Copy/Move/Delete、Chmod、目录创建、二进制写入和 Attachment/Blob Store。
- 面对不协作的外部 Writer，Replace CAS 只能在发布前做最后一次 Best-effort Version
  Recheck；若外部修改发生在该瞬间之后，没有更强 OS/应用协调就无法事务化。

## 验收标准

测试必须覆盖 Traversal/Symlink 拒绝、不存在观察、Blind/Stale Replace、Create/Edit/
Replace 持久性、Read Limit/UTF-8、Parent Swap 检测，以及并发 Symlink/Reparse Swap 竞态中绝不
写出 Workspace。分页实现还必须覆盖 Cursor 连续性、行/字节边界、分页后 Version 稳定和
大文件不一次进入模型上下文。Windows 还必须覆盖大小写路径、DACL 保留和 `ReplaceFileW`。
