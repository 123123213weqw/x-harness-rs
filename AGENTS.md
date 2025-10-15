# Development policy

## Rust remote compilation

- 禁止在本机执行会编译 Rust 的命令，包括 `cargo build`、`cargo check`、
  `cargo test`、`cargo run`、`cargo bench`、`cargo clippy` 和 `rustc`。
- 所有 Rust 编译、检查和测试默认在 `WZU_Server` 执行。
- 执行前将当前源码同步至远程 `~/codex-build/x-harness-rs/`。
- 同步时排除 `.git/`、`target/`、`node_modules/`、`.env` 和 `.env.*`。
- `cargo fmt` 可以在本机执行，因为它不编译代码。
- 如果远程服务器不可连接，报告阻塞，不回退到本机编译。
