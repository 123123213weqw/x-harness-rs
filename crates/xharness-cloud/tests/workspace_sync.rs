//! Pure sync decisions only: no filesystem mutation, Host, model or execution lease.
use serde_json::json;
use unicode_normalization::UnicodeNormalization;
use xharness_cloud::{workspace_sync::*, Counter, ErrorCode, Id, VersionedRef};

fn file(text: &str) -> SyncFile {
    SyncFile::from_bytes(text.as_bytes(), false).unwrap()
}
fn manifest(text: Option<&str>) -> WorkspaceManifest {
    WorkspaceManifest::new(
        text.into_iter()
            .map(|text| ("src/main.rs".into(), file(text))),
    )
    .unwrap()
}
fn policy() -> VersionedRef {
    VersionedRef {
        id: Id::new("capture-policy").unwrap(),
        version: Id::new("v1").unwrap(),
    }
}

#[test]
fn pinned_unicode_tables_reject_every_precomposed_hangul_alias() {
    // Audit the normalization dependency's range-checked Hangul decomposition
    // path through its public safe API, including both ends of the range.
    // Pin table provenance too: neither algorithm is a native collation proof.
    assert_eq!(caseless::UNICODE_VERSION, (16, 0, 0));
    assert_eq!(unicode_normalization::UNICODE_VERSION, (17, 0, 0));
    for codepoint in 0xAC00..=0xD7A3 {
        let composed = char::from_u32(codepoint).unwrap().to_string();
        let decomposed: String = composed.nfd().collect();
        assert_ne!(composed, decomposed);
        assert_eq!(decomposed.nfc().collect::<String>(), composed);
        assert_eq!(composed.nfkc().collect::<String>(), composed);
        let error = WorkspaceManifest::new([
            (format!("{composed}.txt"), file("a")),
            (format!("{decomposed}.txt"), file("b")),
        ])
        .unwrap_err();
        assert_eq!(error.code, ErrorCode::RevisionConflict);
    }
}
fn scope() -> WorkspaceSyncScope {
    WorkspaceSyncScope::new(
        Id::new("pair").unwrap(),
        Counter(7),
        Id::new("mac").unwrap(),
        Id::new("cloud").unwrap(),
        policy(),
    )
    .unwrap()
}

#[test]
fn exhaustive_three_way_decisions_converge_or_block_both_sides() {
    // 4^3 independent content/deletion states, including concurrent create,
    // edit/delete, identical dual edits and target-only edits in both directions.
    let states = [None, Some("base"), Some("local"), Some("cloud")];
    for b in states {
        for l in states {
            for c in states {
                let (base, local, cloud) = (manifest(b), manifest(l), manifest(c));
                let plan = WorkspaceSyncPlan::build(scope(), &base, &local, &cloud).unwrap();
                if l != c && l != b && c != b {
                    assert_eq!(plan.conflicts().len(), 1, "{b:?}/{l:?}/{c:?}");
                    assert_eq!(
                        plan.changes().unwrap_err().code,
                        ErrorCode::RevisionConflict
                    );
                    assert!(plan.proposed_base().is_none());
                    assert!(plan.check_converged(&scope(), &local, &cloud).is_err());
                } else {
                    assert!(plan.conflicts().is_empty());
                    let changes = plan.changes().unwrap();
                    assert_eq!(changes.len(), usize::from(l != c));
                    let merged = if l == b { c } else { l };
                    assert_eq!(plan.proposed_base(), Some(&manifest(merged)));
                    if l != c {
                        let expected_side = if l == b {
                            SyncSide::Local
                        } else {
                            SyncSide::Cloud
                        };
                        assert_eq!(changes[0].side, expected_side);
                        assert_eq!(
                            changes[0].before,
                            if expected_side == SyncSide::Local {
                                l
                            } else {
                                c
                            }
                            .map(file)
                        );
                        assert_eq!(changes[0].after, merged.map(file));
                        assert!(plan.check_converged(&scope(), &local, &cloud).is_err());
                    }
                    let merged = manifest(merged);
                    plan.check_converged(&scope(), &merged, &merged).unwrap();
                }
            }
        }
    }
}

