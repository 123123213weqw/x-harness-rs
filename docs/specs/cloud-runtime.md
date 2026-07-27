# 专用 VM 托管 Runtime 契约

状态：领域基础、持久控制核、专属 VM 基础设施和原 Host 原生门禁首切片已在 V100 验收。真实 StageExecutor、Goal 引导、凭据注入、终态核对、常驻控制服务、Gateway、UI 和产品部署尚未完成；各阶段边界见第 15、16 节。

日期：2026-10-01。核对基线：`5c3b84034bdb7430062799ffae7a331ef3d11a97`。

本规范把[托管提案](../plans/2026-10-01-cloud-runtime-proposal.md)收敛为实施契约。目标是在用户授权的专用 Linux VM 内运行完整 XHarness Host 与持久 Goal，本机退出不停止任务。新代码必须服从这里的权威来源、状态迁移和验收规则。当前新增 crate 只验证领域契约，不代表现有软件已提供远程托管；完整接口的实现边界见第 14 节。

补充验收：2026-10-01 已在 V100 上完成[四真实 VM 实验](../runbooks/cloud-vm-lab.md)，原 Host API 的环境切换、隔离和恢复共 16 项通过；领域测试扩至 56 项。实验不构成生产托管接线、真实模型/Goal、多厂商云故障切换或运行中任务迁移的验收。

## 1 核心不变量

1. VM 内仍是现有 Host、Durable Runtime、GoalController、Inbox、Loop 和 Tool Registry，不增加第二套模型执行引擎。
2. VM 内 Session 与 Control 是 Agent 工作的权威来源；托管记录只拥有任务接纳、环境绑定与生命周期。Goal 投影过期不能触发外层续轮。
3. 一个托管任务绑定一个根 Session、一个独占执行环境和一个活动执行世代。子 Agent 仍归现有 Runtime 管理，不另占独立托管身份。
4. 客户端断开、Gateway 超时和心跳过期不等于任务取消、VM 停止或允许另一个实例接管。
5. 接纳、部署、应用和停止是不同事实。只有持久收据或有效停止证明能推进相应状态。
6. 同一命令身份重试不重复产生任务、Goal 或环境。外部副作用结果未知时不承诺恰好一次，不盲目重放。
7. Full Access 作用于专用 VM 内的已授权范围，不传播到云账号、宿主机或其他用户；原工具调度、文件观察、预算与进程清理不因此关闭。
8. 模型密钥走凭据通道，只在 VM 的运行时配置中注入，禁止进入任务描述、Session、命令 URL、argv 或 Debug 输出。
9. 不修改旧 RPC 和 JSONL 格式来偷塞云管理行为。新增协议独立版本化，内部 `AgentRuntime` trait 不逐方法网络化。
10. 取消和终态封存必须阻止重新激活，包括 Goal、Schedule、已接纳输入、子 Agent 和 Host 重启恢复路径；只挡前端按钮不算实现。
11. 释放环境与删除数据分别授权。终态不可原地重新执行，需要新建任务或显式的后续任务。

## 2 模块与最小新增边界

```text
客户端 RuntimeConnection
         │
         ▼
托管应用服务 CloudTaskService
  ├─ CloudTaskStore        接纳、绑定、操作收据、生命周期 CAS
  ├─ EnvironmentBackend    已有 VM / 后续云厂商适配
  ├─ CredentialBroker      引用解析、版本绑定、运行时注入
  └─ ConnectionGateway     鉴权、任务路由、流量和连接恢复
         │
         ▼
VM 内 Host-app 的 HostedBinding 适配
  引导收据、执行许可、恢复校验、停止收据
         │
         ▼
原 BasicHost → DurableLoopAgentRuntime → 原 Goal 与 Loop
```

实现建议只增加两个生产组合单元：`xharness-cloud` 保存托管 DTO、纯状态归约和端口；`xharness-cloud-app` 实现存储、控制服务、Gateway 和环境 I/O。上述端口首先是模块边界，不各自建一个 crate 或微服务。

- `xharness-cloud` 不依赖 Host、Core、平台或云 SDK；不复制 Goal、Session 或模型 Usage 类型的决策逻辑。
- 环境 I/O 不进入 `xharness-core`、`xharness-platform` 或模型 Provider。
- VM 内 `HostedBinding` 接入原组合入口与生命周期，不提供 `remote_bash/read/write`。
- 客户端连接选择属于客户端组合；本机 `BasicHost` 不再充当远程 Session 的第二个权威 Host。
- 原 `ApiBackend` 继续承载会话请求；Gateway 只鉴权和转发，不把 Loop 对象或 Provider trait 序列化。
- 实现新 crate 或依赖边时同步修改架构基线并做边界回归；`CLOUD-01` 已在 Cargo workspace 登记 `xharness-cloud`，内部依赖白名单为空，不放开现有检查。

## 3 领域身份与数据归属

| 对象 | 内容 | 权威位置 |
| --- | --- | --- |
| TaskSpec | 用户授权的初始目标、材料、环境、模型及资源策略 | 托管 Store，不可变 |
| TaskRecord | task_id、owner、revision、phase、当前绑定、结算记录 | 托管 Store，CAS 更新 |
| EnvironmentRecord | 环境身份、能力、绑定与资源事实 | 托管 Store 与适配器探测 |
| Binding | task_id、environment_instance_id、session_id、execution_epoch、部署版本、磁盘身份 | 托管 Store；VM 保存已验证副本 |
| HostedBindingJournal | 引导阶段收据、执行许可、seal 与 shutdown 收据 | VM 持久状态目录；控制服务保存已收到的收据 |
| Session / Control | 输入、Goal、历史、审批、问题、模型设置、执行事实 | VM 内原 Store |
| RuntimeObservation | 上述 Session 的可丢弃投影，附来源 revision 和观测时间 | 托管查询缓存 |
| OperationReceipt | 接纳身份、指纹、状态、结果/错误与阶段身份 | 托管 Store；下游副作用使用相应阶段收据 |

`owner_id` 来自认证，不接受客户端指定。TaskSpec 描述**初始配置**，不会在每次恢复时覆盖用户后来通过原 Host 修改的模型、Goal 或上下文设置。

新任务不沿用另一个任务的 Session ID。导入选定历史是独立导入流程：绑定来源切点，清理执行许可与未完成控制身份，不把旧审批、问题或正在运行的 Goal 直接迁入。阶段一只支持新任务与显式选定材料；运行中会话迁移不支持。

所有 ID 是服务端或客户端预生成的 opaque string；禁止解释成文件路径。`revision`、`execution_epoch` 和持久 cursor 的整数在线协议中使用十进制字符串，避免 JavaScript 大整数精度损失；内部可用检查溢出的整数。

