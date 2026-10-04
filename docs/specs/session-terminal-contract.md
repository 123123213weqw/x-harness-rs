# Host → UI：生成的轮次结束契约

## 范围与问题

第一阶段只收口 `turn/end`，不宣称所有 RPC、工具视图或其他事件已迁移。

原后端发出 `cancelled` 和 `{code,message}` 生命周期错误，Chat 的手写枚举漏了
`cancelled`，且把错误当作必须有 `details` 的 RPC Error。Runtime 的位置索引关闭了
轮次，业务 Definition 却不认事件，于是结束按钮、自动折叠和错误行可能缺失。
Trajectory 又有自己的宽松校验。文档或 TypeScript 类型检查单独不能发现这种跨语言漂移。

## 唯一生产定义

- Rust `crates/xharness-projection/src/wire.rs` 的 `TurnEndData` / `TurnEndReasonWire`
  是当前生产 DTO；持久事件投影和旧 Core 驱动都使用它。
- Durable Turn 从 1 开始，浏览器坐标从 0 开始；投影减 1，Core 驱动已有浏览器坐标，不能再减。
- 完成、输出上限、取消、步骤上限、错误五种 Wire 终态。用户打断映射为取消；Host 崩溃恢复
  的 Interrupted 映射为带 `INTERRUPTED` code 的错误；不篡改原持久状态。
- Schemars 仅作为 Projection 的 dev-dependency；schema 导出只在测试中运行，不增加 Host
  运行时校验器、网络请求或编译工具依赖。
- Core 客户端公共类型中的当前生产分支从生成的 `TurnEndReasonWire` 派生，保留其旧公共
  接口别名和 declaration merging。公共插件类型能扩展不意味着能重新定义 Host 的核心结束协议。

## 生成、读兼容与严格边界

远程 Rust 测试导出 JSON Schema 和真实投影样本；提交的 `protocol/session-terminal.schema.json`
生成 `ui/src/modules/shared/generated/session-terminal.ts` 的 TS 类型、Zod codec 和 Schema hash。
Chat、Trajectory 和 Session 入口共用这一个 codec，不再各自维护生产终态枚举。

生产错误必须带 `{code,message}`；历史读兼容单独建模，接受 `aborted`、`stop`、旧的
`error`/`failure` 包装及旧无错误详情记录。旧别名不能由当前生产转换函数发出。
保留原 carrier、外来扩展字段和 provider 数据，不用 parse 结果替换原事件，也不修改 JSONL。

严格验证已知核心字段（turn 的 u32 范围、reason.kind、错误 code/message），而不是给所有插件
事件建立全局封闭枚举。未知事件继续透传。新的 Host 终态必须经过契约升级和测试，不能当成成功结束。

Session 在历史事务 staging 和实时追加**修改任何窗口/位置索引之前**校验。
失败保留最后正常窗口，暴露可重试历史错误，保留 live buffer，错误文本只包含 seq 和有界字段路径，
不复制原参数或错误载荷。权威历史重拉覆盖相同 seq 的坏实时帧后可恢复；已提交 seq 的重复帧先去重。
审批和提问的 pending 机制、流式接收节奏、工具执行和预算逻辑不改变。

生成器是有界 JSON Schema 编译器，不是通用 JSON Schema 实现：只支持已验收的对象、引用、
数组、可空值、字面量、数值范围和 union。`oneOf` 仅在 required 字面量 kind 可证明互斥时
转换成 Zod union；未知关键字、被忽略的 sibling 约束、重复 tag 和不支持的格式直接让构建失败。

## 强制门禁

1. 统一 UI assembler 本身必须检查生成文件与已提交 schema 一致；build/check:build、plugin-api build 和直接 CLI/自定义输出路径均不能绕过。
2. Linux Rust CI 重新从实际 Rust 导出，检查 schema、fixtures、TS 生成物均一致；不能只核对手写样本。
3. Rust 穷尽映射测试；Node 检查所有当前生产终态都有真实导出样本。
4. `protocol/compat/session-terminal-v1` 是固定 Hash 的首个 v1 读写样本基线，不被常规生成器改写。
   旧生产→新读取、新生产→固定旧读取都需通过。它是兼容语料回归，不是任意 Schema 的完备子类型证明；
   不兼容变更应新增契约版本并设计迁移，不能重写基线绕过 CI。
5. 真实 Rust events → 生产 Session / ConversationNodeAssembler → 实时、历史、部分历史、重复帧、
   异常终态、未知工具结果、错误事务和重试恢复；再在 Chromium / WebKit 渲染这些真实组装窗口。
6. 已有整轮折叠、滚动锚点、Think/Tool 展开、窗口化和 observer 清理回归继续保留。

## 修改与验收步骤

Rust 不在本机编译。同步未提交源码到独立远程目录（排除 .git、target、node_modules、.env、
.env.*、密钥和敏感环境文件）后，远程执行：

```sh
XHARNESS_SESSION_TERMINAL_EXPORT=/tmp/xh-terminal-export \
  cargo test --locked -p xharness-projection export_session_terminal_contract
cargo test --locked --workspace --all-targets
cargo clippy --locked --workspace --all-targets -- -D warnings
```

从服务器下载导出的目录，在本机生成并验收：

```sh
node scripts/generate-session-terminal-contract.mjs --from /tmp/xh-terminal-export
node --test scripts/test-session-terminal-contract.mjs
npm run build --prefix ui
npm run check:build --prefix ui
npm run typecheck --prefix ui
UI_TEST_DEPS=/path/to/isolated-test-deps UI_TEST_BROWSER=chromium node scripts/test-turn-process-browser.mjs
UI_TEST_DEPS=/path/to/isolated-test-deps UI_TEST_BROWSER=webkit node scripts/test-turn-process-browser.mjs
```

修改 schema/DTO 不允许直接修改生成 TS。软件发布与重启是独立操作，源码/浏览器回归通过不等于本机桌面已更新。

## 后续迁移

按故障风险逐族迁移：工具视图 discriminator → Step/Assistant 生命周期 → Compaction → 其余 Host RPC。
每族先记录现有实际载荷、收口生产 DTO、加入真实生产/读取对照，再删对应手写分支；不要一次切换
全部开放事件或新增第二套调度/状态存储。Windows 原生进程边界另有生命周期与故障回归，本契约
重构不替代原生崩溃隔离，也不更换执行器。