#[test]
fn independent_edits_flow_in_both_directions_and_never_ack_one_sided_completion() {
    let base =
        WorkspaceManifest::new([("a".into(), file("old-a")), ("b".into(), file("old-b"))]).unwrap();
    let local =
        WorkspaceManifest::new([("a".into(), file("new-a")), ("b".into(), file("old-b"))]).unwrap();
    let cloud =
        WorkspaceManifest::new([("a".into(), file("old-a")), ("b".into(), file("new-b"))]).unwrap();
    let plan = WorkspaceSyncPlan::build(scope(), &base, &local, &cloud).unwrap();
    let changes = plan.changes().unwrap();
    assert_eq!(changes.len(), 2);
    assert_eq!((&*changes[0].path, changes[0].side), ("a", SyncSide::Cloud));
    assert_eq!((&*changes[1].path, changes[1].side), ("b", SyncSide::Local));
    plan.check_inputs(&scope(), &base, &local, &cloud).unwrap();
    let merged = plan.proposed_base().unwrap();
    assert!(plan.check_converged(&scope(), merged, &cloud).is_err());
    assert!(plan.check_converged(&scope(), &local, merged).is_err());
    plan.check_converged(&scope(), merged, merged).unwrap();
}

#[test]
fn one_conflict_blocks_otherwise_safe_changes_and_common_base_publication() {
    let base = manifest(Some("base"));
    let local = WorkspaceManifest::new([
        ("src/main.rs".into(), file("local")),
        ("new.txt".into(), file("new")),
    ])
    .unwrap();
    let cloud = manifest(Some("cloud"));
    let plan = WorkspaceSyncPlan::build(scope(), &base, &local, &cloud).unwrap();
    assert_eq!(plan.conflicts()[0].path, "src/main.rs");
    assert!(plan.changes().is_err());
    assert!(plan.proposed_base().is_none());
    assert!(plan.check_inputs(&scope(), &base, &local, &cloud).is_err());
}

#[test]
fn plan_binds_both_inputs_common_base_pair_generation_and_direction() {
    let base = manifest(Some("base"));
    let local = manifest(Some("new"));
    let cloud = base.clone();
    let plan = WorkspaceSyncPlan::build(scope(), &base, &local, &cloud).unwrap();
    for (b, l, c) in [
        (&local, &local, &cloud),
        (&base, &base, &cloud),
        (&base, &local, &local),
    ] {
        assert!(plan.check_inputs(&scope(), b, l, c).is_err());
    }
    for different in [
        WorkspaceSyncScope::new(
            Id::new("other").unwrap(),
            Counter(7),
            Id::new("mac").unwrap(),
            Id::new("cloud").unwrap(),
            policy(),
        )
        .unwrap(),
        WorkspaceSyncScope::new(
            Id::new("pair").unwrap(),
            Counter(8),
            Id::new("mac").unwrap(),
            Id::new("cloud").unwrap(),
            policy(),
        )
        .unwrap(),
        WorkspaceSyncScope::new(
            Id::new("pair").unwrap(),
            Counter(7),
            Id::new("cloud").unwrap(),
            Id::new("mac").unwrap(),
            policy(),
        )
        .unwrap(),
        WorkspaceSyncScope::new(
            Id::new("pair").unwrap(),
            Counter(7),
            Id::new("mac").unwrap(),
            Id::new("cloud").unwrap(),
            VersionedRef {
                id: Id::new("capture-policy").unwrap(),
                version: Id::new("v2").unwrap(),
            },
        )
        .unwrap(),
    ] {
        assert!(plan
            .check_inputs(&different, &base, &local, &cloud)
            .is_err());
        assert_ne!(
            plan.digest().unwrap(),
            WorkspaceSyncPlan::build(different.clone(), &base, &local, &cloud)
                .unwrap()
                .digest()
                .unwrap()
        );
        assert!(plan.check_converged(&different, &local, &local).is_err());
    }
    assert!(WorkspaceSyncScope::new(
        Id::new("pair").unwrap(),
        Counter(0),
        Id::new("mac").unwrap(),
        Id::new("mac").unwrap(),
        policy(),
    )
    .is_err());
}

#[test]
fn executable_bit_and_binary_content_are_part_of_the_cas_identity() {
    let mut executable = file("same");
    executable.executable = true;
    let base = WorkspaceManifest::new([("run.sh".into(), file("same"))]).unwrap();
    let changed = WorkspaceManifest::new([("run.sh".into(), executable)]).unwrap();
    let plan = WorkspaceSyncPlan::build(scope(), &base, &changed, &base).unwrap();
    assert!(
        plan.changes().unwrap()[0]
            .after
            .as_ref()
            .unwrap()
            .executable
    );
    let binary = SyncFile::from_bytes(&[0, 255, 1, 128], false).unwrap();
    binary.verify_content(&[0, 255, 1, 128]).unwrap();
    assert!(binary.verify_content(&[0, 255, 1, 127]).is_err());
    assert!(binary.verify_content(&[0, 255, 1]).is_err());
}

