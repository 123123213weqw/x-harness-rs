# XHarness RS

从零实现的跨平台 AI Agent Harness。核心使用 Rust，目标是提供稳定、可嵌入、
可测试的 Agent Loop；macOS 作为首要本地开发平台，Linux 作为服务器平台。

当前开发版已完成可嵌入 Loop、OpenAI-compatible Provider、append-only Session、
14 个原生 Coding 工具，以及兼容 DeepSeek Harness Web 的第一版 Rust Host。目标不是
把所有能力继续堆进一个 `while`，而是把模型、历史、工具策略、Web 投影和原生执行
能力拆成 typed service。模型 Provider 只由共享核心调用，macOS/Linux 差异收敛在
最下层，并在编译期选择实现。

```text
DeepSeek Web UI / future CLI
              |
 xharness-api + server + host
              |
       Shared Loop Core
       |              |
 Model Provider   Tool Registry
                      |
 Session/Event Log  xharness-platform
                          |
             +------------+------------+
             |                         |
       macOS Seatbelt             Linux Bubblewrap
       openat/F_GETPATH        openat2/renameat2
```

## Specifications and roadmap

- [Architecture](docs/architecture.md)
- [Per-crate specification index](docs/specs/README.md)
- [Total TODO and delivery priorities](docs/TODO.md)

Contract changes are incomplete until implementation, tests, specification,
and TODO status agree.

## Workspace

### `xharness-api` / `xharness-server`

- 固定兼容 `deepseek-harness@141eb6fef8` 的 52 个 unary RPC 名称
- 四象限 RPC envelope、完整错误码、Mux/Host frame discriminant
- `POST /api/<method>`、`POST /api/respond`
- `/api/events.mux` 与 `/api/events.host` 下行 WebSocket
- 可选 Web dist 静态文件与 SPA fallback

### `xharness-host`

- 52 个 RPC 已全部有基础状态行为，不再只是占位路由
- Session/Workspace/预设/Goal/Settings/Credentials/模型目录的内存实现
- `session.prompt` 直接驱动真实 Rust Loop，并投影 turn/step/chunk/tool 事件
- Prompt FIFO、运行时 Steering/Cancel、工具审批与 `/api/respond` 恢复
- `NativeToolFactory` 接入完整 14 工具，按 Session 隔离 Terminal
- JSON Session export 与 Mux/Host 重连基线
- `xharness-host` 二进制默认监听 `127.0.0.1:3080`

当前 Host 状态仍是进程内存：接口和最小功能已经贯通，但重启恢复、durable inbox、
single-writer lease 和真正自主 Subagent 仍需接到 Agent/Session 持久层。

### `xharness-core`

- `LoopEngine::start(LoopRequest) -> LoopRun`
- 流式 `text_delta`、`reasoning_delta` 与工具生命周期事件
- tool-call delta 聚合和多轮模型调用
- 请求输出前的安全重试；已经产生 delta 后禁止重试
- `parallel`、`keyed`、`exclusive` 工具调度，默认最多 8 路
- 工具超时、取消、panic、未知工具和参数错误统一写回模型
- 默认完整上下文重放，工具结果写回限制为 256 KiB
- 默认最多 128 个模型步骤
- Session 检查点和中断工具批次防重放
- `LoopRun::send(LoopCommand)` 运行时控制：消息注入、Steering、暂停/恢复、取消
- 可选的逐次工具审批；拒绝结果按普通工具错误安全写回模型

### `xharness-provider-openai`

- Chat Completions 与 Responses API，协议显式选择
- 增量 SSE：任意网络分片、CRLF、多行 data 和 UTF-8 边界
- Responses 使用 `store=false` 并保留 opaque provider items
- API Key 不进入 Session，并在 `Debug` 输出中脱敏

### `xharness-session`

- append-only `SessionEvent` 日志，单调 `seq` 与 CAS `Revision`
- `turn/step/request/assistant/tool` 生命周期事件
- 消息历史由日志纯投影，不维护第二份可变 transcript
- 模型请求头保存实际 input、provider/model、system 与 tool schema
- 工具调用先持久化、再允许副作用；崩溃恢复时缺失结果记为
  `outcome_unknown`，绝不自动重放

### `xharness-session-jsonl`

- 每个 Session 一个 JSONL 文件：immutable header + atomic append batch
- 严格校验 revision/seq/格式；中间损坏立即拒绝
- 可恢复未写完的最终 JSON 行，并在下次 append 时修复尾部
- `create_new` 防覆盖、Session ID 路径约束、symlink 拒绝与显式 `sync_data`

