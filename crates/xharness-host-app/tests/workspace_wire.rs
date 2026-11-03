#![cfg(any(target_os = "linux", target_os = "macos"))]
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};
use xharness_cloud::Id;
use xharness_fs::{FsService, ObservationStore};
use xharness_host_app::{
    workspace_inventory::policy_ref,
    workspace_wire::{Binding, Participant, Phase, Role, Round},
};
struct Fixture {
    root: PathBuf,
    local: FsService,
    cloud: FsService,
    ls: FsService,
    cs: FsService,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "xh-wire-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        for n in ["local", "cloud", "lc", "cc", "ls", "cs", "snapshot"] {
            fs::create_dir(root.join(n)).unwrap();
            fs::set_permissions(root.join(n), fs::Permissions::from_mode(0o700)).unwrap();
        }
        let open = |name: &str, ctrl: &str, reg: &str| {
            let source = FsService::new(root.join(name)).unwrap();
            source
                .provision_sync_control(&FsService::new(root.join(ctrl)).unwrap(), reg)
                .unwrap();
            FsService::with_sync_control(
                root.join(name),
                ObservationStore::default(),
                root.join(ctrl),
                reg,
            )
            .unwrap()
        };
        let f = Self {
            local: open("local", "lc", &"a".repeat(64)),
            cloud: open("cloud", "cc", &"b".repeat(64)),
            ls: FsService::new(root.join("ls")).unwrap(),
            cs: FsService::new(root.join("cs")).unwrap(),
            root,
        };
        let (l, c) = f.open();
        let b = Binding {
            version: 1,
            pair: Id::new("pair").unwrap(),
            epoch: 1,
            local: l.descriptor().clone(),
            cloud: c.descriptor().clone(),
            policy: policy_ref().unwrap(),
        };
        l.bind_new(&b).unwrap();
        c.bind_new(&b).unwrap();
        drop((l, c));
        f
    }
    fn open(&self) -> (Participant, Participant) {
        (
            Participant::open(&self.local, &self.ls, Role::Local).unwrap(),
            Participant::open(&self.cloud, &self.cs, Role::Cloud).unwrap(),
        )
    }
    fn intent(&self, l: &Participant, c: &Participant) -> Round {
        let r = l.plan(c.snapshot().unwrap()).unwrap().unwrap();
        c.begin(r.clone()).unwrap();
        r
    }
    fn transfer(&self, l: &Participant, c: &Participant, r: &Round) {
        for (src, dst, objects) in [
            ("ls", "cs", l.materialize(&r.id).unwrap()),
            ("cs", "ls", c.materialize(&r.id).unwrap()),
        ] {
            for h in objects {
                fs::copy(self.root.join(src).join(&h), self.root.join(dst).join(&h)).unwrap();
            }
        }
    }
    fn finish(&self, l: &Participant, c: &Participant, r: &Round) {
        l.stage(&r.id).unwrap();
        c.stage(&r.id).unwrap();
        l.prepare(&r.id).unwrap();
        let cp = c.prepare(&r.id).unwrap();
        let d = l.decide(&r.id, cp).unwrap();
        c.accept_decision(&r.id, d).unwrap();
        let ca = c.apply(&r.id).unwrap();
        let la = l.apply(&r.id).unwrap();
        let cc = c.finalize(&r.id, la).unwrap();
        let lc = l.finalize(&r.id, ca).unwrap();
        c.release(&r.id, lc).unwrap();
        l.release(&r.id, cc).unwrap();
    }
    fn sync(&self) {
        let (l, c) = self.open();
        let r = self.intent(&l, &c);
        self.transfer(&l, &c, &r);
        self.finish(&l, &c, &r);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
#[test]
fn binary_unicode_executable_bidirectional_and_exclusions() {
    let f = Fixture::new();
    fs::create_dir(f.root.join("local/中文")).unwrap();
    let bytes: Vec<_> = (0..524299).map(|i| (i % 251) as u8).collect();
    fs::write(f.root.join("local/中文/运行"), &bytes).unwrap();
    fs::set_permissions(
        f.root.join("local/中文/运行"),
        fs::Permissions::from_mode(0o700),
    )
    .unwrap();
    fs::write(f.root.join("local/.env"), b"do-not-sync").unwrap();
    fs::create_dir(f.root.join("local/target")).unwrap();
    fs::write(f.root.join("local/target/a"), b"not-code").unwrap();
    f.sync();
    assert_eq!(fs::read(f.root.join("cloud/中文/运行")).unwrap(), bytes);
    assert!(!f.root.join("cloud/.env").exists());
    assert!(!f.root.join("cloud/target").exists());
    assert_ne!(
        fs::metadata(f.root.join("cloud/中文/运行"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    fs::write(f.root.join("cloud/中文/运行"), b"remote edit").unwrap();
    fs::write(f.root.join("cloud/new"), b"new-cloud").unwrap();
    f.sync();
    assert_eq!(
        fs::read(f.root.join("local/中文/运行")).unwrap(),
        b"remote edit"
    );
    assert_eq!(fs::read(f.root.join("local/new")).unwrap(), b"new-cloud");
    let (l, c) = f.open();
    assert_eq!(l.status().unwrap().base.generation, 2);
    assert!(l.plan(c.snapshot().unwrap()).unwrap().is_none());
}
#[test]
fn conflict_and_deletion_fail_before_any_intent_or_live_write() {
    let f = Fixture::new();
    fs::write(f.root.join("local/file"), b"base").unwrap();
    f.sync();
    fs::write(f.root.join("local/file"), b"local edit").unwrap();
    fs::write(f.root.join("cloud/file"), b"cloud edit").unwrap();
    let (l, c) = f.open();
    assert!(l.plan(c.snapshot().unwrap()).is_err());
    assert!(l.status().unwrap().round.is_none());
    assert!(c.status().unwrap().round.is_none());
    drop((l, c));
    fs::write(f.root.join("local/file"), b"base").unwrap();
    fs::write(f.root.join("cloud/file"), b"base").unwrap();
    fs::remove_file(f.root.join("local/file")).unwrap();
    let (l, c) = f.open();
    assert!(l.plan(c.snapshot().unwrap()).is_err());
    assert_eq!(fs::read(f.root.join("cloud/file")).unwrap(), b"base");
}
#[test]
fn prepare_and_decision_do_not_publish_and_drop_retains_native_fence() {
    let f = Fixture::new();
    fs::write(f.root.join("local/file"), b"hello").unwrap();
    let (l, c) = f.open();
    let r = f.intent(&l, &c);
    f.transfer(&l, &c, &r);
    l.stage(&r.id).unwrap();
    c.stage(&r.id).unwrap();
    assert!(!f.root.join("cloud/file").exists());
    l.prepare(&r.id).unwrap();
    let cp = c.prepare(&r.id).unwrap();
    assert!(!f.root.join("cloud/file").exists());
    let d = l.decide(&r.id, cp).unwrap();
    assert!(!f.root.join("cloud/file").exists());
    drop((l, c));
    assert!(f.local.workspace_use().is_err());
    assert!(f.cloud.workspace_use().is_err());
    let (l, c) = f.open();
    c.accept_decision(&r.id, d.clone()).unwrap();
    c.accept_decision(&r.id, d).unwrap();
    let ca = c.apply(&r.id).unwrap();
    let la = l.apply(&r.id).unwrap();
    assert_eq!(l.status().unwrap().base.generation, 0);
    assert_eq!(c.status().unwrap().base.generation, 0);
    let cc = c.finalize(&r.id, la).unwrap();
    let lc = l.finalize(&r.id, ca).unwrap();
    c.release(&r.id, lc.clone()).unwrap();
    drop((l, c));
    let (l, c) = f.open();
    let status = c.status().unwrap();
    assert!(status.round.is_none());
    assert_eq!(status.receipt.unwrap().phase, Phase::Complete);
    l.release(&r.id, cc).unwrap();
    c.release(&r.id, lc).unwrap();
    drop((l, c));
    assert!(f.local.workspace_use().is_ok());
    assert!(f.cloud.workspace_use().is_ok());
}
#[test]
fn corrupt_object_missing_authority_and_wrong_epoch_are_not_success() {
    let f = Fixture::new();
    fs::write(f.root.join("local/file"), b"good").unwrap();
    let (l, c) = f.open();
    let r = f.intent(&l, &c);
    let hashes = l.materialize(&r.id).unwrap();
    fs::write(f.root.join("cs").join(&hashes[0]), b"evil").unwrap();
    assert!(c.stage(&r.id).is_err());
    assert!(!f.root.join("cloud/file").exists());
    let mut forged = r.clone();
    forged.binding.epoch += 1;
    assert!(c.begin(forged).is_err());
    drop((l, c));
    fs::remove_file(f.root.join("cc/.xh-sync-registration")).unwrap();
    assert!(Participant::open(&f.cloud, &f.cs, Role::Cloud).is_err());
}
#[test]
fn external_same_bytes_inode_replacement_after_prepare_is_not_overwritten() {
    let f = Fixture::new();
    fs::write(f.root.join("local/file"), b"old").unwrap();
    f.sync();
    fs::write(f.root.join("local/file"), b"new").unwrap();
    let (l, c) = f.open();
    let r = f.intent(&l, &c);
    f.transfer(&l, &c, &r);
    l.stage(&r.id).unwrap();
    c.stage(&r.id).unwrap();
    l.prepare(&r.id).unwrap();
    let cp = c.prepare(&r.id).unwrap();
    let d = l.decide(&r.id, cp).unwrap();
    fs::rename(
        f.root.join("cloud/file"),
        f.root.join("cloud/external-backup"),
    )
    .unwrap();
    fs::write(f.root.join("cloud/file"), b"old").unwrap();
    assert!(c.accept_decision(&r.id, d).is_err());
    assert_eq!(fs::read(f.root.join("cloud/file")).unwrap(), b"old");
    assert_eq!(c.status().unwrap().base.generation, 1);
}
#[test]
fn snapshot_requires_committed_idle_cloud_and_remains_pinned() {
    let f = Fixture::new();
    fs::write(f.root.join("local/main.rs"), b"fn main() {}\n").unwrap();
    f.sync();
    let (l, c) = f.open();
    let dest = FsService::new(f.root.join("snapshot")).unwrap();
    assert!(l.seal_cloud_snapshot(&dest).is_err());
    let sealed = c.seal_cloud_snapshot(&dest).unwrap();
    assert_eq!(sealed.checkpoint().generation().0, 1);
    fs::write(f.root.join("cloud/main.rs"), b"changed").unwrap();
    sealed.validate().unwrap();
    assert_eq!(
        fs::read(f.root.join("snapshot/main.rs")).unwrap(),
        b"fn main() {}\n"
    );
}
#[test]
fn input_forgery_and_symlink_never_get_a_partial_success() {
    let f = Fixture::new();
    fs::write(f.root.join("local/a"), b"good").unwrap();
    let (l, c) = f.open();
    let mut s = c.snapshot().unwrap();
    s.role = Role::Local;
    assert!(l.plan(s).is_err());
    assert!(l.status().unwrap().round.is_none());
    drop((l, c));
    std::os::unix::fs::symlink("/etc/passwd", f.root.join("local/alias")).unwrap();
    let (l, c) = f.open();
    assert!(l.plan(c.snapshot().unwrap()).is_err());
    assert!(l.status().unwrap().round.is_none());
}
#[test]
fn explicit_bind_cannot_repair_missing_registered_base_or_change_epoch() {
    let f = Fixture::new();
    let (l, c) = f.open();
    let binding = l.status().unwrap().binding;
    l.bind_new(&binding).unwrap();
    let mut other = binding.clone();
    other.epoch += 1;
    assert!(l.bind_new(&other).is_err());
    drop((l, c));
    fs::remove_file(f.root.join("lc/.xh-sync-base")).unwrap();
    let (l, _) = f.open();
    assert!(l.bind_new(&binding).is_err());
    assert!(!f.root.join("lc/.xh-sync-base").exists());
}
#[test]
fn write_request_schema_has_no_root_binding_or_execution_authority() {
    use xharness_host_app::workspace_wire::Request;
    for bytes in [
        r#"{"operation":"status","root":"/tmp"}"#,
        r#"{"operation":"register","binding":{}}"#,
        r#"{"operation":"execute","program":"/bin/sh"}"#,
        r#"{"operation":"stage","id":"x","path":"../escape"}"#,
    ] {
        assert!(
            serde_json::from_str::<Request>(bytes).is_err(),
            "accepted unexpected authority field: {bytes}"
        );
    }
}