v1 的命令 ID 非空、最多 128 个 ASCII 字节，只允许字母、数字、下划线、连字符和点，且不能以点开头。它们不是用户标题，也不能用来拼接未经校验的目录。版本化引用由 `id` 和 `version` 组成；服务端返回的精确版本不得被客户端改成“最新”后重试。

## 4 提交契约

协议名为 `xharness-cloud/v1`，字段统一使用 snake_case。它与原上游 camelCase 会话协议分别解码，禁止靠全局字段转换混用。

### CloudTaskSpec

| 字段 | 必要性与语义 |
| --- | --- |
| environment_ref | 必需，引用用户已授权的环境及配置版本，不接受任意地址作为授权 |
| objective | 必需、非空的用户任务目标；纯空白非法 |
| acceptance_criteria | 可选字符串列表；缺省为空，不自动增加提交、推送或部署要求 |
| workspace_source | 必需的判别联合，见下文 |
| selected_material_refs | 可选附件/材料引用；必须属于当前用户且已完成上传验证 |
| model_config_ref | 必需，引用带版本的 Provider 部署配置；复用原模型路由与能力发现 |
| credential_ref | 必需，引用已授权的模型凭据；不含密钥值 |
| permission | v1 必须为 `full-access`，不能因为环境能力不足自动改成另一权限 |
| system_privilege | `standard-user` 或 `sudo`，默认普通用户；sudo 需独立环境授权 |
| resource_policy_ref | 必需的环境资源策略引用；应区分硬约束和仅可观测的指标 |
| stop_policy_ref | 必需，明确正常清理期限、是否授权 VM 外强停和失败后的处理方式；不能只以 Full Access 推断强停授权 |
| usage_policy_ref | 可选的 Token/成本策略；没有精确 Usage 时必须显示未知或估算来源 |
| retention_policy_ref | 必需，明确 VM、磁盘、附件与产物的保留方式 |
| notification_policy_ref | 可选，不配置时仅保留任务内待办，不声称已外部通知 |

`workspace_source` 的 v1 变体：

- `git_revision`：仓库引用与固定提交，另可选已验证的未提交补丁/新增文件包。凭据只用引用；无补丁时明确不包含本机未提交内容。
- `uploaded_bundle`：已验证对象引用、清单摘要和解包策略。上传、校验与任务提交分开。
- `existing_workspace`：环境登记过的工作区引用与预期指纹，不接受任意本机绝对路径，也不覆盖不匹配的旧目录。

提交时解析配置和凭据版本并持久绑定，重试不能自动漂移到新的默认版本。正常运行中改模型继续走原 Host 路径，新的凭据版本也必须有相应授权。

v1 不重新定义固定 Goal 轮数，也不用 `u64::MAX` 假装无限。当前基线 `rpc/goal.rs` 的 Create 在缺字段时默认 256；引导实现必须识别并展示宿主真实 Goal 策略，不能声称支持无限再隐式落入该默认值。若要支持不同策略，需要先通过 Goal 既有契约和能力门禁，而非在云层偷偷修改轮数。

### 限额与验证

服务端通过 Describe 暴露并执行请求字节、目标文本、材料数量和上传大小限额；客户端不得假设无限。限额影响接纳，不允许静默截断目标、源文件、附件或已授权材料。超限返回明确错误，不能用工具结果裁剪策略裁剪提交包。

请求字段和判别联合必须严格校验，未知或相互矛盾的权限/配置字段拒绝。密钥字段、云管理 token 和客户端 owner 字段不在此 Schema 中。不可把任意 `serde_json::Value` 全量传入 Host。

## 5 协议与操作收据

### 外层调用

每个有副作用的托管操作包含：

```json
{
  "protocol": "xharness-cloud/v1",
  "request_id": "opaque-stable-request-id",
  "method": "task.cancel",
  "payload": {"task_id": "task_example", "expected_revision": "7"}
}
```

上例表示取消一个现有任务；提交使用 `method=task.submit` 和 `payload.spec=CloudTaskSpec`。影响既有 TaskRecord 的命令必须携带 expected_revision；查询、open_session 和首次 submit 不使用 TaskRecord 写入 CAS。版本化引用和 TaskSpec 的完整 JSON fixture 在 DTO 实现阶段冻结。

建议 HTTP 承载为 `/cloud/v1/commands`，状态查询与 Describe 单独提供读取入口。不得将新方法加入旧 `RpcMethod::ALL` 或改动封闭的旧错误码集合。

Describe 必须返回协议版本、操作/能力集合、限制、去重保留规则与客户端功能要求。客户端只在共同支持的版本上执行；不能协商时返回 version_unsupported 并保留只读错误入口，不“尽力”把不兼容字段传给旧 Host。核心请求字段改变需要新协议版本，附加只读元数据不改变原字段语义。

### 操作集合

| 操作 | 行为 | 复用或新增 |
| --- | --- | --- |
| task.submit | 持久接纳，生成 task_id 和准备操作 | 新增托管命令 |
| task.get / list | 查询任务和带来源的运行投影 | 新增只读 |
| task.open_session | 返回短期、任务限定的连接授权 | 新增连接操作，不启动第二个 Agent |
| task.cancel | 请求终止持续执行，进入结算 | 新增托管命令，调用原停止链 |
| task.collect | 对终态封存切点生成文件/历史恢复包或产物索引 | 新增外层编排，不复制原历史投影 |
| task.release | 释放终态任务环境，按保留策略保留数据 | 新增托管命令，不等同于删除历史 |
| environment.register / inspect | 登记身份，探测能力和占用 | 新增环境操作 |
| environment.prepare / stop | 任务限定的准备和停止 | EnvironmentBackend 的内部操作，不接受用户绕过 task.cancel 停活动环境 |
| session / Goal / question / Steering | 原会话控制 | 通过认证 Gateway 复用原 API |

永久删除、运行中迁移、终态原地重启、云外部账号共享与新的模型工具不属于 v1。

### 收据

持久收据包含 `request_id`、`operation_id`、`task_id`（适用时）、`method`、`payload_fingerprint`、`status`、`accepted_revision`、`result_ref/error`、创建和更新时刻。`status` 为：

- `accepted`：已持久接纳，尚无执行结果。
- `running`：阶段执行中。
- `needs_reconcile`：外部操作响应未知，需要核对已有资源/阶段收据，禁止盲重试。
- `applied`：已验证应用结果并持久提交。
- `rejected`：已确认未执行的业务拒绝。
- `failed`：已知执行失败；附带已产生副作用与清理情况，不能理解为零副作用。

