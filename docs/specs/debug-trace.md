# Full Debug Trace 规范

**所属层：** `xharness-debug`、`xharness-host-app` 及后续被观测模块  
**状态：** Sidecar、JSONL Writer、Blob、脱敏、Host 生命周期接线已实现；Core/Provider/Tool/
Process/Terminal/Web RPC 全量埋点待接入。

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

Full Sink 使用有界 MPSC 和单 Writer：队列满时生产者等待，不静默丢事件。`record()` 在 Writer
接受并写入用户态文件缓冲后返回；`flush()` 执行 BufWriter Flush 和 `sync_data()`，作为明确持久
边界。Host 当前在 Listening 和退出时 Flush。后续 Core 必须在 Request、Tool Side Effect 和 Turn
结束边界 Flush；不能为每个 Token `fsync`。

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

Host App 已记录并在监听前 Flush：

- `host.start`：Bind、Workspace、State Dir、Provider/Model、Base URL、Protocol、Provider File；
  不记录 API Key。
- `host.restore`：恢复 Session/Turn 数与问题。
- `host.listening`：最终监听地址。
- `host.exit`：成功或完整错误字符串。

下一阶段按统一 Sink 注入 Core、Provider、Tool、Process、Terminal、Sandbox 和 Server。未接入这些
模块前，`full` 表示“对已埋点事件无损落盘”，不能宣称已经捕获所有模型或工具字节。

## 验收标准

- Off 模式零文件、零 Writer Task。
- Full 模式 Sequence 连续，调用顺序稳定；Flush 后可被独立进程读取。
- 递归脱敏发生在 Blob Hash 之前，磁盘全文搜索找不到注入的测试凭据。
- 超限 Payload 只在 JSONL 留内容寻址引用，Blob Hash 与文件 Bytes 一致。
- Linux/macOS 权限测试固定目录 `0700`、文件 `0600`。
- Host CLI/环境变量能创建 Trace，并至少落下 Start/Restore/Listening。
- 后续每个模块接线必须补“成功、失败、取消、超时、大 Payload”四类事件测试。

