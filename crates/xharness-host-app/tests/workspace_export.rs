#![cfg(any(target_os = "linux", target_os = "macos"))]
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, time::Duration};
use xharness_cloud::Id;
use xharness_fs::{workspace_apply::ApplyError, FsService, ObservationStore};
use xharness_host_app::{
    workspace_executor::WorkspacePair,
    workspace_export::{BlobRequest, ExportError, Snapshot, WorkspaceExport, MAX_EXPORT_BYTES},
};

struct Fixture {
    root: PathBuf,
    source: FsService,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xh-export-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        for name in ["source", "peer", "source-control", "peer-control"] {
            fs::create_dir(root.join(name)).unwrap();
            fs::set_permissions(root.join(name), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let open = |name: &str, nonce: &str| {
            let control = root.join(format!("{name}-control"));
            FsService::new(root.join(name))
                .unwrap()
                .provision_sync_control(&FsService::new(&control).unwrap(), nonce)
                .unwrap();
            FsService::with_sync_control(
                root.join(name),
                ObservationStore::default(),
                control,
                nonce,
            )
            .unwrap()
        };
        let source = open("source", &"a".repeat(64));
        let peer = open("peer", &"b".repeat(64));
        WorkspacePair::new(
            &source,
            &peer,
            Id::new("probe").unwrap(),
            Id::new("source").unwrap(),
            Id::new("peer").unwrap(),
        )
        .unwrap()
        .register_new_pair()
        .unwrap();
        Self { root, source }
    }
    fn export(&self) -> WorkspaceExport {
        WorkspaceExport::new(self.source.clone(), "c".repeat(64)).unwrap()
    }
    fn write(&self, name: &str, bytes: &[u8]) {
        fs::write(self.root.join("source").join(name), bytes).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn request(snapshot: &Snapshot) -> BlobRequest {
    let file = &snapshot.files[0];
    BlobRequest {
        path: file.path.clone(),
        exact: file.exact.clone(),
        sha256: file.sha256.clone(),
        bytes: file.bytes,
    }
}

#[test]
fn binary_unicode_native_versions_exclusions_and_no_control_disclosure() {
    let f = Fixture::new();
    let payload: Vec<_> = (0..524_299).map(|i| (i % 251) as u8).collect();
    f.write("中文.bin", &payload);
    for path in [".env", ".env.production", "private.pem"] {
        f.write(path, b"excluded");
    }
    let export = f.export();
    let snapshot = export.snapshot().unwrap();
    assert_eq!(snapshot.files.len(), 1);
    assert_eq!(snapshot.files[0].path, "中文.bin");
    let mut read = request(&snapshot);
    assert_eq!(export.blob(&read).unwrap(), payload);
    for path in [
        ".env",
        ".xh-sync-active",
        "../source-control/.xh-sync-base",
        "/etc/passwd",
    ] {
        read.path = path.into();
        assert!(export.blob(&read).is_err());
    }
    read = request(&snapshot);
    f.write("中文.bin", b"changed");
    assert!(matches!(
        export.blob(&read),
        Err(ExportError::Native(ApplyError::Changed))
    ));
}

#[test]
fn read_endpoint_rechecks_private_authority_busy_and_limits_without_truncation() {
    let f = Fixture::new();
    let export = f.export();
    let user = f.source.workspace_use().unwrap();
    assert!(matches!(
        export.snapshot(),
        Err(ExportError::Native(ApplyError::Busy))
    ));
    drop(user);
    let file = fs::File::create(f.root.join("source/large")).unwrap();
    file.set_len(MAX_EXPORT_BYTES as u64 + 1).unwrap();
    assert!(export.snapshot().is_err());
    fs::remove_file(f.root.join("source/large")).unwrap();
    fs::remove_file(f.root.join("source-control/.xh-sync-registration")).unwrap();
    assert!(export.snapshot().is_err());
}

#[test]
fn symlinks_hardlinks_and_wrong_claims_never_return_bytes() {
    let f = Fixture::new();
    f.write("one", b"data");
    let export = f.export();
    let mut read = request(&export.snapshot().unwrap());
    read.sha256 = "f".repeat(64);
    assert!(export.blob(&read).is_err());
    read.bytes = MAX_EXPORT_BYTES as u64 + 1;
    assert!(export.blob(&read).is_err());
    std::os::unix::fs::symlink(
        "../source-control/.xh-sync-base",
        f.root.join("source/link"),
    )
    .unwrap();
    assert!(export.snapshot().is_err());
    fs::remove_file(f.root.join("source/link")).unwrap();
    fs::hard_link(f.root.join("source/one"), f.root.join("source/two")).unwrap();
    assert!(export.snapshot().is_err());
}

#[tokio::test]
async fn actual_loopback_http_proof_auth_order_and_browser_rejection() {
    let f = Fixture::new();
    f.write("one", b"wire-data");
    let export = f.export();
    let scope = export.scope().to_owned();
    assert!(export.clone().router("0.0.0.0:1".parse().unwrap()).is_err());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, export.router(address).unwrap())
            .with_graceful_shutdown(async {
                stopped.await.unwrap();
            })
            .await
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let base = format!("http://{address}");
    let nonce = "d".repeat(64);
    let identity: serde_json::Value = client
        .get(format!("{base}/identity?nonce={nonce}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(identity["scope"], scope);
    let proof = identity["proof"].as_str().unwrap();
    assert!(
        xharness_server::workspace_identity::verify(&"c".repeat(64), &nonce, &scope, proof)
            .unwrap()
    );
    assert!(!xharness_server::workspace_identity::verify(
        &"c".repeat(64),
        &"e".repeat(64),
        &scope,
        proof
    )
    .unwrap());
    for (path, expected) in [("/snapshot", 401), ("/identity?nonce=bad", 400)] {
        assert_eq!(
            client
                .get(format!("{base}{path}"))
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
            expected
        );
    }
    // Auth precedes JSON parsing even for malformed / oversized input.
    assert_eq!(
        client
            .post(format!("{base}/blob"))
            .body("x".repeat(9000))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        401
    );
    for (key, value) in [
        ("Origin", "http://localhost"),
        ("Host", "evil.invalid"),
        ("sec-fetch-site", "same-origin"),
        ("Forwarded", "host=localhost"),
        ("x-forwarded-host", "localhost"),
    ] {
        assert_eq!(
            client
                .get(format!("{base}/snapshot"))
                .bearer_auth("c".repeat(64))
                .header(key, value)
                .send()
                .await
                .unwrap()
                .status()
                .as_u16(),
            403
        );
    }
    let response = client
        .get(format!("{base}/snapshot"))
        .bearer_auth("c".repeat(64))
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["cache-control"], "no-store");
    let snapshot: Snapshot = response.json().await.unwrap();
    let read = request(&snapshot);
    let bytes = client
        .post(format!("{base}/blob"))
        .bearer_auth("c".repeat(64))
        .json(&read)
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(bytes, b"wire-data".as_slice());
    assert_eq!(
        client
            .post(format!("{base}/apply"))
            .bearer_auth("c".repeat(64))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        404
    );
    assert_eq!(
        client
            .post(format!("{base}/blob"))
            .bearer_auth("c".repeat(64))
            .header("content-type", "application/json")
            .body(" ".repeat(9000))
            .send()
            .await
            .unwrap()
            .status()
            .as_u16(),
        400
    );
    stop.send(()).unwrap();
    server.await.unwrap().unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn confined_native_process_cannot_modify_external_control_store() {
    use xharness_platform::{NativePlatform, PlatformConfig};
    use xharness_process::SpawnSpec;
    let f = Fixture::new();
    let control = f.root.join("source-control");
    let before = fs::read(control.join(".xh-sync-base")).unwrap();
    let alias = f.root.join("alias");
    std::os::unix::fs::symlink(&control, &alias).unwrap();
    assert!(NativePlatform::new(
        PlatformConfig::new(f.source.workspace_root())
            .workspace_control(&control, "a".repeat(64))
            .read_only_root(&alias)
    )
    .is_err());
    let platform = NativePlatform::new(
        PlatformConfig::new(f.source.workspace_root()).workspace_control(&control, "a".repeat(64)),
    )
    .unwrap();
    // No fallback to unrestricted execution. This test requires a functioning
    // native sandbox, not merely a bwrap executable found on PATH.
    let output = platform
        .spawn(
            SpawnSpec::new("/bin/sh", f.source.workspace_root())
                .args([
                    "-c",
                    "printf own > owned; printf forged > \"$1/.xh-sync-base\"",
                    "probe",
                    control.to_str().unwrap(),
                ])
                .timeout(Duration::from_secs(10)),
        )
        .await
        .unwrap()
        .wait()
        .await
        .unwrap();
    assert!(!output.status.success);
    assert_eq!(fs::read(f.root.join("source/owned")).unwrap(), b"own");
    assert_eq!(fs::read(control.join(".xh-sync-base")).unwrap(), before);
}