接纳身份作用域为 `(owner_id, request_id)`。先校验权限，再查收据，命中后比较 method 和经 v1 规范化的 payload 指纹：

1. 同身份同指纹返回原收据，即使当前 revision 已变化；不能再次因旧 CAS 拒绝已成功的命令。
2. 同身份不同方法或内容返回 `idempotency_conflict`。
3. 首次接纳时验证 expected revision、能力与归属；任务变化、收据和 outbox 阶段意图在同一持久事务提交。
4. 未确认持久提交前不返回 accepted。第一次接纳后的网络超时只允许用同身份查询/重发。
5. 指纹只由服务端基于冻结的规范化 DTO 计算，不含实际密钥；默认值、列表顺序、null 与省略的等价规则须有黄金 fixture。v1 显式排序对象键、保留文本和列表顺序、补齐默认字段；`Option` 的 null 与省略等价，列表缺省等价于空列表但不接受 null。Hash 输入为 `xharness-cloud-fingerprint/v1`、换行和规范化 `{method,payload}` 的 UTF-8 JSON，不含 request_id。升级不能重算旧收据指纹再比较。
6. 收据不能按 UI 缓存策略淘汰。v1 删除任务数据后仍保留最小的 owner+request ID、指纹和终态 tombstone；不能按短 TTL 删除这些身份后把旧提交当新命令。未来有限去重窗口需要可验证的提交期限和明确过期拒绝，不能只淘汰 Map。

操作幂等是接纳和编排保证，不是 Git 推送、付款或任意网络请求的恰好一次保证。

### 错误集合

新增协议独立错误包括 `invalid_request`、`unauthenticated`、`not_found`、`forbidden`、`version_unsupported`、`idempotency_conflict`、`revision_conflict`、`capability_unavailable`、`environment_busy`、`quota_exceeded`、`configuration_unavailable`、`ownership_unverified`、`runtime_unavailable`、`outcome_unknown`、`cursor_expired`、`cleanup_incomplete`、`storage_failure`、`internal`。

对其他用户的 task/environment 统一使用 not_found，不泄露其存在。错误附 `operation_id`、已知阶段和 retry hint，但 retry hint 不能把 `outcome_unknown` 自动转成重新执行。

## 6 Task 状态机

Task 生命周期与 Goal、环境、观察连接分别维护。Task phase 固定为：

```text
accepted → provisioning → attached → settling → finished
       └───────────────────────→ settling → cancelled
       └───────────────────────→ settling → failed
```

`settling` 中保存 `requested_outcome`、请求原因、执行封存状态、停止证明、清理与数据保留结果。用这个中间态统一表达完成、失败和取消的结算，避免三条路径各自漏掉进程清理。

| 当前状态 | 输入事实 | 结果 |
| --- | --- | --- |
| accepted | 准备阶段意图已持久接纳 | provisioning |
| accepted / provisioning | 用户取消或已知准备失败 | settling；停止/核对可能在飞的准备操作 |
| provisioning | 排他绑定、VM Ready 和 prepared 引导收据已验证，控制侧执行授权已持久提交 | attached；以原身份派发激活操作 |
| attached | 用户暂停 Goal、提问等待、网络中断、暂时模型失败 | 保持 attached，更新有来源的运行/连接投影 |
| attached | 当前 Goal 已按原规则验收，原会话允许封存 | settling(finished) |
| attached | task.cancel 已持久接纳 | settling(cancelled) |
| attached | 确认无法继续且需要终止任务的永久故障 | settling(failed) |
| settling | 有效封存和停止证明，已满足数据保留条件 | 对应终态 |
| settling | 停止超时、清理失败、响应未知 | 保持 settling，显示具体阻塞原因；不得伪报终态 |
| finished / cancelled / failed | 新的恢复/执行请求 | 拒绝；可新建后续任务，保留旧记录 |

补充规则：

- 运行投影中的 paused/blocked/awaiting_confirmation 不是 Task failed；普通 TurnEnd 也不是 Task finished。
- 首次正式执行激活时将 task attached 和 binding 的执行许可写入控制事务，再交付可恢复的激活意图。VM 未收到时表现为 attached + starting；不为 UI 的即时 running 假造已开始。
- submit 的 applied 收据需要 VM 的实际激活收据；仅 attached 不能伪报激活成功。激活永久失败进入 settling(failed)，临时丢回执先查询原操作。
- 任务启动成功后暂时重连或同 VM 恢复仍保持 attached，另显示 recovering，不回到 provisioning 创造新 Session。
- 没有执行者的准备失败可用经过核对的 `not_started` 证明结算，但“尚未收到 Ready”本身不是没有执行者的证明。
- settled 事实只允许当前 binding/epoch 产生；旧 epoch 或旧 Session 的消息不能改变当前状态。
- 用户取消在终态 CAS 提交前被接纳时，将 requested_outcome 设为 cancelled，优先于尚未提交的 finished/failed；已验收的成果和故障事实仍保留。
- 如果终态提交先赢，之后 cancel 返回已终结的无操作结果，不改历史；同一 cancel 身份仍重放其原收据。
- 终态 cancel 是读取式无操作，即使客户端观察的 expected_revision 已过期，也返回当前终态；活动/结算任务的首次 cancel 仍严格执行 CAS。
- 用户新消息与自动完成竞争时，先封住并核对原 Host Admission；已经接纳的用户工作不能被悄悄丢弃。消息先接纳则暂缓完成；封存先成功则新执行请求明确拒绝。

## 7 环境能力与所有权

环境健康状态为 `preparing / ready / degraded / stopping / stopped / failed`；占用状态为 `unbound / bound / releasing / released`。二者不是同一个枚举：degraded 不释放所有权，stopped 不自动允许其他任务挂载磁盘。

EnvironmentCapabilities 至少声明：

- 专用隔离环境身份、Linux/架构、受支持 Host 版本。
- 持久工作区与状态卷能力、卷实例身份及单写者限制。
- 正常用户 Full Access、sudo 授权和实际网络路径。
- VM 外停止能力以及 stop proof 来源；只有 SSH 不代表可以在 VM 坏掉后强停。
- CPU/内存/磁盘限制分别能否在 VM 外强制执行，不把仅监控的指标标成硬限额。
- 到模型端点、材料源与必要服务的可达性；未测为 unknown，不伪造成功。
- 部署、工作区恢复包、续接和保留能力。

每项能力使用 `supported / unsupported / unknown` 和约束/观测时间。提交要求与实际能力不匹配时在执行前拒绝，不静默升级权限或降级承诺。

