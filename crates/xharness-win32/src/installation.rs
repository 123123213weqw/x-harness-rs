//! Read-only Windows installation facts. No elevation, ACL changes or registry writes.
use crate::{OwnedWin32Handle, Win32Error};
use std::{ffi::OsStr, mem, os::windows::ffi::OsStrExt, ptr};
use windows_sys::Win32::{
    Foundation::{ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_SUCCESS},
    Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY},
    System::{
        Registry::{
            RegCloseKey, RegEnumKeyExW, RegGetValueW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE,
            KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ,
            RRF_RT_REG_SZ,
        },
        Threading::{GetCurrentProcess, OpenProcessToken},
    },
};

pub fn current_process_elevated() -> Result<bool, Win32Error> {
    let mut raw = 0;
    // SAFETY: live process pseudo-handle and valid output slot.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(Win32Error::last("OpenProcessToken"));
    }
    // SAFETY: OpenProcessToken returned an owned token handle.
    let token = unsafe { OwnedWin32Handle::from_raw(raw) }
        .ok_or_else(|| Win32Error::code("OpenProcessToken", 6))?;
    let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut len = 0;
    // SAFETY: correctly sized TOKEN_ELEVATION buffer and valid token.
    if unsafe {
        GetTokenInformation(
            token.as_raw(),
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
    } == 0
    {
        return Err(Win32Error::last("GetTokenInformation"));
    }
    Ok(elevation.TokenIsElevated != 0)
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        // SAFETY: this key is owned, never a predefined registry handle.
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}
fn text(key: HKEY, subkey: &[u16], name: &str) -> Result<Option<String>, Win32Error> {
    let name = wide(name);
    let mut bytes = 0;
    // SAFETY: NUL-terminated inputs, size query has no output buffer.
    let status = unsafe {
        RegGetValueW(
            key,
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut bytes,
        )
    };
    if status == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if status != ERROR_SUCCESS {
        return Err(Win32Error::code("RegGetValueW", status));
    }
    if bytes > 65536 || bytes % 2 != 0 {
        return Err(Win32Error::code("RegGetValueW", 13));
    }
    let mut value = vec![0u16; bytes as usize / 2];
    // SAFETY: buffer capacity matches the queried byte count. Races return an error.
    let status = unsafe {
        RegGetValueW(
            key,
            subkey.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND,
            ptr::null_mut(),
            value.as_mut_ptr().cast(),
            &mut bytes,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(Win32Error::code("RegGetValueW", status));
    }
    Ok(Some(
        String::from_utf16_lossy(&value)
            .trim_end_matches('\0')
            .to_owned(),
    ))
}

/// Tauri NSIS can invoke a detected WiX uninstaller even in /UPDATE mode.
/// Refuse unattended migration if a matching machine-wide MSI is registered.
pub fn machine_msi_registered(product: &str) -> Result<bool, Win32Error> {
    let path = wide(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall");
    for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
        let mut raw = 0;
        // SAFETY: valid predefined hive, NUL-terminated path and output slot.
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                path.as_ptr(),
                0,
                KEY_READ | view,
                &mut raw,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            continue;
        }
        if status != ERROR_SUCCESS {
            return Err(Win32Error::code("RegOpenKeyExW", status));
        }
        let key = Key(raw);
        for index in 0..10000 {
            let mut name = [0u16; 256];
            let mut len = 255;
            // SAFETY: registry subkeys are at most 255 characters; all optional outputs are null.
            let status = unsafe {
                RegEnumKeyExW(
                    key.0,
                    index,
                    name.as_mut_ptr(),
                    &mut len,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                )
            };
            if status == ERROR_NO_MORE_ITEMS {
                break;
            }
            if status != ERROR_SUCCESS {
                return Err(Win32Error::code("RegEnumKeyExW", status));
            }
            name[len as usize] = 0;
            if text(key.0, &name, "DisplayName")?
                .is_some_and(|name| name.eq_ignore_ascii_case(product))
                && text(key.0, &name, "UninstallString")?
                    .is_some_and(|cmd| cmd.to_ascii_lowercase().contains("msiexec"))
            {
                return Ok(true);
            }
            if index == 9999 {
                return Err(Win32Error::code("RegEnumKeyExW", 13));
            }
        }
    }
    Ok(false)
}

/// Only a split-token administrator can elevate as the same Windows user.
/// Standard-user credential elevation would change HKCU and is not migration.
pub fn can_self_elevate() -> Result<bool, Win32Error> {
    use windows_sys::Win32::Security::{TokenElevationType, TokenElevationTypeLimited};
    let mut raw = 0;
    // SAFETY: live process and valid output slot.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw) } == 0 {
        return Err(Win32Error::last("OpenProcessToken"));
    }
    // SAFETY: unique ownership of returned token.
    let token = unsafe { OwnedWin32Handle::from_raw(raw) }
        .ok_or_else(|| Win32Error::last("OpenProcessToken"))?;
    let mut value = 0i32;
    let mut len = 0;
    // SAFETY: correctly sized TOKEN_ELEVATION_TYPE output.
    if unsafe {
        GetTokenInformation(
            token.as_raw(),
            TokenElevationType,
            (&mut value as *mut i32).cast(),
            mem::size_of::<i32>() as u32,
            &mut len,
        )
    } == 0
    {
        return Err(Win32Error::last("GetTokenInformation"));
    }
    Ok(value == TokenElevationTypeLimited)
}

/// Explicit administrator installation only, after the caller obtained consent.
/// Migration never calls this helper. UAC cancellation is returned to the caller.
pub fn launch_elevated(executable: &std::path::Path, arguments: &OsStr) -> Result<(), Win32Error> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOW};
    let file = wide(executable);
    let args = wide(arguments);
    if file[..file.len() - 1].contains(&0) || args[..args.len() - 1].contains(&0) {
        return Err(Win32Error::code("ShellExecuteW", 87));
    }
    let verb = wide("runas");
    // SAFETY: NUL-terminated native inputs. No shell command/code concatenation.
    let result = unsafe {
        ShellExecuteW(
            0,
            verb.as_ptr(),
            file.as_ptr(),
            args.as_ptr(),
            ptr::null(),
            SW_SHOW,
        )
    };
    if result <= 32 {
        return Err(Win32Error::last("ShellExecuteW"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn elevation_queries_do_not_request_uac() {
        let elevated = current_process_elevated().unwrap();
        let split_token = can_self_elevate().unwrap();
        assert!(!(elevated && split_token));
    }
    #[test]
    fn absent_msi_is_not_invented() {
        assert!(!machine_msi_registered(
            "XHarness-no-such-product-4bacf7e0-25be-4ed2-a3a0-978fec78adfa"
        )
        .unwrap());
    }
    #[test]
    fn loaded_executable_access_query_does_not_need_write_handle() {
        // Real executable remains mapped throughout this read-only ACL query.
        assert!(crate::can_replace_file(&std::env::current_exe().unwrap()).unwrap());
    }
}