#[test]
fn manifest_is_deterministic_roundtrips_and_rejects_duplicate_paths() {
    assert_eq!(
        manifest(None).digest().unwrap().as_str(),
        "05b037267e0633ff7dda01178eee2fb3692aaace57eed528af276c8eed518b16"
    );
    let a = WorkspaceManifest::new([("b".into(), file("b")), ("a".into(), file("a"))]).unwrap();
    let b = WorkspaceManifest::new([("a".into(), file("a")), ("b".into(), file("b"))]).unwrap();
    assert_eq!(a.to_json().unwrap(), b.to_json().unwrap());
    assert_eq!(a.digest().unwrap(), b.digest().unwrap());
    assert_eq!(
        a,
        WorkspaceManifest::from_json(&serde_json::to_vec(&a).unwrap()).unwrap()
    );
    assert!(WorkspaceManifest::new([("a".into(), file("a")), ("a".into(), file("a"))]).is_err());
    let repeated =
        json!({"version":1,"files":[{"path":"a","file":file("a")},{"path":"a","file":file("a")}]});
    assert!(WorkspaceManifest::from_json(&serde_json::to_vec(&repeated).unwrap()).is_err());
    assert!(WorkspaceManifest::from_json(br#"{"version":1,"version":1,"files":[]}"#).is_err());
}

#[test]
fn unsupported_node_types_unknown_fields_and_lossy_byte_counts_are_not_accepted() {
    let valid = json!({"version":1,"files":[{"path":"a","file":file("a")}]});
    for candidate in [
        json!({"version":2,"files":[]}),
        json!({"version":1,"files":[],"token":"secret"}),
        json!({"version":1,"files":[{"path":"a","file":file("a"),"kind":"symlink"}]}),
        json!({"version":1,"files":[{"path":"a","file":{"sha256":file("a").sha256,"bytes":1,"executable":false}}]}),
    ] {
        assert!(WorkspaceManifest::from_json(&serde_json::to_vec(&candidate).unwrap()).is_err());
    }
    let mut oversized = valid.clone();
    oversized["files"][0]["file"]["bytes"] = json!((MAX_SYNC_FILE_BYTES + 1).to_string());
    assert!(WorkspaceManifest::from_json(&serde_json::to_vec(&oversized).unwrap()).is_err());
    assert!(WorkspaceManifest::from_json(&vec![b' '; MAX_SYNC_MANIFEST_BYTES + 1]).is_err());
}

#[test]
fn traversal_credentials_excluded_trees_and_devices_fail_closed() {
    for path in [
        "",
        "/a",
        "../a",
        "a/../b",
        "a//b",
        "a/./b",
        "C:/x",
        "a\\b",
        "a\0b",
        "a.",
        "a ",
        "CON.txt",
        "Lpt9",
        "a/.git/config",
        "a/.env",
        ".env.prod",
        ".envrc",
        ".npmrc",
        ".ssh/id_rsa",
        "keys/a.pem",
        "node_modules/a",
        "target/a",
        "auth.json",
        "cookies.json",
        "COM¹.txt",
        "LPT²",
        "a\u{85}b",
        ".ſſh/config",
    ] {
        let error = WorkspaceManifest::new([(path.into(), file("secret"))]).unwrap_err();
        assert!(
            !format!("{error}").contains(path) || path.is_empty(),
            "path must not enter diagnostics"
        );
    }
    WorkspaceManifest::new([
        ("src/main.rs".into(), file("ok")),
        (".gitignore".into(), file("target/")),
    ])
    .unwrap();
}

#[test]
fn case_aliases_file_directory_collisions_and_case_only_renames_are_rejected() {
    for names in [
        ["README", "readme"],
        ["src", "src/a"],
        ["Src", "src/a"],
        ["Src/a", "src/b"],
    ] {
        assert!(WorkspaceManifest::new(names.map(|p| (p.into(), file("x")))).is_err());
    }
    let empty = manifest(None);
    let a = WorkspaceManifest::new([("Readme".into(), file("a"))]).unwrap();
    let b = WorkspaceManifest::new([("README".into(), file("a"))]).unwrap();
    assert!(WorkspaceSyncPlan::build(scope(), &a, &b, &a).is_err());
    assert!(WorkspaceSyncPlan::build(scope(), &empty, &a, &b).is_err());
}

#[test]
fn unicode_names_roundtrip_without_rewriting_original_spelling() {
    for path in [
        "src/中文.rs",
        "目录/子目录/设计.md",
        "café.txt",
        "cafe\u{301}.txt",
        "한글.txt",
        "😀.txt",
    ] {
        let a = WorkspaceManifest::new([(path.into(), file("content"))]).unwrap();
        assert!(a.files().contains_key(path));
        let b = WorkspaceManifest::from_json(&a.to_json().unwrap()).unwrap();
        assert_eq!(a, b);
        let empty = manifest(None);
        let plan = WorkspaceSyncPlan::build(scope(), &empty, &a, &empty).unwrap();
        assert_eq!(plan.changes().unwrap()[0].path, path);
    }
}

#[test]
fn canonical_full_casefold_aliases_are_detected_for_files_and_directory_components() {
    for names in [
        ["café.txt", "cafe\u{301}.txt"],
        ["Straße.txt", "STRASSE.txt"],
        ["ß.txt", "ẞ.txt"],
        ["Σ.txt", "ς.txt"],
        ["K.txt", "k.txt"],
        ["İ.txt", "i\u{307}.txt"],
        ["한글.txt", "한글.txt"],
        ["Café/a.txt", "Cafe\u{301}/b.txt"],
        ["Straße/a.txt", "STRASSE/b.txt"],
    ] {
        assert!(WorkspaceManifest::new(names.map(|p| (p.into(), file("same")))).is_err());
        let local = WorkspaceManifest::new([(names[0].into(), file("same"))]).unwrap();
        let cloud = WorkspaceManifest::new([(names[1].into(), file("same"))]).unwrap();
        assert!(WorkspaceSyncPlan::build(scope(), &manifest(None), &local, &cloud).is_err());
    }
    // Compatibility normalization is not permission to merge distinct names.
    WorkspaceManifest::new([("①.txt".into(), file("a")), ("1.txt".into(), file("b"))]).unwrap();
}

#[test]
fn deeply_nested_paths_fail_before_native_traversal_or_recursive_tree_growth() {
    let path = std::iter::repeat_n("a", MAX_SYNC_PATH_COMPONENTS + 1)
        .collect::<Vec<_>>()
        .join("/");
    assert!(WorkspaceManifest::new([(path, file("x"))]).is_err());
}

#[test]
fn total_quota_is_checked_without_wrapping_or_truncating_a_manifest() {
    let mut large = file("x");
    large.bytes = Counter(MAX_SYNC_FILE_BYTES);
    let files = (0..17).map(|i| (format!("file-{i}"), large.clone()));
    assert!(WorkspaceManifest::new(files).is_err());
    let files = (0..=MAX_SYNC_FILES).map(|i| (format!("file-{i}"), file("")));
    assert!(WorkspaceManifest::new(files).is_err());
}

#[test]
fn union_quota_also_blocks_individually_valid_but_oversize_merged_workspaces() {
    let mut large = file("x");
    large.bytes = Counter(MAX_SYNC_FILE_BYTES);
    let base = manifest(None);
    let local =
        WorkspaceManifest::new((0..9).map(|i| (format!("local-{i}"), large.clone()))).unwrap();
    let cloud =
        WorkspaceManifest::new((0..9).map(|i| (format!("cloud-{i}"), large.clone()))).unwrap();
    assert!(WorkspaceSyncPlan::build(scope(), &base, &local, &cloud).is_err());
}

#[test]
fn metadata_budget_fails_the_whole_capture_instead_of_truncating_long_paths() {
    let prefix = vec!["a".repeat(240); 16].join("/");
    let rows = (0..5000).map(|i| (format!("{prefix}/file-{i}"), file("")));
    assert_eq!(
        WorkspaceManifest::new(rows).unwrap_err().message,
        "workspace manifest exceeds metadata byte limit"
    );
}

#[test]
fn full_content_hash_detects_interior_changes_in_large_files() {
    let mut bytes = vec![b'a'; 8 * 1024 * 1024];
    let before = SyncFile::from_bytes(&bytes, false).unwrap();
    bytes[512 * 1024] = b'b';
    assert!(before.verify_content(&bytes).is_err());
    assert_ne!(
        before.sha256,
        SyncFile::from_bytes(&bytes, false).unwrap().sha256
    );
}

#[test]
fn serialized_plan_contains_no_grant_or_completion_claim() {
    let base = manifest(Some("base"));
    let changed = manifest(Some("new"));
    let plan = WorkspaceSyncPlan::build(scope(), &base, &changed, &base).unwrap();
    let value = serde_json::to_value(&plan).unwrap();
    for field in [
        "token",
        "root",
        "upstream",
        "lease",
        "applied",
        "completed",
        "committed",
        "synced",
        "sessionMigration",
    ] {
        assert!(
            value.get(field).is_none(),
            "a proposal cannot grant authority or claim side effects"
        );
    }
    assert_eq!(value["scope"]["generation"], "7");
    assert_eq!(value["scope"]["local_environment"], "mac");
    assert_eq!(value["scope"]["cloud_environment"], "cloud");
}