v1 的 sudo 环境必须提供已授权、可验证的 VM 外 Stop；只有 SSH 的环境不接纳无法兜底停止的系统级任务。普通用户路径仍需要受管进程/服务范围的清理能力，不把“能登录机器”直接当成已合格环境。

v1 要求一个任务独占一个 VM 执行环境。准备前在托管 Store CAS 绑定 task、环境实例、持久卷和 execution_epoch；VM 应验证绑定 manifest，再使用原本机 FileLease。环境模板不是环境实例，模板变更不能改变正在运行的任务。

只允许单活动控制写者。其排他机制必须覆盖控制服务启动与后台 reconcile；运行第二个服务不能同时消费 outbox。支持多实例控制服务需要额外控制写者租约或数据库机制，阶段一不把本机锁包装成集群方案。

同 VM Host 重启保留 execution_epoch，以持久实例收据核对新进程；只有执行环境更换才增加 epoch。跨 VM 接管必须先验证旧 VM 已停、旧授权封存和磁盘排他，缺一项返回 ownership_unverified。心跳超时不具备这些证明。

Host 进程每次启动生成独立 runtime_instance_id，用于健康与实时事实的来源校验，不替代 execution_epoch。HostedBinding 在初始化前取得并持有同状态目录的进程排他锁直到退出；不能只等首个 Agent 激活时才用 FileLease 发现第二个 Host。旧进程的实时健康/运行状态不能覆盖新实例，但同一 operation ID 的持久阶段收据仍可按身份验证。

EnvironmentBackend 接受带 task/binding/stage operation ID 的 Prepare、Inspect、Stop、Collect、Release 请求，返回结构化事实。派发前必须持久记录稳定 stage operation ID；超时后 Inspect 或查询原阶段身份，不能新建 ID 再 Prepare。无法查询未知结果的适配器不允许自动重试该副作用。

SSH 登录密钥只由控制侧适配器持有，使用正常主机身份校验；不转发 SSH agent、不禁用 known-host 验证、不把登录密钥注入模型。

## 8 VM 引导与执行许可

### HostedBindingJournal

VM 的绑定日志至少保存 task/binding 身份、manifest 摘要、部署/协议版本、完成的阶段收据，以及执行许可：

- `prepared`：可初始化和读取，禁止自动模型执行。
- `active`：该任务已得到持久执行授权，允许原 Runtime 按自身规则推进。
- `sealed`：终止新执行；保留读取与收据查询，不因重启恢复为 active。

缺失、损坏或身份冲突不能当成 fresh active。已接纳的取消 seal 不等待所有工具结束后才写入；先落盘，再停止，避免崩溃重启又推进。

同一 execution_epoch 的 sealed 不可恢复为 active。封存先到、旧激活后到时旧激活必须拒绝；阶段身份和持久许可 revision 要验证，不能按网络到达顺序覆盖状态。控制服务已接纳 cancel 但 VM 尚未收到 seal 时，UI 明确显示“取消等待执行端接纳”；不能承诺网络分区期间已经停止。

### 引导步骤

1. 探测环境，绑定 task、执行世代和持久卷，生成版本固定的 manifest。
2. 校验并准备工作区；上传未完成或指纹冲突不启动模型。
3. 注入带授权版本的模型凭据，启动处于 prepared 许可的完整 Host-app。
4. 恢复原 Control/模型配置和 Session 状态，返回区分 Live/Ready 的事实；不能用监听端口成功代替恢复完成。
5. 用持久阶段身份创建根 Session、导入已选择的材料，并通过原 Goal 领域入口创建/启用目标。初始推进只有一个来源，不同时注入重复普通 prompt 再启用同一目标。
6. Controller 持久接纳附着与执行授权后派发激活操作，VM 持久记录 active，唤醒原 Runtime 并返回应用收据。

每步在 VM 或控制侧查询稳定收据后可重入；不会伪装成跨机器一次原子事务。引导未完成时发现无法由收据解释的 Session/Goal 冲突，或 manifest 不匹配，应保留诊断，不自动创建同名目标掩盖损坏。已完成引导后的正常用户编辑、清除 Goal 或切换模型以原 Host 日志为准，不反复与初始 TaskSpec 比较后回写旧目标。

具体实现要补窄的 Host-app 组合钩子，不能只拿普通公网 RPC 拼接上述步骤：

- 安装/查询 binding，返回阶段收据和能力。
- 在恢复、Claim、模型/工具执行入口校验执行许可，复用原 Admission、Supervisor 和运行控制边界。
- 激活、封存、持久查询关闭结果；这些内部管理请求不用客户端的 Session 权限授权。

Host 内后台路径必须受同一许可约束，包含自动标题/Compact 等辅助模型请求和新建后台进程。sealed 后只允许结算、清理与只读投影；不能通过辅助请求继续消耗额度。允许已经接纳的在飞操作完成或取消，但记录其真实状态。

## 9 终态封存与停止证明

仅有 `session.cancel`、一个进程退出码或一条 Debug 日志不能证明整个托管执行已停止。

结算顺序为：

1. 控制服务 CAS 写入 settling 与稳定停止 operation ID。
2. VM 持久 sealed，封住新执行与自动恢复；结算完成路径需验证最新 Goal 验收和输入边界，不能拿旧投影替代。
3. 复用原 Runtime 的结构化 Shutdown，停止 Provider、工具、子 Agent、Job、PTY、后台监听和辅助工作。
4. 持久保存 shutdown receipt：binding/epoch、源 Session revision、许可状态、受管任务结算、强制清理数、清理错误和未知结果。
5. 核对任务拥有的执行范围确实静止，生成数据保留收据；控制服务验证同一停止身份后提交终态。

证明类型包括：

- `not_started`：准备操作已收敛且确认无任务执行者。
- `graceful`：原 Shutdown 与环境任务范围检查均通过，无未说明的活动执行。
- `forced`：具备权限的 VM 外控制接口已经验证该 VM 停止；记录未知结果和强制清理，不能显示为安全正常结束。

普通 Guest 内收据不能证明获得 root 的任务没有另启 VM 系统服务。若无法核实静止，应保持 cleanup_incomplete，或在用户授权和环境能力允许时用 VM 外 Stop 取得 forced 证明。不能在 root 权限下把单一 PID 消失宣传为全环境静止。

停止超时应返回可查询操作状态和下一处理方式，不无限挂住 HTTP。外部停止失败、控制通道断线或磁盘写入失败仍保持 settling。终态任务恢复时使用 sealed/read-only 模式；重建只读 Host 不启动 Goal、Schedule 或历史输入。

## 10 连接与 UI 边界

RuntimeConnection 区分 `local` 与 `hosted`，连接描述只包含连接授权、task/session 身份、协议版本、API 基址与客户端能力，不含模型 Key。

