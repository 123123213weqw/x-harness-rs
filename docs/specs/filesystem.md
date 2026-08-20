# 工作区文件系统规范

**Crate：** `xharness-fs`
**状态：** 已在 Linux 和 macOS 实现。

## 权限模型

`FsService` 固定在一个 Canonical Workspace，并暴露 Opaque `FsTarget`/`FsTargetKey`。
调用方必须先 Resolve Path 再做 I/O。Parent Traversal、最终 Symlink、Symlink Escape 和
过期 Parent Identity 都必须 fail closed。

Linux 相对持有的 Directory FD 使用带约束的 `openat2` 解析，并用 `renameat2` 发布。
macOS 通过 `openat(O_NOFOLLOW)` 逐级遍历，用原生 API 校验目录身份/路径，再用
`renameatx_np` 发布。原生差异属于私有实现细节。

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

## 当前限制

- v0 面向模型的仅是常规 UTF-8 Coding File。
- 尚未暴露递归 Copy/Move/Delete、Chmod、目录创建、二进制写入和 Attachment/Blob Store。
- 面对不协作的外部 Writer，Replace CAS 只能在发布前做最后一次 Best-effort Version
  Recheck；若外部修改发生在该瞬间之后，没有更强 OS/应用协调就无法事务化。

## 验收标准

测试必须覆盖 Traversal/Symlink 拒绝、不存在观察、Blind/Stale Replace、Create/Edit/
Replace 持久性、Read Limit/UTF-8、Parent Swap 检测，以及并发 Symlink Swap 竞态中绝不
写出 Workspace。
