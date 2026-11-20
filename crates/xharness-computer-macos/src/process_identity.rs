//! Darwin process-instance metadata. No LaunchServices date, guessed timestamp,
//! process name, executable path or floating-point conversion is involved.
use xharness_computer::ComputerError;

use crate::input_guard::ProcessStart;

// sys/proc_info.h: proc_bsdinfo / PROC_PIDTBSDINFO. Keep all fields (including
// reserved/name fields) for the C ABI; only PID, state and start time are read.
#[repr(C)]
#[derive(Default)]
struct ProcBsdInfo {
    flags: u32,
    status: u32,
    _xstatus: u32,
    pid: u32,
    _ppid: u32,
    _uid: u32,
    _gid: u32,
    _ruid: u32,
    _rgid: u32,
    _svuid: u32,
    _svgid: u32,
    _reserved: u32,
    _comm: [u8; 16],
    _name: [u8; 32],
    _nfiles: u32,
    _pgid: u32,
    _pjobc: u32,
    _tty_device: u32,
    _tty_pgid: u32,
    _nice: i32,
    start_seconds: u64,
    start_microseconds: u64,
}

const BSD_INFO_SIZE: i32 = 136;
const _: () = assert!(std::mem::size_of::<ProcBsdInfo>() == BSD_INFO_SIZE as usize);

fn decode_start(pid: i32, bytes: i32, info: &ProcBsdInfo) -> Result<ProcessStart, ComputerError> {
    if pid <= 0
        || bytes != BSD_INFO_SIZE
        || i64::from(info.pid) != i64::from(pid)
        || info.flags & 4 != 0
        || info.status == 5
    {
        return Err(ComputerError::retryable(
            "input_context_unavailable",
            "foreground process metadata is incomplete, changed or exiting; observe again",
        ));
    }
    ProcessStart::new(info.start_seconds, info.start_microseconds)
}

#[cfg(target_os = "macos")]
#[link(name = "proc")]
extern "C" {
    fn proc_pidinfo(
        pid: i32,
        flavor: i32,
        arg: u64,
        buffer: *mut std::ffi::c_void,
        buffer_size: i32,
    ) -> i32;
}

#[cfg(target_os = "macos")]
pub(crate) fn process_start(pid: i32) -> Result<ProcessStart, ComputerError> {
    if pid <= 0 {
        return Err(ComputerError::retryable(
            "input_context_unavailable",
            "invalid foreground process identity; observe again",
        ));
    }
    let mut info = ProcBsdInfo::default();
    // SAFETY: libproc's documented flavor 3 writes at most buffer_size bytes.
    // The initialized repr(C) struct has the SDK-verified 136-byte layout and
    // remains alive/writable for the synchronous call. Check the complete read
    // and returned PID before using any fields. No borrowed native pointers escape.
    let bytes = unsafe {
        proc_pidinfo(
            pid,
            3,
            0,
            (&mut info as *mut ProcBsdInfo).cast(),
            BSD_INFO_SIZE,
        )
    };
    if bytes <= 0 {
        let error = std::io::Error::last_os_error();
        return Err(ComputerError::retryable(
            "input_context_unavailable",
            format!("kernel foreground process identity unavailable ({error}); observe again"),
        ));
    }
    decode_start(pid, bytes, &info)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> ProcBsdInfo {
        ProcBsdInfo {
            pid: 42,
            start_seconds: 123,
            start_microseconds: 456_789,
            ..Default::default()
        }
    }

    #[test]
    fn sdk_layout_matches_darwin_proc_bsdinfo() {
        assert_eq!(std::mem::size_of::<ProcBsdInfo>(), 136);
        assert_eq!(std::mem::align_of::<ProcBsdInfo>(), 8);
        assert_eq!(std::mem::offset_of!(ProcBsdInfo, pid), 12);
        assert_eq!(std::mem::offset_of!(ProcBsdInfo, start_seconds), 120);
        assert_eq!(std::mem::offset_of!(ProcBsdInfo, start_microseconds), 128);
    }

    #[test]
    fn complete_matching_kernel_metadata_produces_an_exact_instance_identity() {
        assert_eq!(
            decode_start(42, 136, &valid()).unwrap(),
            ProcessStart::new(123, 456_789).unwrap()
        );
        let other = ProcBsdInfo {
            start_microseconds: 456_790,
            ..valid()
        };
        assert_ne!(
            decode_start(42, 136, &valid()).unwrap(),
            decode_start(42, 136, &other).unwrap()
        );
    }

    #[test]
    fn denied_short_oversized_mismatched_exited_and_invalid_metadata_never_default() {
        for bytes in [-1, 0, 135, 137] {
            assert_eq!(
                decode_start(42, bytes, &valid()).unwrap_err().code,
                "input_context_unavailable"
            );
        }
        for (pid, info) in [
            (0, valid()),
            (-1, valid()),
            (43, valid()),
            (
                42,
                ProcBsdInfo {
                    flags: 4,
                    ..valid()
                },
            ),
            (
                42,
                ProcBsdInfo {
                    status: 5,
                    ..valid()
                },
            ),
            (
                42,
                ProcBsdInfo {
                    start_seconds: 0,
                    ..valid()
                },
            ),
            (
                42,
                ProcBsdInfo {
                    start_microseconds: 1_000_000,
                    ..valid()
                },
            ),
        ] {
            assert!(decode_start(pid, 136, &info).is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn actual_kernel_identity_works_for_the_directly_executed_test_process() {
        let pid = i32::try_from(std::process::id()).unwrap();
        assert_eq!(process_start(pid).unwrap(), process_start(pid).unwrap());
        for pid in [-1, 0, i32::MAX] {
            assert!(process_start(pid).is_err());
        }
    }
}
