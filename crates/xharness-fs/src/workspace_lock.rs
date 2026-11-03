//! Isolated nonblocking POSIX advisory directory lock. Closing the independently
//! opened descriptor releases the lock; no fallible/panicking unlock in Drop.
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

use nix::libc;
use std::{fs::File, io, os::fd::AsRawFd};

pub(crate) fn lock(file: &File, exclusive: bool) -> io::Result<()> {
    let mode = if exclusive {
        libc::LOCK_EX
    } else {
        libc::LOCK_SH
    } | libc::LOCK_NB;
    let mut remaining = 3;
    loop {
        remaining -= 1;
        // SAFETY: this independently opened directory FD is owned by the caller
        // throughout the call. flock neither takes ownership nor retains pointers.
        if unsafe { libc::flock(file.as_raw_fd(), mode) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted || remaining == 0 {
            return Err(error);
        }
    }
}

/// Scalar POSIX identity query, isolated with the other native calls.
pub(crate) fn effective_uid() -> u32 {
    // SAFETY: geteuid takes no pointers and returns the calling process UID.
    unsafe { libc::geteuid() }
}
