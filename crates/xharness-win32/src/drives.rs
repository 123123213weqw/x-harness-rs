use std::path::PathBuf;

use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;

use crate::Win32Error;

/// Enumerate assigned drive letters without opening or probing their media.
/// A listed drive can still be disconnected or unreadable when selected.
pub fn logical_drive_roots() -> Result<Vec<PathBuf>, Win32Error> {
    // SAFETY: GetLogicalDrives has no arguments or pointer preconditions.
    let mask = unsafe { GetLogicalDrives() };
    if mask == 0 {
        return Err(Win32Error::last("GetLogicalDrives"));
    }
    Ok(roots_from_mask(mask))
}

fn roots_from_mask(mask: u32) -> Vec<PathBuf> {
    (0..26)
        .filter(|bit| mask & (1 << bit) != 0)
        .map(|bit| PathBuf::from(format!("{}:\\", char::from(b'A' + bit))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mask_preserves_all_assigned_letters_in_order() {
        assert_eq!(
            roots_from_mask((1 << 2) | (1 << 3) | (1 << 25) | (1 << 31)),
            [r"C:\", r"D:\", r"Z:\"].map(PathBuf::from)
        );
        assert!(roots_from_mask(0).is_empty());
        assert_eq!(roots_from_mask(u32::MAX).len(), 26);
    }

    #[test]
    fn native_drive_roots_are_absolute() {
        let roots = logical_drive_roots().expect("GetLogicalDrives");
        assert!(!roots.is_empty());
        assert!(roots.iter().all(|root| root.is_absolute()));
    }
}
