//! Disposable source-bound projection checkpoint. Never creates a `Session`.
//! Only validated loads/appends can publish; an unsupported suffix is left to
//! the projection owner, which must fall back to full semantic replay.
use super::*;
use xharness_session::{SessionRecoveryCheckpoint, SessionRecoveryTail};

const VERSION: u32 = 1;
const MAX_CHECKPOINT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_TAIL_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TAIL_EVENTS: usize = 4096;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    version: u32,
    source: FileFingerprint,
    prefix_sha256: String,
    checkpoint: SessionRecoveryCheckpoint,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    sha256: String,
    body: Body,
}
pub(super) fn path(journal: &Path) -> PathBuf {
    journal.with_extension("recovery-checkpoint")
}

pub(super) fn publish(
    journal: &Path,
    checkpoint: SessionRecoveryCheckpoint,
    stamp: ValidatedStamp,
) -> Result<(), StoreError> {
    if checkpoint.schema.is_empty()
        || checkpoint.schema.len() > 128
        || checkpoint.next_seq != stamp.next_seq
        || checkpoint.revision != stamp.revision
        || stamp.valid_len != stamp.fingerprint.len
        || stamp.needs_separator
        || file_fingerprint(journal)? != Some(stamp.fingerprint)
    {
        return Ok(());
    }
    // Verify the immutable header rather than trusting an application payload
    // stamped with another session's cursor.
    let (header, _) = read_header(journal, &checkpoint.header.id)?;
    if header.header != checkpoint.header {
        return Ok(());
    }
    let body = Body {
        version: VERSION,
        source: stamp.fingerprint,
        prefix_sha256: stamp.sha256,
        checkpoint,
    };
    let digest = digest(&body)?;
    let bytes = serde_json::to_vec(&Envelope {
        sha256: digest,
        body,
    })
    .map_err(|e| backend_message(e.to_string()))?;
    if bytes.len() as u64 > MAX_CHECKPOINT_BYTES {
        return Ok(());
    }
    let dest = path(journal);
    static NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let tmp = dest.with_file_name(format!(
        ".recovery-{}-{}",
        std::process::id(),
        NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = secure_open_options()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|e| backend_error("stage recovery checkpoint", &tmp, e))?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| backend_error("write recovery checkpoint", &tmp, e))?;
        drop(file);
        if dest.exists() {
            replace_compacted_file(&dest, &tmp)?;
        } else {
            fs::rename(&tmp, &dest)
                .map_err(|e| backend_error("publish recovery checkpoint", &dest, e))?;
        }
        sync_parent_directory(journal)
    })();
    let _ = fs::remove_file(&tmp);
    result
}
fn digest(body: &Body) -> Result<String, StoreError> {
    serde_json::to_vec(body)
        .map(|b| format!("{:x}", Sha256::digest(b)))
        .map_err(|e| backend_message(e.to_string()))
}
fn read_header(journal: &Path, id: &str) -> Result<(HeaderRecord, u64), StoreError> {
    let file = secure_open_options()
        .read(true)
        .open(journal)
        .map_err(|e| backend_error("open recovery source", journal, e))?;
    ensure_regular_file(&file, journal, "session log")?;
    let mut reader = BufReader::new(file);
    // Headers are small; do not allocate a full arbitrary source line.
    let mut line = Vec::new();
    reader
        .by_ref()
        .take(MAX_CATALOG_BYTES + 1)
        .read_until(b'\n', &mut line)
        .map_err(|e| backend_error("read recovery header", journal, e))?;
    if line.len() as u64 > MAX_CATALOG_BYTES || !line.ends_with(b"\n") {
        return Err(backend_message("unusable recovery header"));
    }
    let header: HeaderRecord =
        decode_owned_json(&line).map_err(|e| backend_message(e.to_string()))?;
    validate_header_record(journal, id, &header)?;
    Ok((header, line.len() as u64))
}

