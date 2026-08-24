# Full Debug Trace 规范

**所属层：** `xharness-debug`、`xharness-host-app` 及后续被观测模块  
**状态：** 已实现并接入 Host、Core、OpenAI Provider、Tool Pipeline、Process、Terminal、Sandbox、Web 与 Server/RPC。

## 与 Session Log 的边界

Debug Trace 是可删除的诊断旁路，不是 Session 真源：

```text
Session Event Log               Debug Trace Sidecar
-----------------               -------------------
恢复与审计所需最小事实            排错所需的完整内部过程
协议稳定、长期兼容                版本化但允许快速扩展
始终启用                         默认关闭、显式开启
参与 History/Recovery            禁止参与业务状态恢复
```

禁止把原始 SSE、完整 HTTP Body、进程流和重复投影直接塞进 Session JSONL，否则会同时放大恢复、
History、Web Projection 和 Compact 成本。

## 启用方式

```bash
xharness-host \
  --debug-trace full \
  --debug-dir ~/.local/share/xharness/debug
```

等价环境变量：

```bash
XHARNESS_DEBUG_TRACE=full
XHARNESS_DEBUG_DIR=~/.local/share/xharness/debug
```

默认模式是 `off`。Off 使用 `NoopDebugSink`，不得创建目录、文件或后台任务。当前模式只有
`off|full`，以后可以向同一个抽象增加 Metadata/OpenTelemetry Adapter，但不能改变 Full 的
不丢提交事件语义。

## 落盘布局

每次 Host 启动创建独立 Trace：

```text
debug/
└── trace-<unix-micros>-<pid>-<nonce>/
    ├── manifest.json
    ├── events.jsonl
    └── blobs/
        └── <sha256>.json
```

- Trace/Blob 目录在 Unix 上为 `0700`。
- Manifest、JSONL 和 Blob 文件为 `0600`。
- Manifest 固定 `format=xharness-debug-trace` 和 `version=1`。
- 单个脱敏 Payload 默认超过 64 KiB 时写入 `blobs/<sha256>.json`；JSONL 保存 Hash、Byte 数、
  Media Type 和相对路径。
- Blob Hash 对脱敏后的完整 Bytes 计算；相同内容自然去重。

## 统一事件

生产者提交 `DebugEvent { scope, layer, event, payload }`。单 Writer 分配全局递增 `seq`，落盘为：

```json
{
  "version": 1,
  "seq": 12,
  "timestampUnixMicros": 1787568000000000,
  "scope": {"sessionId":"s1","runId":"r1","turn":2,"step":4},
  "layer": "provider",
  "event": "response.chunk",
  "payload": {}
}
```

Scope 坐标均可选，Host 全局事件不伪造 Session/Run。Layer 与 Event 使用稳定小写点分词；Payload
属于对应事件版本，禁止调用方自行写顶层 Sequence 和时间。

## 写入和 Flush

`DebugSink` 是跨层异步 Trait：

```text
record(DebugEvent)
flush()
enabled()
```

Full Sink 使用有界 MPSC 和单 Writer：队列满时生产者等待，不静默丢事件。`record()` 在 Writer 写入并 Flush 到操作系统后返回，因此 Host 被 SIGKILL 时已确认事件仍可读取；`flush()` 额外执行 `sync_data()`，作为断电持久边界。Host 在 Listening 和退出时 Flush；Token/SSE/进程输出只进入单 Writer 缓冲，不能为每个片段 `fsync`。运行层使用 `record_lossy` 保证诊断 I/O 不改变 Agent 业务结果，但首个后台写入错误会保存在 Recorder 中，并在 Host 下一次 `flush()` 时显式返回。

Debug Writer 错误在 Full 模式下向调用方返回，不允许悄悄退化为 Off。Debug 模式允许降低吞吐，
正常模式不得承担序列化或文件 I/O。

## 脱敏

内置 `SecretRedactor` 在内联、Hash 和 Blob 写入之前递归处理 JSON Key。至少覆盖：