Gateway 必须校验 owner、task、binding/epoch，并限制根 Session 及由 Runtime 证明归属的子 Session。仅过滤根 Session 会破坏 Subagent；直接信任用户填写的子 ID 又会越权。设置、文件、附件、历史和导出同样受任务边界限制。

- 首次连接、重连和切换任务均以权威历史/状态 cut 校准 UI。
- Task 管理事件 cursor 与 Session seq 分开；事件含作用域、revision、绑定世代和来源，旧世代事件丢弃。
- 临时 stream delta 不是持久 cursor。流中断后清理/替换临时显示，再对齐权威投影，不重复追加已显示字符。
- cursor 过期必须显式触发重新同步。WS 同步失败不让模型重发同一副作用。
- 用户命令接纳与模型已应用分别表示；普通 turn 的 applied 身份仍由原 Host 决定，Gateway 不根据 TTFT 或文本猜测。
- 网络重试必须保留原命令 ID。关闭连接不会调用 task.cancel。
- 过慢观察者使用有界队列与重新同步信号，不影响 Agent 生命周期或形成无界 Delta 缓冲。
- 模型流断线沿用原 Provider 的重试限制；托管重连不是重新发起模型请求。

UI 保留原会话、GoalBar、问答和工具卡片，只增加远程徽标、环境名、连接状态和托管操作。远程路径不映射成本机路径；文件/图片/附件通过明确上传下载引用访问。Computer Use 按 VM 实际能力投影，不因 Mac 客户端支持就在 Linux VM 暴露本机屏幕控制。

### 10.1 已落地的执行环境入口（2026-10-02）

新任务输入框上方的环境选择器与工作区并列，通过产品 Client Slot 注册，Web 与
Tauri 使用同一生成包。菜单始终可以展开查看，复用 Client Menu 并显示不可选原因；
绑定锁限制选项，不禁用查看入口。只有可信空会话（包括 cold 空会话）可选本机；
已有内容、运行中、历史加载中/失败或状态未知时不允许切换。
数据未就绪时不能把缺少历史当成新任务。

本切片仅保留本机路由。统一的 Cloud 选项仍待接入且不可选择，不展示机器名称，**不是环境目录的
可用性声明**。不持久化一个假的 hosted 绑定，不传厂商 Key，也不改变工作区目录服务。
真实目录、RuntimeConnection、提交边界的唯一绑定与跨环境工作区隔离仍待 Gateway
接线。UI 提供选项不等于控制器已经接纳/激活任务。

初始完整任务版本固定；运行中不由桌面自动更新器替换远程 Host。维护前先达到静止点、保留恢复材料并通过存储/协议版本检查；不能自动降级写已经升级的数据目录。

## 11 存储与生命周期策略

控制侧 Store 至少原子维护 TaskRecord、OperationReceipt、环境绑定、阶段 outbox 与生命周期事件，支持 expected revision CAS、flush、按稳定身份查询和重启 reconcile。具体数据库在实现时选择，不给核心暴露 SQL。

VM 保留原 Session/Control/附件对象，以及 HostedBindingJournal。工作区和状态存储在任务绑定的持久卷；诊断和构建缓存独立有界，不把每轮完整上下文复制到控制侧数据库。

使用双端阶段收据恢复分布式步骤，不用两个文件写成功就宣称跨系统事务。状态与源文件的导出须封存/静止后绑定 Session revision、文件清单、Hash 和部署版本；运行中的两份快照不能声称一致。

v1 的一致恢复包 collect 仅对终态任务开放，使用已经 sealed 的切点，不需要临时解除封存。运行中允许通过原文件/附件接口取回已存在的产物，但必须标明它不是一致恢复快照；暂不提供会改变执行许可的“边跑边迁移”入口。

等待用户、Job 或定时事件仍由原 Goal 决定。默认不因为 waiting 关闭 VM；可停机条件必须证明没有必要运行进程且恢复材料已持久。暂停 Goal 不代表基础设施停止计费。

释放前验证 task 已终态、执行已停、数据保留收据有效。删除只丢弃缓存/临时资源或经过明确授权的数据；不同用户之间重新分配环境必须清理旧凭据、数据与访问授权。模型 Key 的真正撤销依赖供应商或用户操作，删除本地注入副本不等于失效。

## 12 验收矩阵

以下是完整产品需要实现的验收，不是全部已通过的测试。领域/Fake、持久控制核与专属环境的实现范围分别见第 14、15 节；纯归约测试与真实适配器使用同一输入/预期矩阵，不让测试期模型接管生产调度。

| 用例 | 必须证明的结果 |
| --- | --- |
| CLOUD-T01 重复提交与内容冲突 | 同 owner+ID 仅一个 task；不同内容拒绝，其他 owner 互不命中 |
| CLOUD-T02 丢失接纳响应 | 原收据可查询；不增加 VM/Goal |
| CLOUD-T03 并发 CAS 与 outbox | 状态、收据、阶段意图原子提交；服务重启不重复派发未知副作用 |
| CLOUD-T04 Prepare 成功后断网 | 查询原阶段身份，不能再建环境 |
| CLOUD-T05 每个引导阶段崩溃 | 恢复正确阶段，Session/目标/初始输入不重复 |
| CLOUD-T06 配置版本漂移 | 重试用已绑定初始版本；恢复不覆盖用户新设置 |
| CLOUD-T07 未授权和能力未知 | 无副作用；错误不泄露其他用户任务或密钥 |
| CLOUD-T08 Live 与 Ready | 未恢复完成不激活模型；端口存在不当作 Ready |
| CLOUD-T09 prepared/sealed 的后台唤醒 | Goal、Schedule、子 Agent、辅助请求不绕过许可 |
| CLOUD-T10 网络与多观察者 | 关闭页面不取消，慢端有界，cursor 过期重新同步 |
| CLOUD-T11 Delta 与持久历史 | 重连/刷新不丢已持久内容，不重复追加，不伪造 chunks cursor |
| CLOUD-T12 用户输入与完成竞争 | 已接纳输入不被吞掉，封存后新执行明确拒绝 |
| CLOUD-T13 取消与完成竞争 | CAS 决定终态，取消已接纳后不能再悄悄完成 |
| CLOUD-T14 取消中服务崩溃 | sealed 与停止身份恢复，旧 activate 晚到不能解封，原 Goal 不重启 |
| CLOUD-T15 清理失败与 Stop 超时 | 保持 settling，返回 cleanup_incomplete，不能报告 cancelled |
| CLOUD-T16 VM 外强停 | 身份/epoch 匹配，确认已停才 forced；保留未知结果 |
| CLOUD-T17 旧 epoch 与双 VM | 拒绝旧结果；未取得排他停止/磁盘证明不接管 |
| CLOUD-T18 工具在飞时重启 | 原 outcome_unknown 保护生效，不自动重复非幂等操作 |
| CLOUD-T19 问题与审批恢复 | 迟到/重复/跨用户回答正确结算，UI 与权威历史一致 |
| CLOUD-T20 上传/路径/附件 | 穿越、符号链接、损坏对象和本机路径误用不进入工作区 |
| CLOUD-T21 收集与释放 | 活跃执行禁止一致导出，release 保留已承诺数据 |
| CLOUD-T22 满盘与损坏真源 | 停止新工作并显示错误，不当空历史重建任务 |
| CLOUD-T23 终态读取与版本更新 | read-only 恢复不执行；不兼容版本拒绝维护/降级 |
| CLOUD-T24 实测与未知额度 | 缺 Usage 不当零，硬限制能力不足不能宣称强制计费上限 |