pub(super) fn read(
    journal: &Path,
    id: &str,
    schema: &str,
) -> Result<Option<SessionRecoveryTail>, StoreError> {
    let sidecar = path(journal);
    let metadata = match fs::symlink_metadata(&sidecar) {
        Ok(m) if m.is_file() && !m.file_type().is_symlink() && m.len() <= MAX_CHECKPOINT_BYTES => m,
        _ => return Ok(None),
    };
    let file = secure_open_options()
        .read(true)
        .open(&sidecar)
        .map_err(|e| backend_error("open recovery checkpoint", &sidecar, e))?;
    ensure_regular_file(&file, &sidecar, "recovery checkpoint")?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_CHECKPOINT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| backend_error("read recovery checkpoint", &sidecar, e))?;
    if bytes.len() as u64 > MAX_CHECKPOINT_BYTES {
        return Ok(None);
    }
    let Ok(envelope) = decode_owned_json::<Envelope>(&bytes) else {
        return Ok(None);
    };
    let body = envelope.body;
    if body.version != VERSION
        || body.checkpoint.schema != schema
        || body.checkpoint.header.id != id
        || body.checkpoint.header.version != SessionHeader::FORMAT_VERSION
        || body.prefix_sha256.len() != 64
        || digest(&body)? != envelope.sha256
    {
        return Ok(None);
    }
    let Some(before) = file_fingerprint(journal)? else {
        return Ok(None);
    };
    if before.len < body.source.len || before.len - body.source.len > MAX_TAIL_BYTES {
        return Ok(None);
    }
    let (header, header_len) = read_header(journal, id)?;
    if header.header != body.checkpoint.header || header_len > body.source.len {
        return Ok(None);
    }
    if before != body.source {
        // The unchanged case costs only fixed-size fingerprint samples. A grown
        // journal needs an exact streaming prefix hash: O(bytes) I/O, bounded
        // memory, no decoding/retention of the old history. A rewrite/replacement
        // is not an append, and cannot inherit a checkpoint.
        if before.len == body.source.len || !same_file(before, body.source) {
            return Ok(None);
        }
        let mut file = secure_open_options()
            .read(true)
            .open(journal)
            .map_err(|e| backend_error("open checkpoint prefix", journal, e))?;
        let mut hasher = Sha256::new();
        let mut remaining = body.source.len;
        let mut buffer = [0u8; 64 * 1024];
        while remaining > 0 {
            let n = usize::try_from(remaining.min(buffer.len() as u64)).unwrap();
            file.read_exact(&mut buffer[..n])
                .map_err(|e| backend_error("read checkpoint prefix", journal, e))?;
            hasher.update(&buffer[..n]);
            remaining -= n as u64;
        }
        if format!("{:x}", hasher.finalize()) != body.prefix_sha256 {
            return Ok(None);
        }
    }
    let mut file = secure_open_options()
        .read(true)
        .open(journal)
        .map_err(|e| backend_error("open checkpoint tail", journal, e))?;
    ensure_regular_file(&file, journal, "session log")?;
    file.seek(SeekFrom::Start(body.source.len))
        .map_err(|e| backend_error("seek checkpoint tail", journal, e))?;
    let mut reader = BufReader::new(file.take(before.len - body.source.len));
    let mut events = Vec::new();
    let mut revision = body.checkpoint.revision;
    let mut next_seq = body.checkpoint.next_seq;
    let mut expanded_budget = MAX_TAIL_BYTES;
    loop {
        let mut line = Vec::new();
        if read_record(&mut reader, &mut line, journal)? == 0 {
            break;
        }
        if !line.ends_with(b"\n") {
            return Ok(None);
        }
        let mut cost = line.len() as u64;
        if header.format_version == COMPRESSED_FILE_FORMAT_VERSION {
            let Ok(tag) = decode_owned_json::<RecordTag>(&line) else {
                return Ok(None);
            };
            if tag.record == COMPRESSED_BATCH_RECORD {
                let Ok(compressed) = decode_owned_json::<CompressedBatchRecord>(&line) else {
                    return Ok(None);
                };
                cost = cost.max(compressed.uncompressed_len);
            }
        }
        if cost > expanded_budget {
            return Ok(None);
        }
        expanded_budget -= cost;
        let Ok(batch) = decode_batch_line(&line, header.format_version) else {
            return Ok(None);
        };
        if batch.record != BATCH_RECORD
            || batch.events.is_empty()
            || batch.previous_revision != revision
            || revision.0.checked_add(1) != Some(batch.revision.0)
            || events.len().saturating_add(batch.events.len()) > MAX_TAIL_EVENTS
        {
            return Ok(None);
        }
        for event in batch.events {
            if event.seq != next_seq || event.revision != batch.revision {
                return Ok(None);
            }
            let Some(next) = next_seq.checked_add(1) else {
                return Ok(None);
            };
            next_seq = next;
            events.push(event);
        }
        revision = batch.revision;
    }
    if file_fingerprint(journal)? != Some(before) {
        return Ok(None);
    }
    Ok(Some(SessionRecoveryTail {
        checkpoint: body.checkpoint,
        events,
        next_seq,
        revision,
    }))
}
fn same_file(a: FileFingerprint, b: FileFingerprint) -> bool {
    #[cfg(unix)]
    {
        a.dev == b.dev && a.ino == b.ino
    }
    #[cfg(windows)]
    {
        a.changed_seconds == b.changed_seconds && a.changed_nanoseconds == b.changed_nanoseconds
    }
}
