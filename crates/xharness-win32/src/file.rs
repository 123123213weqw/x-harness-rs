use std::{io, os::windows::ffi::OsStrExt, path::Path, ptr};

use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

/// Atomically replace an existing file with a closed same-volume staging file.
/// Windows preserves the replaced file's ACL and replacement metadata.
pub fn replace_file(replaced: &Path, replacement: &Path) -> io::Result<()> {
    let replaced = wide_path(replaced);
    let replacement = wide_path(replacement);
    // SAFETY: both buffers are live NUL-terminated UTF-16 paths; optional
    // backup/exclusion/reserved pointers are intentionally null.
    let ok = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            ptr::null(),
            0,
            ptr::null_mut(),
            ptr::null_mut(),
        )
    };
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
