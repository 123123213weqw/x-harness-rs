# UI 生命周期恢复与历史复用

## 1. 连接代际与待交互状态

`ConnectionController` 在 readiness RPC 完成之前就开始消费 mux，所以 `onConnected` 不是新代际的起点，也不能在这个时间清除待审批或待回答列表。

- `SessionManager.handleDisconnected` 统一处理旧代际：清理列表的 pending/buffer，并对已实例化 Session 调用 `invalidateConnectionGeneration`。
- Session 增加 history generation，令死连接的异步历史请求不能发布；清除旧 pending 与订阅水位，并标记旧 Wait 已结算，禁止持有旧对象的回调继续应答。
- `resync` 只刷新历史；它保留已经重放的新 pending 和 subscribed watermark。
- 请求／resolved 帧仍是待交互状态的权威来源；历史事件不创建需要人类应答的入口。
- 断线期间被结束的请求没有新 baseline，不会在重连后凭旧数据复活。

不改变后端审批授权、问题超时、回答递交或 RPC。

## 2. 重试部分历史恢复

`updateRetryState` 同时用于增量 update 和 `fallbackRetryState` 的顺序折叠。

- 页中有第二次重试但无首次事件：展示第二次的真实调度状态。
- 只有 `retry-started`：展示已开始的已知 attempt，`partial=true`；未观测的原因、延迟和最大次数显示占位，不使用虚构值。
- 补齐旧页后重新折叠，恢复真实调度详情。
- 有关闭边界的未开始调度标记为取消；重复 seq 仍由 Assembler 去重。

## 3. 隔离事务内的局部状态复用

**仍在新的候选 Assembler、Location 数据存储、View Builder 中构建，全部成功后才提交。** 不直接在已发布实例中运行可能失败的 reducer 或 builder。

分页保留旧事件／view 引用，新事务可复用显式声明 `historyReuse: "local"` 的 Definition：assistant、command、自动 compact、input-message、retry、tool。该声明要求状态不可变，所有跨 Context 依赖通过 reader 声明，不能隐式读取整个 timeline 的数据。

复用条件：Definition 身份、所有 Match 的 event/view/role、Turn/Step 边界相同；已声明前驱的状态未改变；缺失历史 gap 未改变。新增证据或发现新的边界／前驱时重新计算。turn-tail、turn-error 等隐式 timeline 读者和未声明插件不复用。

Assistant.final、Compact.start/end 等直接持有 Match 的字段绑定到新事务的 Match，节点 Location 也绑定新事务，避免旧的可变 Location reader 跨事务被保留。临时方法和闭包在提交前删除，不长期持有上一份 Assembler。

重连／全量替换、存在未 flush 的修改及注册表变化不启用分页复用。

这是降低 reducer、业务节点构建及历史流式文本重聚合的成本，并非完整 O(新增数量) 分页：匹配与索引仍扫描窗口，独立 View Builder 仍要安全构建候选快照。虚拟 DOM、Markdown 渲染、进程 RSS 需独立基准，不从调用次数推断。

## 回归

`node scripts/test-ui-lifecycle-recovery.mjs` 运行实际 Controller、Session、Manager 与 Assembler，覆盖重放早于／晚于 readiness、审批和提问、deferred、resolved、旧对象应答、死连接请求失效、所有重试分页切点与重连、重复事件、仅 started、隔离 builder 失败、依赖变化、保守插件、Assistant Match 重绑定以及实际 Session.loadOlder。

独立节点基准：100／1,000／10,000 个旧节点各增加 50 个新节点，复用路径均为 50 次 reducer 和 50 次业务节点构建；同时与完整重建结果比较。不将这个数据宣称为实际应用的内存或延迟下降比例。

相关原子历史、实时恢复、Compact 705 检查、正文思考、重试归属和浏览器交互测试仍应运行。代码修复不表示安装软件已更新。

## 本批验收记录（2026-09-30）

V100 上 9 组关联 Node 回归通过，包括 Controller/Session 生命周期、原子历史、实时恢复、正文思考、重试归属、Compact 705 检查、滚动、命名空间及提问补丁。WebKit 审批、提问、历史缓存和窗口化回归通过。最终新增的 fresh retry 补丁用例在本机 Node 验证通过；远程最后一次同步因 SSH 超时未完成，本批没有 Rust 源码改动，也没有在本机编译 Rust。

工作区已有的未提交 `test-compaction-ui.mjs` 修改存在 `running` 作用域错误，未混入本批；读取已提交测试脚本后针对本批 bundle 回归通过。完整从外部上游包重新组装 UI 的命令因为缺少 `@deepseek-ai/dsh-app-boot` 依赖未执行成功。已更新自有补丁、打包插件与 graph 哈希；完整重新组装、GitHub CI 和安装包验收仍待完成，未发布或替换用户软件。