Rust DTO/状态机和 Host 适配回归只在远程编译。默认 `WZU_Server`；不可达报告阻塞，不自动回退 Mac 或其他机器。完整 VM/Full Access/外部停止验收需要用户指定的专用测试 VM，不能把共享服务器新目录当 VM 隔离。

真实 DeepSeek 验收先通过离线套件，再跑多轮编程任务，包含 Job、用户改范围、问题回答、本机观察断线、Host 恢复和终态清理。独立验收运行测试、核对文件、去重身份、资源峰值和收据；不把模型口头完成当测试成功。成果与关键证据保留，但不输出密钥。

## 13 交付切片

1. 本规范、总 TODO、边界与故障矩阵。**已完成设计。**
2. DTO、纯归约器、Memory Store、Fake Environment 与确定性契约测试。**已完成领域基础；无部署、无真实密钥。**
3. 持久 Store/outbox 与已有 VM 适配；逐阶段收据和单执行者测试。
4. Host-app 引导许可、原 Goal 接入、停止证明和只读恢复；补未实现的窄生命周期接口。
5. 鉴权 Gateway、客户端 RuntimeConnection、原 UI 接入与重连/多观察者回归。
6. 专用 VM 与真实模型验收，CI 后再提供发布/部署候选。
7. 自动云 VM、模板/备份/回收适配器。跨 VM 自动故障转移另设停止 fencing 门禁，不顺便塞入基础版。

各切片先补失败 fixture，再实现，再跑受影响模块与全量回归；不能因为 Fake 环境测试通过就把真实 VM 适配或恢复标成完成。

## 14 CLOUD-01 历史切片边界与证据

源码入口：[`xharness-cloud`](../../crates/xharness-cloud/src/lib.rs)。没有生产 crate 依赖它，未修改现有 Host/Core、模型工具、旧 RPC、Session JSONL 或桌面启动路径。

| 模块 | 已实现 | 明确未实现 |
| --- | --- | --- |
| `contract` | Submit/Cancel 强类型 DTO、版本/ID/十进制 Counter/固定 Git 提交/三种工作区来源校验；未知字段、重复字段、超限拒绝；版本化 SHA-256 指纹 | HTTP 入口、Describe 服务、配置/材料/凭据的实际授权与解析 |
| `state` | 纯 Task 归约、完成/取消 CAS 语义、结算证明门禁、旧 binding/epoch 拒绝、纯 Permit 单向迁移 | 验证真实 Goal/Admission/Shutdown 收据；磁盘 journal；在 Host 后台路径实际强制许可 |
| `store` | 单进程 Memory 事务：Task/Receipt/环境与卷预留/阶段意图一起接纳；同身份重放先于 CAS；保留未知阶段身份 | 持久事务、服务重启恢复、单控制写者 fencing、自动 outbox 派发、release 后重新分配 |
| `environment` / `testing` | 环境能力三态、sudo 的外部停止授权门禁、异步 Backend 端口；Fake 准备/停止/收集/释放，成功丢回执、未知结果与已知失败 | SSH/云 SDK、真实 VM 所有权探测、凭据传输、实际部署或进程停止 |

固定样本：[`submit-v1.json`](../../crates/xharness-cloud/tests/fixtures/submit-v1.json) 与独立 Python 计算的 [`submit-v1.sha256`](../../crates/xharness-cloud/tests/fixtures/submit-v1.sha256)。它们使用示例引用，不含真实凭据。默认接纳限制为请求 256 KiB、目标 64 KiB、单条验收 8 KiB、验收/材料各 64 项；这些是可配置的提交限额，不是模型上下文或 Goal 轮数限制。

阶段意图区分 `pending/running/needs_reconcile/verified/known_failed/quiesced`。Unknown 不可退回 Pending/Running，待处理列表中的 Unknown 只允许核对；取消后旧 Prepare/Activate 不再出现在待处理列表，但身份仍保留给 Settle 核对。终态后也保留环境与卷预留，不自动放给其他任务。

Memory Store 的 owner 必须来自未来认证组合，登记环境与策略来自可信控制配置；仅“传入 owner 字符串”并不提供网络鉴权。TaskFact 中 Ready/Goal/封存/停止的布尔证据只能由未来已验证适配器提供，不向模型或客户端开放。纯状态机接受一个证明，不能证明真实 VM 已停。

2026-10-01 在 `WZU_Server` 运行：

- `cargo test --locked -p xharness-cloud --all-targets`：**52 passed，0 failed**（契约 11、接纳 14、生命周期 20、Fake 环境 7；全工作区测试也包含这些目标）。
- `cargo clippy --locked -p xharness-cloud --all-targets -- -D warnings`：通过。
- 37 crate 内部依赖边界与 4 项架构检查器回归：通过。
- 全工作区 Check/Test、进程 Drop 清理与七组 UI 契约通过；完整 `full` 套件仍有一个失败项：全量 Clippy 被已有、未跟踪的 `crates/xharness-coding-tools/tests/edit_mode_ab.rs:55` 的 `&PathBuf` lint 阻挡。本次没有改动该独立实验文件，没有把全量门禁标为全绿。

覆盖 CLOUD-T01、T02 的内存收据、T03 的单进程接纳/CAS、T04 Fake 丢回执、T06 初始版本、T07 能力与 owner 隔离、T08 Ready 门禁、T12 完成前输入证据门禁、T13 终态竞争、T14 单向 Permit、T15/16 停止证明门禁、T17 旧世代及独占预留、T21 Fake 收集/释放顺序、T23 部分版本拒绝。**不等同于这些编号的完整真实适配器验收**：例如 T03 的重启 reconcile、T09 的所有 Host 后台路径、T14 的磁盘崩溃恢复、T20 的真实包穿越验证和 T22 的满盘均待后续切片。

