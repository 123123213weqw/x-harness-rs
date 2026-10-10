//! Bounded, versioned private transport. Screenshots are binary, not Base64.
#![cfg_attr(not(windows), allow(dead_code))]
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use xharness_computer::{ComputerError, ComputerRequest, Region};

pub const MAX_REQUEST: usize = 128 * 1024;
pub const MAX_METADATA: usize = 1024 * 1024;
pub const MAX_PNG: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Surface {
    pub handle: u64,
    pub pid: u32,
    pub class: String,
    pub bounds: Region,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NodeTarget {
    pub surface: Surface,
    pub path: Vec<u32>,
    pub runtime_id: Vec<i32>,
    pub snapshot: NodeSnapshot,
}

/// Private target semantics, not a global page revision or an age-based lease.
/// Hash the COMPLETE provider name, not the truncated model-facing label.
/// The bounded digest never exposes hidden name text through this transport.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NodeSnapshot {
    pub name_sha256: [u8; 32],
    pub control_type: i32,
    pub bounds: Region,
}
impl NodeSnapshot {
    pub fn new(name: &str, control_type: i32, bounds: Region) -> Self {
        Self {
            name_sha256: Sha256::digest(name.as_bytes()).into(),
            control_type,
            bounds,
        }
    }
    pub fn verify(&self, actual: &Self) -> Result<(), ComputerError> {
        if self != actual {
            return Err(ComputerError::retryable(
                "stale_node",
                "target name, role or bounds changed; observe again; no input dispatched",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub desktop: Region,
    pub foreground: Option<Surface>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema: u32,
    pub request: ComputerRequest,
    pub frame: Option<Frame>,
    pub node: Option<NodeTarget>,
    pub surface: Option<Surface>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WireError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}
impl From<ComputerError> for WireError {
    fn from(e: ComputerError) -> Self {
        Self {
            code: e.code,
            message: e.message,
            retryable: e.retryable,
        }
    }
}
impl From<WireError> for ComputerError {
    fn from(e: WireError) -> Self {
        Self {
            code: e.code,
            message: e.message,
            retryable: e.retryable,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub schema: u32,
    pub value: Value,
    pub error: Option<WireError>,
    pub frame: Option<Frame>,
    pub nodes: Vec<(String, NodeTarget)>,
    pub surfaces: Vec<(String, Surface)>,
    pub png_len: usize,
}

pub fn read_packet(reader: &mut impl Read, max: usize) -> io::Result<Vec<u8>> {
    let mut header = [0; 4];
    reader.read_exact(&mut header)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "computer packet length is invalid",
        ));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}
pub fn write_packet(writer: &mut impl Write, bytes: &[u8], max: usize) -> io::Result<()> {
    if bytes.is_empty() || bytes.len() > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "computer packet length is invalid",
        ));
    }
    writer.write_all(&(bytes.len() as u32).to_le_bytes())?;
    writer.write_all(bytes)?;
    writer.flush()
}

pub const MAX_TREE_DEPTH: usize = 32;

/// An acceptance-only experiment, never a model/RPC option or production mode.
#[cfg(feature = "native-acceptance")]
pub fn visible_view_experiment(enabled: Option<&str>, disposable_vm: Option<&str>) -> bool {
    enabled == Some("1") && disposable_vm == Some("66b64058-bdcc-43e9-85ee-55a79fe2e875")
}

// Windows browser providers use deep framework wrappers before page content.
// Depth and node/visit/time budgets are independent; raising depth never
// permits an unbounded tree or changes the macOS adapter.
pub fn budget(detail: Option<&str>) -> (usize, usize) {
    match detail {
        Some("low") => (80, 12),
        Some("semantic") => (300, 24),
        Some("high") => (500, MAX_TREE_DEPTH),
        _ => (220, 20),
    }
}

pub fn surface_id(s: &Surface) -> String {
    format!("win:{}:{:x}", s.pid, s.handle)
}

/// SendInput absolute coordinates cover the whole virtual desktop, including
/// negative origins. The last physical pixel maps to 65535, not 65536.
pub fn absolute_axis(point: f64, origin: f64, extent: f64) -> Result<i32, ComputerError> {
    if !point.is_finite()
        || !origin.is_finite()
        || !extent.is_finite()
        || extent <= 1.0
        || point < origin
        || point > origin + extent - 1.0
    {
        return Err(ComputerError::invalid(
            "point is outside the physical virtual desktop",
        ));
    }
    Ok(((point - origin) * 65535.0 / (extent - 1.0)).round() as i32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn snapshot(name: &str) -> NodeSnapshot {
        NodeSnapshot::new(
            name,
            50000,
            Region {
                x: 1.0,
                y: 2.0,
                width: 30.0,
                height: 40.0,
            },
        )
    }
    #[test]
    fn target_freshness_is_semantic_not_elapsed_time() {
        let original = snapshot("Confirm");
        assert!(original.verify(&snapshot("Confirm")).is_ok());
        for changed in [
            snapshot("Delete"),
            NodeSnapshot {
                control_type: 50004,
                ..original.clone()
            },
            NodeSnapshot {
                bounds: Region {
                    x: 2.0,
                    ..original.bounds
                },
                ..original.clone()
            },
        ] {
            let error = original.verify(&changed).unwrap_err();
            assert_eq!(error.code, "stale_node");
            assert!(error.message.contains("no input dispatched"));
        }
    }
    #[test]
    fn name_guard_covers_text_beyond_display_truncation() {
        let prefix = "x".repeat(300);
        assert_ne!(snapshot(&(prefix.clone() + "A")), snapshot(&(prefix + "B")));
    }
    #[test]
    fn missing_private_snapshot_cannot_disable_freshness_guard() {
        let target = serde_json::json!({
            "surface": {"handle":1,"pid":2,"class":"fixture","bounds":{"x":0,"y":0,"width":100,"height":100}},
            "path":[0],"runtime_id":[1,2,3]
        });
        assert!(serde_json::from_value::<NodeTarget>(target).is_err());
    }
    #[cfg(feature = "native-acceptance")]
    #[test]
    fn visible_view_requires_explicit_flag_and_exact_disposable_vm() {
        let vm = Some("66b64058-bdcc-43e9-85ee-55a79fe2e875");
        assert!(visible_view_experiment(Some("1"), vm));
        for enabled in [None, Some("0"), Some("true"), Some("1 ")] {
            assert!(!visible_view_experiment(enabled, vm));
        }
        for identity in [None, Some("other-machine"), Some("")] {
            assert!(!visible_view_experiment(Some("1"), identity));
        }
    }
    #[test]
    fn packet_is_bounded_before_allocation() {
        for n in [0u32, 129, u32::MAX] {
            assert!(read_packet(&mut Cursor::new(n.to_le_bytes()), 128).is_err());
        }
        assert!(read_packet(&mut Cursor::new([4, 0, 0, 0, 1]), 128).is_err());
        let mut bytes = vec![];
        write_packet(&mut bytes, b"hello", 128).unwrap();
        assert_eq!(read_packet(&mut Cursor::new(bytes), 128).unwrap(), b"hello");
    }
    #[test]
    fn coordinates_handle_negative_origin_and_endpoints() {
        assert_eq!(absolute_axis(-1920.0, -1920.0, 3840.0).unwrap(), 0);
        assert_eq!(absolute_axis(1919.0, -1920.0, 3840.0).unwrap(), 65535);
        for p in [1920.0, -1921.0, f64::NAN, f64::INFINITY] {
            assert!(absolute_axis(p, -1920.0, 3840.0).is_err());
        }
    }
    #[test]
    fn budgets_are_finite() {
        assert_eq!(budget(None), (220, 20));
        assert_eq!(budget(Some("low")), (80, 12));
        assert_eq!(budget(Some("high")), (500, MAX_TREE_DEPTH));
        assert_eq!(budget(Some("semantic")), (300, 24));
    }
}
