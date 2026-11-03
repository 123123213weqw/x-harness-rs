//! Isolated POSIX FFI. Do not use nix 0.30.1's leaking fdopendir error path or
//! its readdir_r iterator, which can misinterpret positive errno values as EOF.
//! All normal exits close explicitly; Drop is only an unwind/early-exit guard.
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

use nix::{errno::Errno, libc};
use std::{
    ffi::OsString,
    io,
    os::{
        fd::{AsRawFd, IntoRawFd, OwnedFd},
        unix::ffi::OsStringExt,
    },
    ptr::NonNull,
};

#[derive(Debug, thiserror::Error)]
pub(crate) enum DirectoryError {
    #[error("native directory operation failed")]
    Io(#[source] io::Error),
    #[error("native directory entry limit exceeded")]
    Limit,
    #[error("native directory operation and cleanup failed")]
    Cleanup {
        #[source]
        primary: Box<DirectoryError>,
        close: io::Error,
    },
}

struct Stream(Option<NonNull<libc::DIR>>);
impl Stream {
    fn open(fd: OwnedFd) -> io::Result<Self> {
        // SAFETY: fd is uniquely owned and live. On failure fdopendir leaves it
        // owned by this scope; OwnedFd then closes it, including ENOMEM/ENOTDIR.
        let pointer = NonNull::new(unsafe { libc::fdopendir(fd.as_raw_fd()) })
            .ok_or_else(io::Error::last_os_error)?;
        // Transfer ownership ONLY after fdopendir succeeds. No fallible work
        // or user code can run between this transfer and installing the guard.
        let _transferred_fd = fd.into_raw_fd();
        Ok(Self(Some(pointer)))
    }
    fn next(&mut self) -> io::Result<Option<OsString>> {
        let pointer = self
            .0
            .ok_or_else(|| io::Error::other("directory stream is closed"))?;
        Errno::clear();
        // SAFETY: this live DIR is exclusively borrowed; no other thread or
        // iterator can access it. Copy d_name before the next call invalidates it.
        let entry = unsafe { libc::readdir(pointer.as_ptr()) };
        if entry.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(0) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        // SAFETY: successful readdir returns an initialized, NUL-terminated
        // d_name valid until the next call on this same DIR. Do not retain it.
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if name.len() > 255 {
            return Err(io::Error::from_raw_os_error(libc::ENAMETOOLONG));
        }
        let mut owned = Vec::new();
        owned
            .try_reserve(name.len())
            .map_err(|error| io::Error::new(io::ErrorKind::OutOfMemory, error))?;
        owned.extend_from_slice(name);
        Ok(Some(OsString::from_vec(owned)))
    }
    fn close(mut self) -> io::Result<()> {
        if let Some(pointer) = self.0.take() {
            // SAFETY: exactly one successful fdopendir transferred this DIR.
            // Take before closing: closedir failure must NEVER cause a retry on
            // a potentially reused descriptor during Drop.
            if unsafe { libc::closedir(pointer.as_ptr()) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}
impl Drop for Stream {
    fn drop(&mut self) {
        if let Some(pointer) = self.0.take() {
            // SAFETY: fallback for panic/unwind only, unique still-owned DIR.
            if unsafe { libc::closedir(pointer.as_ptr()) } != 0 {
                // Unwinding cannot return a typed cleanup error. This static
                // secret-blind diagnostic is not a successful scan receipt.
                eprintln!("native directory unwind cleanup failed");
            }
        }
    }
}

pub(crate) fn list(fd: OwnedFd, limit: usize) -> Result<Vec<OsString>, DirectoryError> {
    let mut stream = Stream::open(fd).map_err(DirectoryError::Io)?;
    let result = (|| {
        let mut names = Vec::new();
        while let Some(name) = stream.next().map_err(DirectoryError::Io)? {
            if name == "." || name == ".." {
                continue;
            }
            if names.len() == limit {
                return Err(DirectoryError::Limit);
            }
            names.try_reserve(1).map_err(|error| {
                DirectoryError::Io(io::Error::new(io::ErrorKind::OutOfMemory, error))
            })?;
            names.push(name);
        }
        names.sort();
        if names.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(DirectoryError::Io(io::Error::new(
                io::ErrorKind::InvalidData,
                "native directory repeated a name",
            )));
        }
        Ok(names)
    })();
    let closed = stream.close();
    match (result, closed) {
        (Ok(names), Ok(())) => Ok(names),
        (Err(primary), Ok(())) => Err(primary),
        (Ok(_), Err(error)) => Err(DirectoryError::Io(error)),
        (Err(primary), Err(close)) => Err(DirectoryError::Cleanup {
            primary: Box::new(primary),
            close,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn failed_fdopendir_closes_owned_descriptor() {
        let file = std::fs::File::open(std::env::current_exe().unwrap()).unwrap();
        let fd = nix::fcntl::fcntl(&file, nix::fcntl::FcntlArg::F_DUPFD_CLOEXEC(200)).unwrap();
        // SAFETY: fcntl just returned a new owned descriptor, transferred once.
        let owned = unsafe { <OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fd) };
        assert_eq!(
            Stream::open(owned).err().unwrap().raw_os_error(),
            Some(libc::ENOTDIR)
        );
        // SAFETY: fcntl may inspect an arbitrary descriptor number, including a
        // closed one. The high descriptor avoids reuse by parallel test fixtures.
        assert_eq!(unsafe { libc::fcntl(fd, libc::F_GETFD) }, -1);
        assert_eq!(Errno::last(), Errno::EBADF);
    }
}
