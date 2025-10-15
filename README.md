# XHarness RS

从零实现的 Linux Server AI Agent Harness。核心使用 Rust，目标是提供稳定、可嵌入、
可测试的 Agent Loop，并继续扩展 CLI、PTY、Sandbox、Daemon 和 Subagent。

当前 **v0** 已完成 Loop 内核与 OpenAI-compatible Provider。

## Workspace

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
工具期间延迟 Steering，以及两个 OpenAI 协议的原生 HTTP 集成。

## Roadmap

1. CLI 与配置加载
2. PTY/Shell 工具
3. Linux Sandbox 与权限策略
4. Daemon 和 OpenAI-compatible Harness API
5. Web UI
6. Subagent 调度

## License

Apache-2.0