### `xharness-process`

- Unix `program + argv` 直接执行，不进行隐式 shell 解析
- 显式 cwd 与 `env_clear` 环境；提供 credential 变量清洗 helper
- 每次调用建立独立 session/process group
- timeout/cancel 执行 TERM → grace → KILL，并等待根进程退出
- stdout/stderr 并行 drain，有界保留、总字节计数与 UTF-8 边界安全截断
- 非零退出码是结构化正常结果，不会被误判为 runtime 异常
- process group 只负责生命周期；真正的进程树硬隔离由下层原生沙箱提供

### `xharness-fs`

- 统一 `FsService`、opaque target 与 per-session observation CAS
- 读后才能覆盖；stale/blind write fail closed
- 同目录临时文件、文件 `fsync`、原子发布和目录 `fsync`
- Linux 使用 `openat2 + renameat2`；macOS 使用逐级 `openat(O_NOFOLLOW)`、
  `F_GETPATH + renameatx_np`

### `xharness-sandbox` / `xharness-platform`

- `NativeSandbox` 编译期选择：Linux Bubblewrap、macOS Seatbelt
- `ReadOnly / WorkspaceWrite / DangerFullAccess` 和独立网络能力
- Restricted 模式后端不可用时 fail closed，不会静默裸跑
- `NativePlatform` 是宿主唯一平台入口，组合 FS、Process 与 Sandbox；Loop 与 Provider
  不依赖操作系统实现

### `xharness-coding-tools`

- 基础工具：`bash/read/write/edit/glob/grep`
- 持久 PTY：`terminal_open/send/read/signal/close/list`
- Web：`web_search/web_fetch`
- `CodingToolBundle::core_specs()` 可直接接入当前 `LoopRequest.tools`
- 变更类工具默认要求宿主审批；`read/glob/grep/web` 可安全并行

### `xharness-terminal` / `xharness-web`

- 真 PTY、owner/name 隔离、单调 cursor、按 bytes+lines 双重限制 scrollback
- 信号发往终端 foreground process group，close 执行 TERM → grace → KILL
- `web_fetch` 仅匿名 HTTP(S)、同源跳转、私网目标拒绝、响应和正文双重上限、HTML 转 Markdown
- `web_search` 必须显式注入 Provider；当前包含可选的 Exa 实现，不伪造“本地搜索”

### `xharness-tools`

- 唯一名称 Registry、确定性 schema 列表与 JSON object/schema 校验
- 每次调用生成独立 `execution_id`，所有失败均物化为结构化结果
- `pre → monotonic guards → approval → around → handler → post → finalize → observer`
- guard 只允许把权限从 allow 收紧到 ask/deny，后续 middleware 不能反向放宽
- 缺失、异常、panic 或超时的审批 provider 全部 fail closed
- handler timeout/panic/cancel 与 middleware panic 不会炸掉 Agent Loop
- `parallel/keyed/exclusive` declarative gate；同 key 串行、exclusive 形成全局屏障

## 最小嵌入

```rust,no_run
use std::sync::Arc;

use futures::StreamExt;
use xharness_core::{AgentMessage, LoopEngine, LoopRequest};
use xharness_provider_openai::{
    OpenAiProtocol, OpenAiProvider, OpenAiProviderConfig,
};

#[tokio::main]
async fn main() {
    let provider = OpenAiProvider::new(OpenAiProviderConfig::new(
        OpenAiProtocol::Responses,
        "https://api.openai.com/v1",
        std::env::var("OPENAI_API_KEY").unwrap(),
        "your-model",
    ))
    .unwrap();

    let request = LoopRequest::new(
        Arc::new(provider),
        vec![AgentMessage::user("分析当前目录")],
    );
    let mut run = LoopEngine.start(request);

    while let Some(event) = run.events().next().await {
        println!("{event:?}");
    }
    println!("{:?}", run.result().await.status);
}
```

## 运行时控制

`LoopRun` 内部带有独立的有界命令通道。宿主可以在消费事件的同时控制运行：

```rust,no_run
use xharness_core::{AgentMessage, InjectionMode, LoopCommand};

# async fn control(run: &xharness_core::LoopRun) -> Result<(), xharness_core::LoopControlError> {
run.send(LoopCommand::InjectMessage {
    message: AgentMessage::user("下一轮同时检查测试覆盖率"),
    mode: InjectionMode::NextStep,
}).await?;

// 中断当前模型流；已输出的正文会保存为 interrupted assistant turn。
run.send(LoopCommand::Steer(AgentMessage::user(
    "停止当前方向，改为先修复编译错误",
))).await?;

run.send(LoopCommand::Pause).await?;
run.send(LoopCommand::Resume).await?;
# Ok(())
# }
```

