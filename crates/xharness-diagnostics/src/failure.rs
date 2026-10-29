//! Diagnostics must never unwind business work. Only closed failure categories
//! reach the process-owned, bounded recorder; arbitrary stderr text never does.
#![forbid(unsafe_code)]
#![cfg_attr(not(test), forbid(clippy::print_stderr))]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use crate::{Phase, Record, Recorder};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    io::{self, Write},
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    StderrWrite,
    RecorderWrite,
    Rpc,
    TaskPanicked,
    TaskCancelled,
    Catalogue,
    AutoTitle,
    JobContinuation,
    EventFrame,
    DriverUnavailable,
    PluginStore,
}

static RECORDER: OnceLock<Mutex<Recorder>> = OnceLock::new();
static STDERR_FAILURES: AtomicU64 = AtomicU64::new(0);
static STORAGE_FAILURES: AtomicU64 = AtomicU64::new(0);
static FAILURES: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureStatus {
    pub recorder_installed: bool,
    pub failures: u64,
    pub stderr_write_failures: u64,
    pub storage_write_failures: u64,
}

pub fn failure_status() -> FailureStatus {
    FailureStatus {
        recorder_installed: RECORDER.get().is_some(),
        failures: FAILURES.load(Ordering::Relaxed),
        stderr_write_failures: STDERR_FAILURES.load(Ordering::Relaxed),
        storage_write_failures: STORAGE_FAILURES.load(Ordering::Relaxed),
    }
}

/// Install once after obtaining Host ownership, before starting any workers.
/// The directory belongs to this process, not the desktop's anonymous pipe.
pub fn install_failure_recorder(root: &Path) -> io::Result<()> {
    let recorder = Recorder::open(root)?;
    RECORDER.set(Mutex::new(recorder)).map_err(|_| {
        io::Error::new(
            io::ErrorKind::AlreadyExists,
            "failure recorder already installed",
        )
    })
}

pub fn record_failure(code: FailureCode) {
    FAILURES.fetch_add(1, Ordering::Relaxed);
    if matches!(code, FailureCode::RecorderWrite) {
        STORAGE_FAILURES.fetch_add(1, Ordering::Relaxed);
    }
    if let Some(recorder) = RECORDER.get() {
        let mut record = Record::new(Phase::RuntimeFailure);
        record.pid = Some(std::process::id());
        record.failure = Some(code);
        let written = match recorder.lock() {
            Ok(mut recorder) => recorder.append(&record),
            Err(_) => Err(io::Error::other("failure recorder poisoned")),
        };
        if written.is_err() {
            // Never recursively log a sink failure. host.describe exposes this
            // counter even when both filesystem and stderr are unavailable.
            STORAGE_FAILURES.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// Best-effort console mirroring, NOT a business success receipt. Sink errors
/// have closed durable evidence/counters and cannot prevent an error response,
/// task cleanup or failure callback. Does not persist the formatted text.
pub fn diagnostic_stderr(args: fmt::Arguments<'_>) {
    if write_line(&mut io::stderr().lock(), args).is_err() {
        STDERR_FAILURES.fetch_add(1, Ordering::Relaxed);
        record_failure(FailureCode::StderrWrite);
    }
}

fn write_line(writer: &mut impl Write, args: fmt::Arguments<'_>) -> io::Result<()> {
    writer.write_fmt(args)?;
    writer.write_all(b"\n")
}

#[macro_export]
macro_rules! diagnostic_stderr {
    ($($arg:tt)*) => { $crate::diagnostic_stderr(format_args!($($arg)*)) };
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    #[test]
    fn failing_writer_returns_error_without_unwinding_or_running_a_recursive_logger() {
        let result =
            std::panic::catch_unwind(|| write_line(&mut Broken, format_args!("synthetic")));
        assert!(matches!(result, Ok(Err(e)) if e.kind()==io::ErrorKind::BrokenPipe));
    }
}
