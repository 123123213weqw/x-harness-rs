use std::{ffi::c_void, os::windows::ffi::OsStrExt, path::Path, ptr};

use windows_sys::Win32::{
    Foundation::{LocalFree, ERROR_SUCCESS, PSID},
    Security::{
        Authorization::{
            GetNamedSecurityInfoW, SetEntriesInAclW, SetNamedSecurityInfoW, EXPLICIT_ACCESS_W,
            GRANT_ACCESS, NO_MULTIPLE_TRUSTEE, REVOKE_ACCESS, SE_FILE_OBJECT, TRUSTEE_IS_SID,
            TRUSTEE_IS_UNKNOWN, TRUSTEE_W,
        },
        ACL, DACL_SECURITY_INFORMATION, SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    },
};

use crate::{Sid, Win32Error};

const STANDARD_RIGHTS_WRITE: u32 = 0x0002_0000;
const FILE_GENERIC_WRITE: u32 = 0x0012_0116;
const DELETE: u32 = 0x0001_0000;
const FILE_DELETE_CHILD: u32 = 0x0040;
const GRANT_MASK: u32 = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & !STANDARD_RIGHTS_WRITE;

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: security APIs allocate this block with LocalAlloc.
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

pub(crate) fn explicit_access(sid: PSID, mode: i32, permissions: u32) -> EXPLICIT_ACCESS_W {
    EXPLICIT_ACCESS_W {
        grfAccessPermissions: permissions,
        grfAccessMode: mode,
        grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: ptr::null_mut(),
            MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid.cast::<u16>(),
        },
    }
}

pub fn grant_write(path: &Path, sid: &Sid) -> Result<(), Win32Error> {
    merge_access(path, sid, GRANT_ACCESS, GRANT_MASK)
}

pub fn revoke_write(path: &Path, sid: &Sid) -> Result<(), Win32Error> {
    merge_access(path, sid, REVOKE_ACCESS, 0)
}

fn merge_access(path: &Path, sid: &Sid, mode: i32, permissions: u32) -> Result<(), Win32Error> {
    let wide = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut old_acl: *mut ACL = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    // SAFETY: all optional outputs are null, and the live UTF-16 buffer and
    // output pointers match the documented GetNamedSecurityInfoW contract.
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut old_acl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(Win32Error::code("GetNamedSecurityInfoW", status));
    }
    let _descriptor = LocalAllocation(descriptor);
    let entry = explicit_access(sid.as_ptr(), mode, permissions);
    let mut new_acl: *mut ACL = ptr::null_mut();
    // SAFETY: entry and old ACL remain live; the API allocates new_acl.
    let status = unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut new_acl) };
    if status != ERROR_SUCCESS {
        return Err(Win32Error::code("SetEntriesInAclW", status));
    }
    let _new_acl = LocalAllocation(new_acl.cast());
    // SAFETY: the path and merged ACL stay live for the call. Null owner,
    // group, and SACL preserve those portions of the descriptor.
    let status = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            new_acl,
            ptr::null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(Win32Error::code("SetNamedSecurityInfoW", status));
    }
    Ok(())
}