上述为 CLOUD-01 当时的切片证据：当时没有执行真实模型调用或创建 VM。后续真实 VM 与持久控制进度见下一节，不能把本节历史表格当作最新状态。

## 15 CLOUD-02/03 当前实现与未接入边界

### 15.1 持久规则复用

新增 `xharness-cloud-app`，内部只依赖 `xharness-cloud`；不依赖 Host、Core、Provider 或 Tools。领域 Store 同一接纳/CAS/事实规则支持可选 `CloudCommitSink` 和校验过的 `CloudSnapshot`，SQLite 适配器不重新手写状态机。

SQLite `control.sqlite3` 使用 schema 1、application ID、WAL、FULL；原子提交增量环境/Task/Receipt/outbox/持久 ID/generation。只更新变化行，不反复写整份全局快照或完整会话。单本地 writer 锁跟随最后一个 state clone 存活；它不是分布式任务所有权证明。

持久提交在内存发布之前；提交结果不确定时 fence 全部状态访问，重新打开并核对。恢复校验序号与行主键、owner、版本、原绑定、环境/卷预留、阶段意图与终态证明。空/损坏/未知版本真源拒绝，不自动创建空库“修好”。

### 15.2 重启核对与取消竞争

`CloudController` 有界并发、每 Task 串行、每 tick 最多四个阶段操作。Pending 派发前先持久 Running；Running/NeedsReconcile 重开后只 query 原身份。超时或 inspect 无收据保持未知，不换 ID、不盲执行。

外部阶段收据先不可变落盘，再转成状态事实；重启在中间时重放本收据。取消后的旧 Prepare/Activate 仍可查询，迟到 Prepare 不产生 Activate，迟到 Activate 只记录发生过执行，不解封，不把取消改成完成。Settle 必须校验封存/停止/保留证明；部分事实已提交后的重启复用同一证明。已知清理失败仍保持 settling，缺回执不是“没有执行”。

阶段故障由测试适配器注入；新增 `NativeStageExecutor` 消费原 Host 的准备和激活收据。**生产 VM 生命周期、材料/凭据解析、常驻控制服务尚未接**。管理 CLI 只有可信本地/SSH 身份，owner 参数不是网络鉴权。

### 15.3 专属环境而非任务恢复

实验 VM-1 转为长期专属测试环境，复用原 UUID/SSH/持久盘，人工启停、停止保留数据、宿主重启不自动起 VM。资源限制、原 Host/session API、SSH 重新连接、Host 重启、客体 reboot、外部停止/冷启动均实机核对。专属 VM 无限运维时长使用 `RuntimeMaxSec=infinity`，修复本机 systemd 的 `0` 立即超时；四 VM 实验 TTL 不变。

原 VM 内 `standard-user` 权限隔离、任务许可/Stop 收据、材料/凭据注入均未完成。真实 SQLite 仅登记已证实环境身份；任务所需能力未验证则保持 Unknown。实际 canary 接纳失败、零 Task、零密钥注入。不能凭“端口 Ready”把这些能力填 Supported。CPU 亲和性非 quota、虚拟盘大小非宿主配额。

### 15.4 本次证据

- `WZU_Server` 定向：领域 56、持久化 14、核对器 14，**84 passed，0 failed**；异常退出 fixture 由父测试实际启动，子进程绕过 Drop 后重开 WAL 验证。
- 两 cloud crate 的 Clippy `-D warnings`、最新源码全工作区 Test 通过。全量 Clippy 的独立旧实验 lint 限制不在本次宣称通过范围，GitHub 跨平台 CI 尚未跑。
- Python：四 VM 实验 15 guard、专属环境 16 guard 均在 V100 通过；专属 VM 9 实机验收通过；真实控制库登记/重开/重复登记/Unknown 能力拒绝通过。
- 全部四 VM 已核实停止，保留磁盘、阶段收据、成功与失败报告；不改原模型服务、不替换 App/Web。

手册：[专属环境](../runbooks/cloud-dedicated-vm.md)、[四 VM 实验](../runbooks/cloud-vm-lab.md)、[持久控制适配器](../../crates/xharness-cloud-app/README.md)。

**完整交付仍需 CLOUD-02c/03c/04b2/05b/06/07/08**：生产生命周期、材料/凭据版本授权、可信恢复授权/终态核对、网络认证与观察、客户端与原 UI。原生门禁首切片和后续唯一 Goal 引导见下文；受限真模型 fixture 不能当作生产 Submit/凭据授权验收，不宣称五步产品链路全部交付。

## 16. 原生 Host 门禁首切片（2026-10-01）

新增 `NativePermitJournal` 与可信管理 CLI；组合根以 `--hosted-permit-dir` / `XHARNESS_HOSTED_PERMIT_DIR` 选择 Linux 托管门禁。`xharness-host` 只增加中立 `ExecutionGate`，不依赖云或 SQL；Provider/Tool/普通及自治入口共享此门禁。没有改 RPC 协议、没有另起模型 Loop。

本节记录当时不带 bootstrap manifest 的 Prepared：它是**原生 dormant 启动许可**，不是控制协议中的 bootstrap prepared / Host Ready；不能混用名称补齐 `TaskFact::Prepared`。后续可选完整 Prepared 引导见第 17 节；根/子会话 Gateway 仍待接入。Native Runtime 停止收据始终不等于整个 VM 的 quiet/retention 证明。

临时 graceful stop 可以同 Binding 再启动新 generation；异常退出/无 stop proof/清理失败不自动 claim 下代，需外部核对。未加可信恢复授权前，拒绝“重开 journal 就继续”的做法。

详见[原生接线手册](../runbooks/cloud-native-execution-gate.md)。完整 CLOUD-04/05 不因这个历史切片完成而打勾；当时没有注入真实模型凭据。

V100 使用隔离源码与 Cargo target 完成全工作区测试：1041 passed、19 ignored、0 failed；四个接线模块的全目标 Clippy 通过。新增原生 journal 21、Host gate 4、Runtime 1、Host-app 3、原生进程 fixture 6 项包含在总数内。Python guard 34 项、专属 VM-1 内 8 项原生门禁验收通过；随后从宿主核实四 VM 全部停止，磁盘保留。证据、等待时间含义与未覆盖项见[验收报告](../reports/cloud-native-execution-gate-20261001.md)。没有进行真实 DeepSeek/Goal、多厂商接管或跨平台桌面验收。

## 17. 唯一根 Goal 与原生阶段适配（2026-10-02）

