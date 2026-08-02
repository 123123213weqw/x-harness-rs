//! One durable candidate, not a second downloader/installer. The live Tauri
//! manifest supplies identity; local metadata is never a source of authority.
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use serde::{Deserialize, Serialize};

const MAX_PACKAGE: u64 = 1024 * 1024 * 1024;
const MAX_RECORD: u64 = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Identity {
    pub endpoint: String,
    pub public_key: String,
    pub version: String,
    pub target: String,
    pub url: String,
    pub signature: String,
}

#[derive(Clone, Debug)]
pub(super) struct PreparedPackage {
    directory: PathBuf,
    identity: Identity,
    pub len: u64,
}

impl PreparedPackage {
    pub fn directory(&self) -> PathBuf {
        self.directory.clone()
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: u32,
    identity: Identity,
    len: u64,
}

fn regular(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > limit {
        return Err("更新缓存不是普通文件或超出容量上限".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("更新缓存超出容量上限".into());
    }
    Ok(bytes)
}

fn directory(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_dir() {
        return Err("更新缓存目录不能是符号链接或普通文件".into());
    }
    Ok(())
}

fn verify(bytes: &[u8], identity: &Identity) -> Result<(), String> {
    for value in [&identity.endpoint, &identity.url] {
        let url = url::Url::parse(value).map_err(|e| e.to_string())?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("更新缓存必须绑定 HTTPS 地址".into());
        }
    }
    let decode = |value: &str| -> Result<String, String> {
        String::from_utf8(STANDARD.decode(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())
    };
    let key = PublicKey::decode(&decode(&identity.public_key)?).map_err(|e| e.to_string())?;
    let signature = Signature::decode(&decode(&identity.signature)?).map_err(|e| e.to_string())?;
    // Same Minisign ED/Ed verification and trusted-comment validation as Tauri.
    key.verify(bytes, &signature, true)
        .map_err(|e| format!("更新缓存验签失败：{e}"))
}

impl PreparedPackage {
    // Re-read and verify BEFORE stopping Host. Do not rely on an earlier check
    // or a checksum stored next to the payload, which could also be modified.
    pub fn read_verified(&self) -> Result<Vec<u8>, String> {
        directory(&self.directory)?;
        let record: Record =
            serde_json::from_slice(&regular(&self.directory.join("record.json"), MAX_RECORD)?)
                .map_err(|e| e.to_string())?;
        if record.schema != 1 || record.identity != self.identity || record.len != self.len {
            return Err("更新缓存与已核实的候选版本不匹配".into());
        }
        let bytes = regular(&self.directory.join("package.bin"), MAX_PACKAGE)?;
        if bytes.is_empty() || bytes.len() as u64 != self.len {
            return Err("更新缓存不完整".into());
        }
        verify(&bytes, &self.identity)?;
        Ok(bytes)
    }
}

pub(super) fn restore(root: &Path, identity: &Identity) -> Result<Option<PreparedPackage>, String> {
    Ok(load(root, identity)?.map(|(package, _)| package))
}

pub(super) fn load(
    root: &Path,
    identity: &Identity,
) -> Result<Option<(PreparedPackage, Vec<u8>)>, String> {
    if !root.exists() {
        return Ok(None);
    }
    directory(root)?;
    let current = root.join("current");
    if !current.exists() {
        return Ok(None);
    }
    directory(&current)?;
    let record: Record =
        serde_json::from_slice(&regular(&current.join("record.json"), MAX_RECORD)?)
            .map_err(|e| e.to_string())?;
    // New version/architecture/feed/key/signature never reuse the previous candidate.
    if record.schema != 1 || &record.identity != identity {
        return Ok(None);
    }
    let prepared = PreparedPackage {
        directory: current,
        identity: identity.clone(),
        len: record.len,
    };
    let bytes = prepared.read_verified()?;
    Ok(Some((prepared, bytes)))
}

pub(super) fn save(
    root: &Path,
    identity: Identity,
    bytes: &[u8],
) -> Result<PreparedPackage, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_PACKAGE {
        return Err("更新包为空或超出容量上限".into());
    }
    verify(bytes, &identity)?;
    let record = serde_json::to_vec(&Record {
        schema: 1,
        identity: identity.clone(),
        len: bytes.len() as u64,
    })
    .map_err(|e| e.to_string())?;
    if record.len() as u64 > MAX_RECORD {
        return Err("更新缓存描述超出容量上限".into());
    }
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    directory(root)?;
    // Recoverable misses are preferable to publishing incomplete bytes. Only
    // our private cache generations are removed, never application/user data.
    clear(root, "previous")?;
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_name().to_string_lossy().starts_with(".prepare-") {
            directory(&entry.path())?;
            fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
        }
    }
    let stage = tempfile::Builder::new()
        .prefix(".prepare-")
        .tempdir_in(root)
        .map_err(|e| e.to_string())?;
    let write = |name: &str, data: &[u8]| -> Result<(), String> {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage.path().join(name))
            .map_err(|e| e.to_string())?;
        f.write_all(data)
            .and_then(|_| f.sync_all())
            .map_err(|e| e.to_string())
    };
    write("package.bin", bytes)?;
    write("record.json", &record)?;
    let current = root.join("current");
    let previous = root.join("previous");
    if current.exists() {
        directory(&current)?;
        fs::rename(&current, &previous).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::rename(stage.path(), &current) {
        if previous.exists() {
            let _ = fs::rename(&previous, &current);
        }
        return Err(format!("发布更新缓存失败：{e}"));
    }
    clear(root, "previous")?;
    Ok(PreparedPackage {
        directory: current,
        identity,
        len: bytes.len() as u64,
    })
}

