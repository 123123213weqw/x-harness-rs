//! Incremental append of observational events over an exact validated file cut.
#![forbid(unsafe_code)]

use super::*;

/// Caller holds both the process lock and cross-process advisory lock. Neither
/// CAS nor semantic validation nor source identity is relaxed. Only the two
/// non-structural stream event variants can use this bounded cursor; everything
/// else replays the authoritative Session through the normal append path.
pub(super) fn try_append(
    path: &Path,
    session_id: &str,
    cache: &StdMutex<SnapshotCache>,
    expected_revision: Revision,
    events: &[SessionEvent],
) -> Result<Option<AppendReceipt>, StoreError> {
    if events.is_empty()
        || !events.iter().all(|event| {
            matches!(
                event.data(),
                xharness_session::EventData::AssistantChunk { .. }
                    | xharness_session::EventData::ModelReception { .. }
            )
        })
    {
        return Ok(None);
    }
    let Some(fingerprint) = file_fingerprint(path)? else {
        return Ok(None);
    };
    let mut stamp = {
        let cache = cache
            .lock()
            .map_err(|_| backend_message("session snapshot cache is poisoned"))?;
        // A resident snapshot can already append without replay. Keep it hot,
        // rather than trading a cheap append for a later expensive load.
        if cache
            .entries
            .get(path)
            .is_some_and(|entry| entry.fingerprint == fingerprint)
            || cache.scopes.has_snapshot(path, fingerprint)
        {
            return Ok(None);
        }
        let Some(stamp) = cache.catalog_stamps.get(path).filter(|stamp| {
            stamp.fingerprint == fingerprint
                && stamp.valid_len == fingerprint.len
                && !stamp.needs_separator
        }) else {
            return Ok(None);
        };
        stamp.clone()
    };
    if stamp.revision != expected_revision {
        return Err(StoreError::RevisionConflict {
            session_id: session_id.into(),
            expected: expected_revision,
            actual: stamp.revision,
        });
    }
    let timestamp_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64;
    let Some((next, receipt)) =
        stamp
            .stream
            .prepare_append(expected_revision, events, timestamp_ms)?
    else {
        return Ok(None);
    };
    let bytes = encode_line(
        &BatchRecord {
            record: BATCH_RECORD.into(),
            previous_revision: receipt.previous_revision,
            revision: receipt.revision,
            events: receipt.events.clone(),
        },
        path,
    )?;
    let mut file = secure_open_options()
        .read(true)
        .append(true)
        .open(path)
        .map_err(|error| backend_error("open session for stream append", path, error))?;
    ensure_regular_file(&file, path, "session log")?;
    let opened = fingerprint_from_metadata(
        path,
        &file
            .metadata()
            .map_err(|error| backend_error("inspect stream append", path, error))?,
    )?;
    if opened != fingerprint {
        cache_remove(cache, path)?;
        return Err(backend_message("session changed before stream append"));
    }
    file.write_all(&bytes)
        .map_err(|error| backend_error("append stream batch", path, error))?;
    file.flush()
        .map_err(|error| backend_error("flush stream batch", path, error))?;
    let after = fingerprint_from_metadata(
        path,
        &file
            .metadata()
            .map_err(|error| backend_error("inspect appended stream batch", path, error))?,
    )?;
    if after.dev != fingerprint.dev
        || after.ino != fingerprint.ino
        || after.len != fingerprint.len.saturating_add(bytes.len() as u64)
    {
        cache_remove(cache, path)?;
        return Err(backend_message("session changed during stream append"));
    }
    if file_fingerprint(path)? != Some(after) {
        cache_remove(cache, path)?;
        return Err(backend_message("session path changed during stream append"));
    }
    stamp.fingerprint = after;
    stamp.valid_len = after.len;
    stamp.revision = receipt.revision;
    stamp.next_seq = receipt
        .last_seq
        .expect("nonempty stream batch")
        .saturating_add(1);
    stamp.stream = next;
    stamp.journal_hash.update(&bytes);
    stamp.sha256 = format!("{:x}", stamp.journal_hash.clone().finalize());
    // This tiny source stamp lives in the existing bounded map. No history
    // payload is retained, and the resident/admission cache budgets do not grow.
    let mut cache = cache
        .lock()
        .map_err(|_| backend_message("session snapshot cache is poisoned"))?;
    cache.entries.remove(path);
    cache.scopes.remove_snapshot(path);
    if cache.catalog_stamps.len() >= 4096 && !cache.catalog_stamps.contains_key(path) {
        cache.catalog_stamps.clear();
    }
    cache.catalog_stamps.insert(path.to_owned(), stamp);
    Ok(Some(receipt))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn incremental_stream_stamp_hashes_exact_authoritative_bytes() {
        let root = std::env::temp_dir().join(format!(
            "xh-stream-hash-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        // macOS temp paths commonly alias /private/var. Exercise an aliased
        // root on every Unix runner too: internal cache keys are canonical.
        std::fs::create_dir_all(&root).unwrap();
        #[cfg(unix)]
        let requested = {
            let alias = root.join("root-alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            alias
        };
        #[cfg(not(unix))]
        let requested = root.clone();
        let store = JsonlSessionStore::new(&requested)
            .unwrap()
            .with_cache_limits(0, 0);
        store.create(SessionHeader::new("hash")).await.unwrap();
        let mut revision = store
            .append(
                "hash",
                Revision::ZERO,
                vec![
                    xharness_session::EventData::TurnStart { turn: 1 }.into(),
                    xharness_session::EventData::StepStart { turn: 1, step: 1 }.into(),
                ],
            )
            .await
            .unwrap()
            .revision;
        for n in 0..8 {
            revision = store
                .append(
                    "hash",
                    revision,
                    vec![xharness_session::EventData::AssistantChunk {
                        turn: 1,
                        step: 1,
                        chunk: xharness_session::AssistantChunk::TextDelta(format!("{n} 汉字\r\n")),
                    }
                    .into()],
                )
                .await
                .unwrap()
                .revision;
            let path = store.session_path("hash").unwrap();
            let digest = format!(
                "{:x}",
                Sha256::digest(std::fs::read(requested.join("hash.jsonl")).unwrap())
            );
            let cache = store.cache.lock().unwrap();
            let stamp = &cache.catalog_stamps[&path];
            assert_eq!(stamp.sha256, digest);
            assert_eq!(
                format!("{:x}", stamp.journal_hash.clone().finalize()),
                digest
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