需要审批的工具使用 `.requires_approval()` 声明。Loop 会发出
`ToolApprovalRequested`，宿主随后发送 `ApproveTool` 或 `RejectTool`。暂停时不再启动新工具，
但已经启动的工具允许收尾；工具运行期间收到的 Steering 会延迟到完整工具批次之后，避免破坏
assistant tool-call 与 tool result 的协议顺序。

## Durable Session

设置 `journal_store` 后，事件日志会取代旧 snapshot store 成为历史真源。下面使用磁盘
JSONL；测试或嵌入场景也可使用 `xharness_session::MemorySessionStore`：

```rust,no_run
use std::sync::Arc;

use xharness_core::{AgentMessage, LoopEngine, LoopRequest};
use xharness_session_jsonl::JsonlSessionStore;

# fn provider() -> Arc<dyn xharness_core::ModelProvider> { todo!() }
# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let store = Arc::new(JsonlSessionStore::new(".xharness/sessions")?);
let mut request = LoopRequest::new(provider(), vec![AgentMessage::user("继续修复项目")]);
request.session_id = Some("project-main".into());
request.journal_store = Some(store);

let run = LoopEngine.start(request);
let result = run.result().await;
assert!(result.error.is_none(), "{:?}", result.error);
# Ok(())
# }
```

写入边界如下：用户输入和 request header 在模型调用前 flush；完整 assistant
tool-call 在工具运行前 flush；完整工具批次按模型原顺序写入并 flush。进程若死在
tool-call 与 tool-result 之间，下次恢复只生成 `outcome_unknown`，让模型先检查外部状态。
当前 JSONL backend 使用进程内互斥和 OS 文件锁保护跨进程 CAS；更高层仍应使用
single-writer lease 来表达 Agent 所有权。SQLite backend 属于 Agent 控制层下一阶段。

## 启动 Web Host

Web 静态文件直接复用指定版本 DeepSeek Harness 的 `apps/web/dist`，不复制进 Rust
仓库。Host 支持环境变量和等价的 `--bind`、`--workspace`、`--static-dir`、
`--provider`、`--model`、`--base-url`、`--api-key`、`--protocol` 参数：

```bash
XHARNESS_WORKSPACE=/path/to/project \
XHARNESS_WEB_DIST=/path/to/deepseek-harness/apps/web/dist \
XHARNESS_BASE_URL=http://your-model-server:8000/v1 \
XHARNESS_MODEL=your-model \
XHARNESS_API_KEY=optional-key \
XHARNESS_PROTOCOL=chat \
cargo run -p xharness-host
```

浏览器打开 `http://127.0.0.1:3080/`。`XHARNESS_PROTOCOL` 只能显式使用 `chat` 或
`responses`，不会自动回退。没有配置模型时 Host 仍能启动和浏览状态，但
`session.prompt` 会返回 `model-unavailable`。远程部署前必须先补认证/Origin 策略；当前
安全默认是仅监听 loopback。

## 远程开发

不要在本机编译 Rust。使用：

```bash
scripts/remote-rust-test.sh WZU_Server
```

源码会同步到 `WZU_Server:~/codex-build/x-harness-rs/`，然后远程运行：

```text
cargo fmt --check --all
cargo check --workspace --all-targets
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
```

当前测试覆盖：正文/reasoning、多轮工具、分片 tool calls、坏参数、未知工具、超时、
panic、重试边界、取消、步骤限制、UTF-8 截断、并发上限、keyed/exclusive 屏障、
历史顺序、异常批次恢复、消费者提前退出、消息注入、模型中断、暂停/恢复、工具审批、
工具期间延迟 Steering、durable call-before-side-effect、outcome-unknown 恢复、JSONL
CAS/损坏/断尾恢复，以及两个 OpenAI 协议的原生 HTTP 集成。

## Roadmap

1. 把 `BasicHost` 迁移到长生命周期 Agent、durable inbox、single-writer lease
2. CLI、配置/凭据边界与 macOS 原生发布验证
3. Prompt/Provider Registry、上下文计量与压缩 surface
4. Web Host 认证、断线游标恢复、健康检查与部署配置
5. Skills、MCP、LSP、附件与 Subagent/Workflow 调度

完整任务、优先级和验收条件见 [`docs/TODO.md`](docs/TODO.md)；架构边界与
不变量见 [`docs/architecture.md`](docs/architecture.md)。

## License

Apache-2.0