### 17.1 三个权威各自持久，不复制第二套任务执行器

1. 控制库保存 Cloud Task、绑定、outbox、阶段操作与收据。
2. VM-local native journal 保存固定部署身份、单向许可、launch/stop、不可变 bootstrap reservation；不保存模型 Key 或完整对话。
3. 原 Session Store 保存原 Goal、模型选择、权限和原有 mutation receipt；Goal 后续推进仍由原 Durable Runtime 完成。

`xharness-host::prepare_goal_session` 是中立的可信引导接口；没有云、SQL 或协议依赖，没有注册模型 Tool。它复用原 GoalProcessor、权限事件、Goal execution enable 与 Store CAS，一次事件批次提交配置、Goal 和 `host.bootstrap-goal/v1` 收据。**不发送额外 user 消息、不唤醒 Runtime、不调用模型**。激活后由原 Goal 的自治输入开启工作，避免“Goal + 初始用户请求”重复执行同一目标。

架构门禁只为 GoalProcessor 显式增加 `bootstrap.rs` 这一可信消费者（`architecture-host-modules.json`）；原 RPC entrypoint 与其余消费者限制保留。GoalProcessor 仍是纯策略、不依赖 BasicHost/ControlStore/tokio/transport；cloud-app 仍只向 cloud 领域核依赖，未给 Host/Core 加云或 SQL 边。

### 17.2 预留、提交和恢复

bootstrap manifest 是 permit 私有目录内的普通文件，最多 256 KiB，拒绝符号链接和 Unix 非私有权限。它只包含任务的版本引用与 Goal 配置，不含厂商 Key。

- 先取得原 state ownership，验证 scope/root/workspace/固定 Host SHA 和目标/验收清单，再持久预留 bootstrap 身份；首次预留拒绝任何已存在的根 Session。
- 原 Session 配置指纹与 CloudTaskSpec 规范化指纹分别记录；重试的操作、目标、模型配置或 TaskSpec 改动必须拒绝。
- bootstrap 已应用时只重放原收据，**不把用户后来修改的 Goal/模型/权限覆盖回初始值**。
- 预留后的“仅 header 已写、批次未写”崩溃窗口，只有相同 Session ID、创建时间和 cwd 的空 journal 可以重试；非空的外来历史不接管。
- 已应用的原 journal 丢失或损坏必须报错，不能重建 Goal 假装恢复。launch Starting/异常 Stop 仍要求外部可信核对，不能依靠 bootstrap reservation 自动越过旧世代。
- Goal 轮数显式给定正整数，不隐式继承旧 256；验收 fixture 的 3 轮上限只是费用控制，不代表产品固定上限或无限推进承诺。

native 数据库从 schema 1 **增量迁移到 2**：新增 bootstrap 表，不重置 authority、command ack 或 launch 历史。snapshot 外部 schema 名称保持 v1；损坏、空真源或未知版本仍拒绝。

### 17.3 PreparedReady 不等于可执行 Ready

不带 manifest 的旧 Prepared 仍休眠。使用 `--hosted-bootstrap-file` 的托管 Host 可在 Prepared 中初始化原组件和根 Goal，但执行门禁保持关闭：

```text
预留身份 → 同一 launch Starting → 原 Goal 已持久 → PreparedReady
                                              │
                               控制器 Active ack
                                              ↓
                                 同一 launch Ready → 原 Runtime 工作
```

- PreparedReady 证明原 Host 与唯一 Goal 已准备好，允许返回控制协议的 bootstrap-prepared 事实；HTTP ready 仍为未就绪，RPC 和真实 Provider/Tool 执行均拒绝。
- 启动固定 CLI 模型路由，不在 Prepared 阶段进行远程模型能力探测；当前不支持 bootstrap 与 providers-file 同时使用。
- 激活需 current PreparedReady + applied reservation，Ready 使用同一 launch generation；启动/激活没有第二次 Goal admission。
- PreparedReady 中 SIGTERM 或封存，走原 shutdown 并记录 Stop；临时优雅停止允许下一 generation，已封存拒绝恢复。
- 更早的 boot 失败/封存，没有可信清理收据时保留未知，交给外部生命周期核对，不伪报 graceful。

### 17.4 控制器收据端口与剩余边界

`NativeStageExecutor` 对接原 `CloudController` 的 StageExecutor：Prepare 要求任务/绑定/规范化 TaskSpec/原 bootstrap 操作匹配，Activate 要求**精确操作 ack + 当前 Ready**。inspect 只查询；激活超时后核对原 operation，不重启或重新发送初始消息。已有有效 Prepare proof 时不再次调用生命周期 ensure。

Settle 由可信 `NativeHostLifecycle` 端口处理外部停止和保留。**只持有 native Stop 的实现不能返回整台 VM 已静止，不能让控制 Task 离开 Settling。** 原 Goal 使用 UserConfirm 验收；模型报告 complete 只是等待确认，不自动转 Cloud Task Finished。

目前交付的是适配器与端口，不是完整生产 SSH/VM 控制服务。材料与凭据版本授权、任务根/子 Session Gateway、外部 Stop/retention 与终态 CAS、可信崩溃恢复和本机 UI 仍待实现。生产环境的未验证能力仍为 unknown。

回归包含 SQLite 控制库重开 + 真实 native journal 适配（测试生命周期端口）、独立原 Host 进程，以及 retained VM-1 内真实 DeepSeek Goal；三类证据不混用。详见[验收报告](../reports/cloud-goal-bootstrap-20261002.md)及[操作手册](../runbooks/cloud-native-execution-gate.md)。

### 17.5 真模型暴露的可恢复工具调用错误

真实 DeepSeek 曾把 Bash 与 Standalone Goal 放在同一批。原工具调度器正确在任何 handler/审批开始前拒绝整批；原 Core 却将 `StandaloneRequired` 升级成整轮失败，Goal 因 execution_error 暂停。

现在只对**明确的、执行前的 StandaloneRequired** 返回按原调用顺序的 Tool error：所有调用都未执行，metadata 标记 `batchRejected=true / executionStarted=false`；实时与持久结果一致，模型可以在后续步骤拆开调用。没有静默串行、没有只执行 Bash、没有伪造 ToolStarted，也不改 Goal 的单独调用规则。ZeroConcurrency、重复 order、supervisor/清理/存储等真正内部错误仍是原失败/未知语义，不能一律降级为“重试即可”。

确定性测试覆盖 Standalone 前/后位置、未知 sibling、零旧调用副作用、模型纠正后仅执行各一次、模型 Tool 消息顺序、持久 error 和没有 outcome_unknown；原 Tools 拒绝混合批次的测试保留。
