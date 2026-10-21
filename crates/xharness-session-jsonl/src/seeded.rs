//! Atomic publication of a complete, already validated journal.
use super::*;

impl JsonlSessionStore {
    pub(super) async fn publish_new_session(
        &self,
        session: Session,
    ) -> Result<Session, StoreError> {
        let session_id = session.header().id.clone();
        let (path, guard) = self.locked_path(&session_id).await?;
        let cache = Arc::clone(&self.cache);
        let root = Arc::clone(&self.root);
        run_blocking(move || {
            let _guard = guard;
            let _file_lock = acquire_file_lock(&path)?;
            match fs::symlink_metadata(&path) {
                Ok(_) => return Err(StoreError::AlreadyExists { session_id }),
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(backend_error("inspect new session", &path, error)),
            }
            let header = HeaderRecord {
                record: HEADER_RECORD.to_owned(),
                format: FILE_FORMAT.to_owned(),
                format_version: FILE_FORMAT_VERSION,
                header: session.header().clone(),
            };
            let header_bytes = encode_line(&header, &path)?;
            static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let tmp = path.with_file_name(format!(
                ".creating-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos(),
                NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            let mut file = secure_open_options()
                .write(true)
                .create_new(true)
                .open(&tmp)
                .map_err(|error| backend_error("create session staging file", &tmp, error))?;
            let mut hash = Sha256::new();
            let mut audit_offsets = HashMap::new();
            let mut linked = false;
            let published = (|| -> Result<(), StoreError> {
                copy_fork_resources(&root, &session)?;
                file.write_all(&header_bytes)
                    .map_err(|error| backend_error("write session header", &tmp, error))?;
                hash.update(&header_bytes);
                let mut offset = header_bytes.len() as u64;
                let mut previous_revision = Revision::ZERO;
                let mut rest = session.events();
                while let Some(first) = rest.first() {
                    let count = rest
                        .iter()
                        .take_while(|e| e.revision == first.revision)
                        .count();
                    let (batch, tail) = rest.split_at(count);
                    let bytes = encode_line(
                        &BatchRecord {
                            record: BATCH_RECORD.to_owned(),
                            previous_revision,
                            revision: first.revision,
                            events: batch.to_vec(),
                        },
                        &path,
                    )?;
                    if bytes.len() as u64 > MAX_RECORD_BYTES {
                        return Err(backend_message("seeded journal batch exceeds record limit"));
                    }
                    file.write_all(&bytes).map_err(|error| {
                        backend_error("write seeded session batch", &tmp, error)
                    })?;
                    for event in batch {
                        if matches!(
                            event.data(),
                            xharness_session::EventData::RequestHeader { .. }
                        ) {
                            audit_offsets.insert(event.seq, (offset, bytes.len() as u64));
                        }
                    }
                    hash.update(&bytes);
                    offset += bytes.len() as u64;
                    previous_revision = first.revision;
                    rest = tail;
                }
                file.sync_all()
                    .map_err(|error| backend_error("durably write seeded session", &tmp, error))?;
                match fs::hard_link(&tmp, &path) {
                    Ok(()) => linked = true,
                    Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                        return Err(StoreError::AlreadyExists {
                            session_id: session_id.clone(),
                        });
                    }
                    Err(error) => {
                        return Err(backend_error("publish seeded session", &path, error))
                    }
                }
                sync_parent_directory(&path)
            })();
            drop(file);
            let _ = fs::remove_file(&tmp);
            if published.is_err() && !linked {
                // This id was absent under the writer lock and is still not
                // visible. Remove only the resource namespaces staged for it.
                let _ = results::delete(&root, &session_id);
                let _ = harness_snapshot::delete(&root, &session_id);
            }
            published?;
            // Publication is durable. An optional cache failure must not turn
            // success into an ambiguous retry of an already-created journal.
            if let Ok(Some(fingerprint)) = file_fingerprint(&path) {
                let estimated_bytes = 1024usize
                    .saturating_add(session.events().iter().map(event_weight).sum::<usize>())
                    .saturating_add(audit_offsets.len().saturating_mul(64));
                let _ = cache_store(
                    &cache,
                    &path,
                    fingerprint,
                    LoadedFile {
                        session: session.clone(),
                        format_version: FILE_FORMAT_VERSION,
                        valid_len: fingerprint.len,
                        needs_separator: false,
                        estimated_bytes,
                        journal_hash: hash,
                        audit_offsets: Arc::new(audit_offsets),
                    },
                );
            }
            Ok(session)
        })
        .await
    }
}

// A fork owns only resources referenced by its copied prefix, not every blob
// ever produced by the source. Namespace copies survive independent deletion.
fn copy_fork_resources(root: &Path, session: &Session) -> Result<(), StoreError> {
    let Some(xharness_session::EventData::SessionForkOrigin {
        parent_session_id, ..
    }) = session.events().last().map(|event| event.data())
    else {
        return Ok(());
    };
    let child = &session.header().id;
    if parent_session_id == child {
        return Err(backend_message("fork parent must differ from child"));
    }
    let mut results_seen = std::collections::HashSet::new();
    let mut snapshots_seen = std::collections::HashSet::new();
    for event in session.events() {
        match event.data() {
            xharness_session::EventData::ToolResult { result, .. } => {
                let reference = decode_owned_json::<serde_json::Value>(result.content.as_bytes())
                    .ok()
                    .and_then(|v| v.get("archive").cloned())
                    .and_then(|v| {
                        serde_json::from_value::<xharness_session::ToolArchiveRef>(v).ok()
                    });
                if let Some(reference) = reference {
                    if !results_seen.insert(reference.sha256.clone()) {
                        continue;
                    }
                    let text = results::read(root, parent_session_id, &reference.sha256)?
                        .ok_or_else(|| {
                            backend_message("fork's referenced original tool result is unavailable")
                        })?;
                    if results::put(root, child, &text)? != reference {
                        return Err(backend_message("fork tool archive reference mismatch"));
                    }
                }
            }
            xharness_session::EventData::RequestHeader { header } => {
                let Some(reference) = header.options.get("harnessSnapshot") else {
                    continue;
                };
                if reference["kind"] != "archive" {
                    continue;
                }
                if !snapshots_seen.insert(reference.to_string()) {
                    continue;
                }
                let expanded = harness_snapshot::expand(root, parent_session_id, header.clone())?;
                if &harness_snapshot::archive(root, child, &expanded)? != reference {
                    return Err(backend_message("fork Harness snapshot reference mismatch"));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use xharness_session::{EventData as E, Message, RequestHeader, TurnEndReason};

    fn seed(id: &str) -> Session {
        let mut session = Session::new(SessionHeader::new(id)).unwrap();
        session
            .append_batch_at(
                Revision::ZERO,
                vec![E::SessionTitle {
                    title: "seeded child".into(),
                    message_seqs: vec![],
                    source: xharness_session::SessionTitleSource::User,
                }
                .into()],
                10,
            )
            .unwrap();
        session
            .append_batch_at(
                session.revision(),
                vec![
                    E::TurnStart { turn: 1 }.into(),
                    E::UserMessage {
                        message: Message::user("question"),
                        surface_replace: None,
                    }
                    .into(),
                    E::StepStart { turn: 1, step: 1 }.into(),
                    E::RequestHeader {
                        header: RequestHeader::new("seed-provider", "seed-model"),
                    }
                    .into(),
                    E::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message: Message::assistant("answer"),
                        usage: None,
                    }
                    .into(),
                    E::StepEnd { turn: 1, step: 1 }.into(),
                    E::TurnEnd {
                        turn: 1,
                        reason: TurnEndReason::Completed,
                    }
                    .into(),
                ],
                20,
            )
            .unwrap();
        session
            .append_batch_at(
                session.revision(),
                vec![E::SessionForkOrigin {
                    parent_session_id: "parent".into(),
                    before_user_seq: None,
                }
                .into()],
                30,
            )
            .unwrap();
        session
    }

    fn root() -> PathBuf {
        root_at(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        )
    }

    fn root_at(clock_nanos: u128) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "xharness-seeded-{}-{}-{}",
            std::process::id(),
            clock_nanos,
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ))
    }

    #[test]
    fn test_roots_are_isolated_when_clock_ticks_repeat() {
        // Windows clocks may return the same tick to concurrent test workers.
        // A cleanup assertion must never inspect another test's staging file.
        let first = root_at(0);
        let second = root_at(0);
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn seeded_journal_preserves_revisions_timestamps_audits_and_restart_append() {
        let root = root();
        let store = JsonlSessionStore::new(&root).unwrap();
        let seed = seed("child");
        assert_eq!(store.create_seeded(seed.clone()).await.unwrap(), seed);
        let reopened = JsonlSessionStore::new(&root).unwrap();
        let mut loaded = reopened.load("child").await.unwrap().unwrap();
        assert_eq!(loaded, seed);
        assert_eq!(
            reopened
                .request_header("child", 4)
                .await
                .unwrap()
                .unwrap()
                .provider,
            "seed-provider"
        );
        let receipt = reopened
            .append(
                "child",
                loaded.revision(),
                vec![E::SessionTitle {
                    title: "continued".into(),
                    message_seqs: vec![],
                    source: xharness_session::SessionTitleSource::User,
                }
                .into()],
            )
            .await
            .unwrap();
        loaded
            .append_batch_at(
                loaded.revision(),
                receipt.events.iter().map(|e| e.event.clone()).collect(),
                receipt.events[0].timestamp_ms,
            )
            .unwrap();
        assert_eq!(
            JsonlSessionStore::new(&root)
                .unwrap()
                .load("child")
                .await
                .unwrap()
                .unwrap(),
            loaded
        );
        assert!(fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".creating-")));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn seeded_creation_never_replaces_existing_history_or_leaves_staging_files() {
        let root = root();
        let store = JsonlSessionStore::new(&root).unwrap();
        let original = store.create(SessionHeader::new("child")).await.unwrap();
        let before = fs::read(root.join("child.jsonl")).unwrap();
        assert!(matches!(
            store.create_seeded(seed("child")).await,
            Err(StoreError::AlreadyExists { .. })
        ));
        assert_eq!(store.load("child").await.unwrap().unwrap(), original);
        assert_eq!(fs::read(root.join("child.jsonl")).unwrap(), before);
        assert!(fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".creating-")));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn fork_resources_are_prefix_scoped_and_survive_parent_deletion() {
        use serde_json::json;
        use xharness_session::{ToolCall, ToolResultData};
        let root = root();
        let store = JsonlSessionStore::new(&root).unwrap();
        store.create(SessionHeader::new("source")).await.unwrap();
        let reference = store
            .archive_tool_result("source", "exact original observation")
            .await
            .unwrap();
        let excluded = store
            .archive_tool_result("source", "not part of the selected prefix")
            .await
            .unwrap();
        let mut header = RequestHeader::new("test", "test");
        header.system = Some("fixed system text".into());
        header.tools = vec![json!({"name":"observe"})];
        let expected = header.harness_view();
        let snapshot_ref = store
            .archive_harness_snapshot("source", &header)
            .await
            .unwrap()
            .unwrap();
        header
            .options
            .insert("harnessSnapshot".into(), snapshot_ref);
        let call = ToolCall {
            id: "observe-1".into(),
            provider_call_id: None,
            index: 0,
            name: "observe".into(),
            arguments_json: "{}".into(),
        };
        let mut assistant = Message::assistant("");
        assistant.tool_calls.push(call.clone());
        store
            .append(
                "source",
                Revision::ZERO,
                vec![
                    E::TurnStart { turn: 1 }.into(),
                    E::UserMessage {
                        message: Message::user("observe"),
                        surface_replace: None,
                    }
                    .into(),
                    E::StepStart { turn: 1, step: 1 }.into(),
                    E::RequestHeader { header }.into(),
                    E::AssistantMessage {
                        turn: 1,
                        step: 1,
                        message: assistant,
                        usage: None,
                    }
                    .into(),
                    E::ToolCall {
                        turn: 1,
                        step: 1,
                        call: call.clone(),
                    }
                    .into(),
                    E::ToolResult {
                        turn: 1,
                        step: 1,
                        result: ToolResultData::success(
                            call.id,
                            json!({"content":"preview","archive":reference}).to_string(),
                        ),
                    }
                    .into(),
                    E::StepEnd { turn: 1, step: 1 }.into(),
                    E::TurnEnd {
                        turn: 1,
                        reason: TurnEndReason::Completed,
                    }
                    .into(),
                ],
            )
            .await
            .unwrap();
        let source = store.load("source").await.unwrap().unwrap();
        let mut child = Session::restore(
            SessionHeader::new("child"),
            source.revision(),
            source.events().to_vec(),
        )
        .unwrap();
        child
            .append(
                child.revision(),
                E::SessionForkOrigin {
                    parent_session_id: "source".into(),
                    before_user_seq: None,
                },
            )
            .unwrap();
        store.create_seeded(child).await.unwrap();
        store.delete_session_data("source").await.unwrap();
        let reopened = JsonlSessionStore::new(&root).unwrap();
        assert_eq!(
            reopened
                .tool_result_archive("child", &reference.sha256)
                .await
                .unwrap()
                .as_deref(),
            Some("exact original observation")
        );
        assert!(reopened
            .tool_result_archive("child", &excluded.sha256)
            .await
            .unwrap()
            .is_none());
        let actual = reopened.harness_header("child", 3).await.unwrap().unwrap();
        assert_eq!(actual.system, expected.system);
        assert_eq!(actual.tools, expected.tools);
        assert!(actual.input.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn missing_fork_resource_leaves_no_published_child() {
        let root = root();
        let store = JsonlSessionStore::new(&root).unwrap();
        // The immutable snapshot is valid, but a referenced per-session
        // Harness sidecar is unavailable. Never publish a partial child.
        let mut snapshot = seed("child");
        let mut header = RequestHeader::new("test", "test");
        header.options.insert(
            "harnessSnapshot".into(),
            serde_json::json!({"kind":"archive","version":1,"sha256":"a".repeat(64)}),
        );
        let mut events = snapshot.events().to_vec();
        events[4].event = E::RequestHeader { header }.into();
        snapshot =
            Session::restore(snapshot.header().clone(), snapshot.revision(), events).unwrap();
        assert!(store.create_seeded(snapshot).await.is_err());
        assert!(store.load("child").await.unwrap().is_none());
        assert!(store.list_headers().await.unwrap().is_empty());
        assert!(fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".creating-")));
        fs::remove_dir_all(root).unwrap();
    }
}
