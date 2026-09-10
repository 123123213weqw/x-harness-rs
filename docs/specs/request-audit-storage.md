# 请求审计与内存边界（MEM-01）

## 问题与不变式

2026-09-10 本机观测：桌面 Host footprint 5.1 GiB、峰值 6.9 GiB；69 个会话约 2540 MiB，其中 request/header 约 2454 MiB（96.6%），主要是每步重复保存完整 input。不能把这个数字当成模型当前上下文大小。

**修复不裁剪模型输入、不删除用户消息/工具结果、不重放副作用、不修改已有日志。** 请求审计属于可按需读取的冷数据；消息事实、审批、Goal、队列、CAS 与恢复协议仍在同一会话日志。

## 1. Store 复用接口

- `Store::archive_request(RequestHeader) -> RequestHeader`：默认实现透传（内存 Store/第三方 Store 兼容）；JSONL 实现返回带审计引用的轻量头。
- `Store::request_header(session_id, seq)`：按会话及事件序号读取单次完整请求。默认从 Session 读取；JSONL 实现通过受文件身份约束的偏移索引读取目标记录，再验证并解析冷存储。
- Core 只归档已经确定、马上发送的请求；归档失败明确失败，不执行一个没有审计记录的下一步请求。实际 ProviderRequest 没有经过任何删除/压缩。
- Full Debug 仍使用原 DebugRecorder；关闭 Debug 时不再提前构建 `provider.request.prepared` 的大 JSON 副本。

## 2. 无损冷存储

路径：`state/sessions/request-audit/<sha256>.json`。

每条输入消息、工具定义集合、System Prompt 分别按内容哈希复用。一个版本 1 manifest 保存消息哈希列表和完整请求元数据（包含 ContextPolicy edits）；每次请求的热日志只保存 manifest 引用、消息/工具数量、预算、来源等元数据。

不同会话相同内容可以复用磁盘对象，但浏览器不能凭哈希任意读取：只接受已经存在的会话 ID 和对应 request/header 的 seq，经原受保护 RPC 通道访问。没有增加公共文件路由。

- 写入顺序：私有临时文件 → 文件 sync → 原子发布 → 目录 sync → 追加引用它的 Journal 事件。
- 提交前崩溃最多产生未引用对象，不产生已提交引用的半文件；不自动删除孤儿，避免误删跨会话共享数据。
- 读时验证 SHA-256、版本、文件类型、路径格式；禁止符号链接。单 blob/单请求审计展开/单 Journal record 设置 128 MiB 防御上限，超限明确报错，不静默截断。这是序列化字节边界，不是模型 Token 上限。
- 摘要缺失、文件损坏或版本未知：Context 页明确报错；普通对话继续从消息事实恢复，不把“审计不可用”解释成“对话为空”。
- 这不是自动清理系统：冷存储仍随不同内容和请求引用增长。备份必须包含整个 state 目录，而不是只复制 JSONL。

## 3. 老日志兼容与缓存

生产 Host 使用 `JsonlSessionStore::for_runtime()`：

- 逐条 JSONL 读取、解析、校验，复用单条记录缓冲区；不先读取整个文件。
- 仅在运行时视图中省略旧 request/header 的重复 input/tools/system 和详细 edits；原 JSONL 字节不变，序号/Revision/消息事实不变。
- `request_header` 仍能按需读取老记录的完整内容；`inspect` 返回真实磁盘 Journal（新记录本来就是引用）。
- 缓存按访问时间淘汰，默认 **128 MiB 估算账面容量、最多 16 个会话**。大于上限的单项不缓存；可以显式禁用缓存。
- 账面容量基于序列化大小和对象开销的保守估计，**不是进程 RSS 上限**；调用方持有的旧 Arc cut、当前模型输入、网络、前端及 allocator 都不计入缓存上限。
- 旧 cut 保持不可变，淘汰只释放缓存所有权；跨进程文件锁、fingerprint 校验、Revision CAS 和残尾恢复继续生效。
- 按需审计最多 2 个读取任务；任务取消后，已开始的阻塞 I/O 仍持有 permit，避免无限启动并发读取。

## 4. Host 和 UI

- Durable Host 不再为所有会话常驻第二份 `messages`；Provider 输入由原 Runtime 从事实派生。
- 导出对话时按需派生完整 messages，避免取消常驻副本后导出空对话。
- 启动计量使用逐事件 fold，不生成整份临时 Web JSON 数组。
- 实时/历史 request/header 统一只推元数据，连旧日志也不再向浏览器广播完整 input。
- 新增内部读取 RPC：`session.requestSnapshot`，payload `{sessionId, seq}`；复用现有 HTTP RPC、桌面 Cookie 和服务端鉴权，不新增模型工具。
- Context / Harness 打开后自动读取当前请求；压缩前后/Diff 最多保留选中的请求和一对比较快照。切换、关闭、错误和超时清理旧状态，晚到响应不能串到其他会话；失败可重试。
- 已安装 App 需要同时升级 Host 和 UI；修改源文件不会立即改变当前运行进程。

## 5. 回归与验收

- 新快照归档/去重/重启/完整读取；审计缺失/损坏/符号链接；模型消息事实不变。
- 旧大快照轻量恢复、磁盘字节不变、后续追加保留旧前缀。
- 缓存淘汰/禁用/超大条目、旧快照与 CAS、切换 runtime 模式清空旧缓存。
- 无末尾换行的索引、完整未知末条不得当残尾删除、既有跨进程/截断/损坏测试。
- Host 按需 RPC、错误 session/seq、无常驻 transcript、导出仍完整。
- Chromium/WebKit：真实组件、按需恢复、切换会话、网络错误重试、晚到响应、Diff 和卸载。
- 独立进程合成大历史内存对照、生产 Host 的真实 DeepSeek 三轮编程及独立代码验收，结果见 `docs/evaluations/memory-audit-20260910.md`。
