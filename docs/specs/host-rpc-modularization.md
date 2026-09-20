# Host RPC 模块化重构规范

状态：第一阶段实施中  
日期：2026-09-20

## 1. 为什么要重构

当前 Host 已经按文件拆出 `workspace.rs`、`settings.rs`、`subagent.rs` 等模块，但这些模块仍通过
`impl BasicHost` 共享整个 Host 状态；固定 RPC 的入口仍集中在 `rpc.rs` 的大 `match` 中。结果是：

- 协议、业务编排、持久化和投影容易在同一改动里互相影响；
- 单个领域无法只依赖自己需要的能力；
- 实时事件与历史恢复容易出现两套投影语义；
- 排错时很难判断故障属于传输、协议、领域还是存储。

目标不是拆成微服务，也不是每个 RPC 建一个 trait。目标是**模块化单体**：进程、数据目录和
线协议不变，在进程内部建立稳定边界。

## 2. 不变量

整个重构期间必须保持：

1. 现有 52 个固定 RPC 方法名、JSON 字段名、可选字段和响应形状不变；
2. 浏览器四象限消息、Mux/Host 实时帧不变；
3. JSONL、Control Log、会话、Goal 和设置的持久格式不变；
4. UI 行为与安装包入口不因内部重构改变；
5. 兼容边界允许服务端增加未知字段；内部代码不得继续传播无类型 `Value`；
6. 每一阶段可以独立回滚，并通过远程 quick/full 回归后才进入下一阶段。

## 3. 目标结构

```text
HTTP / WebSocket
      │
      ▼
Transport Adapter       只处理帧、连接、取消和错误映射
      │
      ▼
Typed Protocol          RpcMethod -> Params / Response
      │
      ▼
Rpc Dispatcher          只路由，不写业务逻辑
      │
      ├── SessionProcessor
      ├── WorkspaceProcessor
      ├── SettingsProcessor
      ├── SubagentProcessor
      ├── GoalProcessor
      ├── PresetProcessor
      └── ModelProcessor
             │
             ▼
       Domain services / stores / runtime ports

Domain events ──> EventGateway ──> 实时投影 + 历史投影
```

`BasicHost` 最终只负责组装依赖和生命周期，不再承载领域方法。

## 4. 分阶段计划

### 阶段 0：回归底座

固定远程 quick/full 命令，覆盖 Rust、Node、静态 UI、动态端点和协议。任何结构调整先跑 quick，
合并前跑 full。

### 阶段 1：冻结协议（本阶段）

- 为全部 52 个固定 RPC 建立 `Params` / `Response` DTO；
- 建立 `RpcMethod -> (Params, Response)` 的穷举目录；
- 对现有 Host 的基线响应做类型验证；
- 明确动态兼容端点仍由单独适配层承载，不伪装成固定 RPC；
- 此阶段只增加类型护栏，不改变生产处理路径。

允许使用 `serde_json::Value` 的位置仅限真正开放的内部节点，例如消息 content block、设置 schema、
事件列表和厂商能力扩展；RPC 顶层请求/响应必须有命名类型。

### 阶段 2：WorkspaceProcessor 样板

选择依赖少、边界清楚的 Workspace 领域作为样板。Processor 只获得所需领域输入或窄 port，不得持有
`Arc<BasicHost>`。新旧实现并行做契约对照，稳定后删除旧分支。

实际落地采用更窄的纯决策核：兼容适配器从 Host 取得一次只读快照，Processor 只根据快照和显式注入的
ID/时钟计算响应、Control Event 与 Host Event；锁、Receipt、原子提交及提交后的发布顺序全部留在适配器。
源码门禁禁止 Processor 重新依赖 Host aggregate、RPC 标识、Tokio 或具体 ControlStore。这样既保持旧线协议
和持久化语义，又使领域决策可做确定性单测。

### 阶段 3：迁移独立领域

按 Settings → Preset/Credentials/Model → Subagent → Goal 的顺序迁移。每次只迁移一个领域，保持
Dispatcher 和 DTO 稳定；禁止跨领域直接读内部字段，协作必须经过显式 port。

### 阶段 4：统一 EventGateway

领域只发结构化事件。实时推送、历史恢复和 UI 所需投影从同一 reducer 生成，解决“刷新前后不一致”。
事件顺序、序号和持久格式保持兼容。

### 阶段 5：迁移 Session/Turn

最后迁移耦合最高的 Session、Prompt、队列、模型调用和 Turn 生命周期。先引入 facade，再把状态机从
`BasicHost` 中抽出；不得在这一阶段顺便改变 compaction、预算或调度语义。

### 阶段 6：删除兼容实现

删除旧 `BasicHost` 领域 handler、大 `match` 中的业务分支和双重投影。动态上游命名空间仍保留在
明确命名的 Legacy/Dynamic Adapter 中，直至有独立迁移方案。

## 5. 依赖规则

- Protocol 不依赖 Host、store 或 UI；
- Processor 可以依赖领域 port，不依赖具体文件存储和 HTTP；
- Store 不调用 Processor；
- Transport 不读取领域状态；
- Processor 之间不得通过 `BasicHost` 相互调用；
- 新增 RPC 必须先定义 DTO、契约用例和所有权领域。

## 6. 回归门禁

每个阶段至少满足：

1. `cargo fmt --all -- --check`；
2. WZU_Server 上 `scripts/regression/remote-regression.sh --suite quick`；
3. 固定 52 RPC 的请求、真实基线响应均通过类型目录；
4. 受影响领域的故障注入、恢复和并发测试；
5. 合并前 WZU_Server 上 `--suite full`；
6. 线协议/持久格式若产生 diff，默认判定为回归，除非另有迁移规范。

## 7. 回滚策略

每阶段单独提交。Processor 迁移使用一进一出：先接入新实现并做同输入对照，再删除旧实现；不同时
迁移多个领域。发现行为差异时回滚该阶段，不回滚已冻结的协议目录和回归底座。