fn clear(root: &Path, name: &str) -> Result<(), String> {
    let path = root.join(name);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
        Ok(_) => {
            directory(&path)?;
            fs::remove_dir_all(path).map_err(|e| e.to_string())
        }
    }
}

pub(super) fn discard(root: &Path) -> Result<(), String> {
    if root.exists() {
        directory(root)?;
        clear(root, "current")?;
        clear(root, "previous")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Identity, Vec<u8>) {
        let value: serde_json::Value =
            serde_json::from_str(include_str!("cache-test-signature.json")).unwrap();
        let identity = Identity {
            endpoint: "https://example.com/latest.json".into(),
            public_key: value["publicKey"].as_str().unwrap().into(),
            version: "1.2.3".into(),
            target: "fixture-platform".into(),
            url: "https://example.com/v1.2.3/package".into(),
            signature: value["signature"].as_str().unwrap().into(),
        };
        (
            identity,
            value["payload"].as_str().unwrap().as_bytes().to_vec(),
        )
    }
    #[test]
    fn durable_candidate_reopens_and_signature_is_rechecked() {
        let temp = tempfile::tempdir().unwrap();
        let (id, bytes) = fixture();
        let package = save(temp.path(), id.clone(), &bytes).unwrap();
        drop(package);
        let reopened = restore(temp.path(), &id).unwrap().unwrap();
        assert_eq!(reopened.read_verified().unwrap(), bytes);
        let mut tampered = bytes;
        tampered[0] ^= 1;
        fs::write(temp.path().join("current/package.bin"), tampered).unwrap();
        assert!(reopened.read_verified().is_err());
        assert!(restore(temp.path(), &id).is_err());
    }
    #[test]
    fn identity_drift_never_restores() {
        let temp = tempfile::tempdir().unwrap();
        let (id, bytes) = fixture();
        save(temp.path(), id.clone(), &bytes).unwrap();
        for field in 0..6 {
            let mut next = id.clone();
            match field {
                0 => next.version.push('0'),
                1 => next.target.push('x'),
                2 => next.url.push('x'),
                3 => next.signature.push('x'),
                4 => next.public_key.push('x'),
                _ => next.endpoint.push('x'),
            }
            assert!(restore(temp.path(), &next).unwrap().is_none());
        }
    }
    #[test]
    fn partial_corrupt_and_missing_files_fail_closed_then_redownload() {
        let temp = tempfile::tempdir().unwrap();
        let (id, bytes) = fixture();
        fs::create_dir(temp.path().join(".prepare-interrupted")).unwrap();
        assert!(restore(temp.path(), &id).unwrap().is_none());
        for name in ["record.json", "package.bin"] {
            save(temp.path(), id.clone(), &bytes).unwrap();
            fs::remove_file(temp.path().join("current").join(name)).unwrap();
            assert!(restore(temp.path(), &id).is_err());
        }
        save(temp.path(), id.clone(), &bytes).unwrap();
        fs::write(temp.path().join("current/record.json"), b"broken").unwrap();
        assert!(restore(temp.path(), &id).is_err());
        save(temp.path(), id.clone(), &bytes).unwrap();
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
        discard(temp.path()).unwrap();
        assert!(restore(temp.path(), &id).unwrap().is_none());
    }
    #[test]
    fn bad_signature_or_non_https_never_publishes() {
        let temp = tempfile::tempdir().unwrap();
        let (mut id, bytes) = fixture();
        assert!(save(temp.path(), id.clone(), b"tampered").is_err());
        id.url = "http://example.com/package".into();
        assert!(save(temp.path(), id, &bytes).is_err());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }
    #[cfg(unix)]
    #[test]
    fn symlinks_never_supply_cache_files() {
        let temp = tempfile::tempdir().unwrap();
        let (id, bytes) = fixture();
        let prepared = save(temp.path(), id, &bytes).unwrap();
        fs::write(temp.path().join("external"), &bytes).unwrap();
        fs::remove_file(temp.path().join("current/package.bin")).unwrap();
        std::os::unix::fs::symlink(
            temp.path().join("external"),
            temp.path().join("current/package.bin"),
        )
        .unwrap();
        assert!(prepared.read_verified().is_err());
    }
    #[test]
    fn forged_length_and_oversized_metadata_fail_closed() {
        let temp = tempfile::tempdir().unwrap();
        let (id, bytes) = fixture();
        let prepared = save(temp.path(), id.clone(), &bytes).unwrap();
        fs::write(
            temp.path().join("current/record.json"),
            serde_json::to_vec(&Record {
                schema: 1,
                identity: id,
                len: MAX_PACKAGE + 1,
            })
            .unwrap(),
        )
        .unwrap();
        assert!(prepared.read_verified().is_err());
        fs::write(
            temp.path().join("current/record.json"),
            vec![b' '; MAX_RECORD as usize + 1],
        )
        .unwrap();
        assert!(prepared.read_verified().is_err());
    }

    #[test]
    fn oversized_new_record_preserves_previous_verified_candidate() {
        let temp = tempfile::tempdir().unwrap();
        let (id, bytes) = fixture();
        save(temp.path(), id.clone(), &bytes).unwrap();
        let mut oversized = id.clone();
        oversized.url.push_str(&"x".repeat(MAX_RECORD as usize));
        assert!(save(temp.path(), oversized, &bytes).is_err());
        assert_eq!(load(temp.path(), &id).unwrap().unwrap().1, bytes);
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }
}