- Authorization/Proxy-Authorization、Cookie/Set-Cookie；
- API Key、Access/Refresh Token；
- Password、Secret、Credential、Private Key；
- Env/Header 中使用大小写、`-`、`_` 变体的上述名称。

`input_tokens`、`max_output_tokens`、`token_safety_margin` 等计量字段必须保留。脱敏只保证已知
结构键；Tool/Model 正文可能包含用户数据，因此 Full Trace 目录仍必须按私有诊断数据处理。

## 当前埋点

同一个 `DebugRecorder` 从 Host Composition 注入全部运行层：

| Layer | 事件 | 主要 Payload |
|---|---|---|
| `host` | `start/restore/listening/exit` | 配置摘要、恢复报告、监听地址、退出结果 |
| `server` | `rpc.request/rpc.response/respond.*`、`websocket.*` | 完整 RPC Body/Result、下行 Frame、连接生命周期 |
| `core` | `run.start/run.end/context.prepared/provider.request.prepared/loop.event` | 完整可见上下文、工具 Schema、Token Budget、所有 Loop Event 与最终结果 |
| `provider.openai` | `request/response_status/response_error/token_count.*` | 最终 OpenAI Wire JSON、HTTP 状态、计数请求/响应 |
| `provider.openai` | `sse.chunk/stream.event` | 每个原始 SSE 网络 Chunk 和归一化 Provider Event |
| `tools` | `execute.* / arguments.validated / pipeline.* / approval.* / handler.*` | 原始参数、验证后 JSON、Guard/审批、完整 Tool Output/Failure/Duration |
| `sandbox` | `probe.completed/prepare.*` | 策略、网络模式、原始与最终直接执行 argv |
| `process` | `started/spawn.failed/output.chunk/completed` | program/argv/cwd/env、原始 stdout/stderr Chunk、退出与截断结果 |
| `terminal` | `open/send/read/signal/close/list/output.chunk` | PTY 输入、原始输出 Chunk、Cursor 与进程状态 |
| `web` | `search.* / fetch.*` | Query、URL、Redirect、原始响应 Chunk、最终提取正文或错误 |
| `platform` | `capability.report` | Workspace、权限预设和原生能力探测结果 |

Core 创建的 `sessionId/runId/turn/step` Scope 会随 `ProviderRequest` 传入 Provider。Tool、Process
和 Terminal 的下层事件另外携带 `executionId`、`parent`、PID 或 Terminal ID，用于与 Core 的
Tool Call/Completed 事件关联。关闭 Debug 时所有 Recorder 都是 Noop，不创建 Writer 或文件。

物理边界：Full Trace 捕获进入这些运行时的所有结构化事件和网络/进程/PTY Chunk；内核外部（例如
操作系统在进程启动前丢失的字节、第三方库内部未暴露的 TLS frame）不在可观测范围内。FS 的模型可见
请求与结果由 Tool Pipeline 完整记录，底层 `openat2/renameat2` 的每个 syscall 暂不逐条记录。

## 验收标准

- Off 模式零文件、零 Writer Task。
- Full 模式 Sequence 连续，调用顺序稳定；Flush 后可被独立进程读取。
- 递归脱敏发生在 Blob Hash 之前，磁盘全文搜索找不到注入的测试凭据。
- 超限 Payload 只在 JSONL 留内容寻址引用，Blob Hash 与文件 Bytes 一致。
- Linux/macOS 权限测试固定目录 `0700`、文件 `0600`。
- Host CLI/环境变量能创建 Trace，并落下 Host 生命周期与 Server RPC。
- Core、Provider、Tool、Process、Terminal、Sandbox、Web 和 Server 均有内存 Sink 或真实 Host 跨层测试。
- Process/PTY/Web/Provider 的原始 Chunk 在上层截断前进入 Debug Sink。
- 失败、取消、超时沿各层既有结果事件记录；超大 Payload 由 Blob 机制统一承载。

