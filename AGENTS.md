# Development policy

## Rust remote compilation

- 禁止在本机执行会编译 Rust 的命令，包括 `cargo build`、`cargo check`、
  `cargo test`、`cargo run`、`cargo bench`、`cargo clippy` 和 `rustc`。
- 所有 Rust 编译、检查和测试默认在 `WZU_Server` 执行。
- 执行前将当前源码同步至远程 `~/codex-build/x-harness-rs/`。
- 同步时排除 `.git/`、`target/`、`node_modules/`、`.env` 和 `.env.*`。
- `cargo fmt` 可以在本机执行，因为它不编译代码。
- 如果远程服务器不可连接，报告阻塞，不回退到本机编译。

## Safe Rust business-policy modules

- `config/architecture-host-modules.json` 中的每个 `managedModules[].source`
  必须在模块头部无条件声明 `#![forbid(unsafe_code)]`，包含该模块的测试与子模块。
- 不得删除、改成 `deny`/`warn`/`allow`、放入条件 `cfg_attr`，或用局部 `allow`
  绕过声明。新增受管 Processor 自动适用同一门禁。
- 必须使用现有架构检查和 Rust 编译检查；不能用搜索 `unsafe` 关键字代替编译器。
- 这不是全仓库禁用 `unsafe`。必要的原生平台 FFI 保持隔离，通过安全接口供业务模块调用。
- 提交前主动执行 `cargo fmt --all -- --check`、架构检查、相关测试和
  `cargo clippy --locked -p <受影响 crate> --all-targets -- -D warnings`；
  所有 Rust 编译、测试与 Clippy 仍须在同步源码后的远程服务器执行。
