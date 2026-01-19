use std::{ffi::c_void, mem, os::windows::ffi::OsStrExt, ptr};

use windows_sys::Win32::{
    Foundation::{LocalFree, HANDLE, PSID},
    Security::{
        Authorization::{ConvertStringSidToSidW, SetEntriesInAclW, GRANT_ACCESS},
        CopySid, CreateRestrictedToken, CreateWellKnownSid, GetLengthSid, GetTokenInformation,
        SetTokenInformation, TokenDefaultDacl, TokenGroups, WinWorldSid, ACL,
        DISABLE_MAX_PRIVILEGE, LUA_TOKEN, SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT,
        TOKEN_ASSIGN_PRIMARY, TOKEN_DEFAULT_DACL, TOKEN_DUPLICATE, TOKEN_GROUPS, TOKEN_QUERY,
        WRITE_RESTRICTED,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

use crate::{acl::explicit_access, OwnedWin32Handle, Win32Error};

const SECURITY_MAX_SID_SIZE: usize = 68;
const SE_GROUP_LOGON_ID: u32 = 0xc000_0000;
const FILE_ALL_ACCESS: u32 = 0x001f_01ff;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenMode {
    ReadOnly,
    WorkspaceWrite,
}

/// SID storage allocated by ConvertStringSidToSidW and released by LocalFree.
pub struct Sid(PSID);

impl Sid {
    pub fn from_string(value: &std::ffi::OsStr) -> Result<Self, Win32Error> {
        let wide = value.encode_wide().chain(Some(0)).collect::<Vec<_>>();
        let mut sid = ptr::null_mut();
        // SAFETY: value is NUL-terminated and sid is a valid output slot.
        let ok = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if ok == 0 || sid.is_null() {
            Err(Win32Error::last("ConvertStringSidToSidW"))
        } else {
            Ok(Self(sid))
        }
    }

    pub(crate) const fn as_ptr(&self) -> PSID {
        self.0
    }
}

unsafe impl Send for Sid {}
unsafe impl Sync for Sid {}

impl Drop for Sid {
    fn drop(&mut self) {
        // SAFETY: ConvertStringSidToSidW returns LocalAlloc storage.
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub struct RestrictedToken {
    handle: OwnedWin32Handle,
}

impl RestrictedToken {
    pub fn new(mode: TokenMode, capability_sids: &[&Sid]) -> Result<Self, Win32Error> {
        if mode == TokenMode::WorkspaceWrite && capability_sids.is_empty() {
            return Err(Win32Error::code("CreateRestrictedToken", 87));
        }
        let current = open_current_token()?;
        let logon = find_logon_sid(current.as_raw())?;
        let world = world_sid()?;
        let mut restricting = vec![
            SID_AND_ATTRIBUTES {
                Sid: logon.as_ptr().cast_mut().cast(),
                Attributes: 0,
            },
            SID_AND_ATTRIBUTES {
                Sid: world.as_ptr().cast_mut().cast(),
                Attributes: 0,
            },
        ];
        if mode == TokenMode::WorkspaceWrite {
            restricting.extend(capability_sids.iter().map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid.as_ptr(),
                Attributes: 0,
            }));
        }
        let mut raw: HANDLE = 0;
        // SAFETY: all SID pointers remain live and the output handle slot is valid.
        let ok = unsafe {
            CreateRestrictedToken(
                current.as_raw(),
                DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
                0,
                ptr::null(),
                0,
                ptr::null(),
                restricting.len() as u32,
                restricting.as_ptr(),
                &mut raw,
            )
        };
        if ok == 0 {
            return Err(Win32Error::last("CreateRestrictedToken"));
        }
        // SAFETY: CreateRestrictedToken transfers an owned token handle.
        let handle = unsafe { OwnedWin32Handle::from_raw(raw) }
            .ok_or_else(|| Win32Error::last("CreateRestrictedToken"))?;
        let default_sid = capability_sids
            .last()
            .map_or(world.as_ptr().cast_mut().cast(), |sid| sid.as_ptr());
        grant_default_dacl(handle.as_raw(), default_sid)?;
        Ok(Self { handle })
    }

    pub const fn as_raw_handle(&self) -> HANDLE {
        self.handle.as_raw()
    }
}

fn open_current_token() -> Result<OwnedWin32Handle, Win32Error> {
    let mut raw = 0;
    // SAFETY: pseudo process handle is valid and raw is an output slot.
    let ok = unsafe {
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
            &mut raw,
        )
    };
    if ok == 0 {
        return Err(Win32Error::last("OpenProcessToken"));
    }
    // SAFETY: OpenProcessToken transfers one owned handle.
    unsafe { OwnedWin32Handle::from_raw(raw) }.ok_or_else(|| Win32Error::last("OpenProcessToken"))
}

fn aligned_buffer(byte_len: u32) -> Vec<usize> {
    let words = (byte_len as usize).div_ceil(mem::size_of::<usize>());
    vec![0; words]
}

fn find_logon_sid(token: HANDLE) -> Result<Vec<u8>, Win32Error> {
    let mut needed = 0;
    // SAFETY: null buffer with zero length is the documented size query.
    unsafe {
        GetTokenInformation(token, TokenGroups, ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(Win32Error::last("GetTokenInformation(TokenGroups size)"));
    }
    let mut storage = aligned_buffer(needed);
    // SAFETY: storage has at least needed bytes and suitable alignment.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenGroups,
            storage.as_mut_ptr().cast::<c_void>(),
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(Win32Error::last("GetTokenInformation(TokenGroups)"));
    }
    let groups = storage.as_ptr().cast::<TOKEN_GROUPS>();
    // SAFETY: GetTokenInformation initialized a TOKEN_GROUPS record.
    let count = unsafe { (*groups).GroupCount } as usize;
    // SAFETY: Groups is the first element of the variable-length array.
    let first = unsafe { ptr::addr_of!((*groups).Groups).cast::<SID_AND_ATTRIBUTES>() };
    for index in 0..count {
        // SAFETY: TokenGroups reports count consecutive SID_AND_ATTRIBUTES.
        let group = unsafe { &*first.add(index) };
        if group.Attributes & SE_GROUP_LOGON_ID != SE_GROUP_LOGON_ID {
            continue;
        }
        // SAFETY: group Sid is valid for the token-information buffer lifetime.
        let length = unsafe { GetLengthSid(group.Sid) };
        if length == 0 {
            return Err(Win32Error::last("GetLengthSid"));
        }
        let mut copy = vec![0u8; length as usize];
        // SAFETY: destination has length bytes and source SID remains live.
        if unsafe { CopySid(length, copy.as_mut_ptr().cast(), group.Sid) } == 0 {
            return Err(Win32Error::last("CopySid"));
        }
        return Ok(copy);
    }
    Err(Win32Error::code("GetTokenInformation(no logon SID)", 1168))
}

fn world_sid() -> Result<Vec<u8>, Win32Error> {
    let mut sid = vec![0u8; SECURITY_MAX_SID_SIZE];
    let mut size = sid.len() as u32;
    // SAFETY: sid is a writable buffer of size bytes.
    let ok = unsafe {
        CreateWellKnownSid(
            WinWorldSid,
            ptr::null_mut(),
            sid.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if ok == 0 {
        return Err(Win32Error::last("CreateWellKnownSid"));
    }
    sid.truncate(size as usize);
    Ok(sid)
}

fn grant_default_dacl(token: HANDLE, sid: PSID) -> Result<(), Win32Error> {
    let mut needed = 0;
    // SAFETY: null-buffer size query.
    unsafe {
        GetTokenInformation(token, TokenDefaultDacl, ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(Win32Error::last(
            "GetTokenInformation(TokenDefaultDacl size)",
        ));
    }
    let mut storage = aligned_buffer(needed);
    // SAFETY: storage is suitably aligned and at least needed bytes.
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenDefaultDacl,
            storage.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(Win32Error::last("GetTokenInformation(TokenDefaultDacl)"));
    }
    // SAFETY: buffer begins with TOKEN_DEFAULT_DACL.
    let current = unsafe { (*storage.as_ptr().cast::<TOKEN_DEFAULT_DACL>()).DefaultDacl };
    if current.is_null() {
        return Err(Win32Error::code("TokenDefaultDacl(null)", 1338));
    }
    let entry = explicit_access(sid, GRANT_ACCESS, FILE_ALL_ACCESS);
    let mut merged: *mut ACL = ptr::null_mut();
    // SAFETY: entry/current live and merged is an output slot.
    let status = unsafe { SetEntriesInAclW(1, &entry, current, &mut merged) };
    if status != 0 {
        return Err(Win32Error::code(
            "SetEntriesInAclW(TokenDefaultDacl)",
            status,
        ));
    }
    let info = TOKEN_DEFAULT_DACL {
        DefaultDacl: merged,
    };
    // SAFETY: SetTokenInformation copies this complete structure and ACL.
    let ok = unsafe {
        SetTokenInformation(
            token,
            TokenDefaultDacl,
            (&info as *const TOKEN_DEFAULT_DACL).cast(),
            mem::size_of::<TOKEN_DEFAULT_DACL>() as u32,
        )
    };
    // SAFETY: SetEntriesInAclW allocated merged with LocalAlloc.
    unsafe {
        LocalFree(merged.cast());
    }
    if ok == 0 {
        return Err(Win32Error::last("SetTokenInformation(TokenDefaultDacl)"));
    }
    Ok(())
}
