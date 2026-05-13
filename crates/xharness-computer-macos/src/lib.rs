//! macOS adapter for the provider-neutral XHarness Computer Use tool.
//!
//! Unsafe FFI is intentionally confined to this crate. Higher layers only see
//! logical desktop coordinates and versioned observations.

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::MacComputer;

#[cfg(not(target_os = "macos"))]
mod unavailable {
    use async_trait::async_trait;
    use tokio_util::sync::CancellationToken;
    use xharness_computer::{ComputerDriver, ComputerError, ComputerOutput, ComputerRequest};

    /// Compile-time stub used by cross-platform workspace checks. The Host
    /// never registers it outside macOS.
    #[derive(Default)]
    pub struct MacComputer;

    impl MacComputer {
        pub fn new() -> Self {
            Self
        }
    }

    #[async_trait]
    impl ComputerDriver for MacComputer {
        async fn execute(
            &self,
            _: ComputerRequest,
            _: CancellationToken,
        ) -> Result<ComputerOutput, ComputerError> {
            Err(ComputerError::unavailable(
                "macOS Computer Use is unavailable on this operating system",
            ))
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub use unavailable::MacComputer;
