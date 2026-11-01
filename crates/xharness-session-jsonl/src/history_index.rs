//! Disposable offset index. Only a successful full replay may publish it;
//! no recovery or mutation path ever reads it as authoritative state.
use super::*;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use xharness_session::{EventData, SessionHistoryWindow};

const VERSION: u32 = 3;
const MAX_INDEX_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
// Tiny sidecars cost less to decode than three extra fingerprint samples.
const MIN_CACHED_INDEX_BYTES: u64 = 16 * 1024;
const MAX_WINDOW_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    offset: u64,
    len: u64,
    first: u64,
    end: u64,
    revision: Revision,
    sha256: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Builder {
    records: Vec<Record>,
    messages: Vec<u64>,
    inbox: BTreeMap<String, u64>,
    compactions: BTreeMap<String, Vec<u64>>,
    calls: BTreeMap<String, u64>,
    completed: BTreeSet<(u32, u32)>,
    initial_request: Option<u64>,
    #[serde(skip)]
    disabled: bool,
    #[serde(skip)]
    estimated_bytes: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Index {
    version: u32,
    session_id: String,
    fingerprint: FileFingerprint,
    format_version: u32,
    header_len: u64,
    next_seq: u64,
    data: Builder,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    sha256: String,
    index: Index,
}

/// Parsed acceleration only; never a Session or an execution/recovery stamp.
/// Charging four times the serialized size conservatively covers owned fields
/// and collection overhead. This is an accounted-byte ceiling, not an RSS cap.
#[derive(Debug)]
pub(super) struct Cache {
    entries: HashMap<PathBuf, CachedIndex>,
    pub max_bytes: usize,
    pub max_entries: usize,
    clock: u64,
}
#[derive(Debug)]
struct CachedIndex {
    sidecar: FileFingerprint,
    index: Arc<Index>,
    bytes: usize,
    touched: u64,
}
impl Default for Cache {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            max_bytes: 8 * 1024 * 1024,
            max_entries: 4,
            clock: 0,
        }
    }
}
impl Cache {
    pub fn stats(&self) -> CacheStats {
        CacheStats {
            entries: self.entries.len(),
            accounted_bytes: self.entries.values().map(|e| e.bytes).sum(),
            max_bytes: self.max_bytes,
        }
    }
    pub fn clear(&mut self) {
        self.entries.clear();
    }
    fn get(
        &mut self,
        path: &Path,
        sidecar: FileFingerprint,
        source: FileFingerprint,
        id: &str,
        next: u64,
    ) -> Option<Arc<Index>> {
        self.clock = self.clock.wrapping_add(1);
        if let Some(entry) = self.entries.get_mut(path) {
            if entry.sidecar == sidecar
                && entry.index.fingerprint == source
                && entry.index.session_id == id
                && entry.index.next_seq == next
            {
                entry.touched = self.clock;
                return Some(entry.index.clone());
            }
        }
        self.entries.remove(path);
        None
    }
    fn insert(&mut self, path: &Path, sidecar: FileFingerprint, index: Arc<Index>, bytes: usize) {
        self.entries.remove(path);
        if bytes > self.max_bytes || self.max_entries == 0 {
            return;
        }
        while self.entries.len() >= self.max_entries
            || self.stats().accounted_bytes.saturating_add(bytes) > self.max_bytes
        {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.touched)
                .map(|(p, _)| p.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
        self.clock = self.clock.wrapping_add(1);
        self.entries.insert(
            path.to_owned(),
            CachedIndex {
                sidecar,
                index,
                bytes,
                touched: self.clock,
            },
        );
    }
}

pub(super) struct ReplayedSource {
    pub format_version: u32,
    pub header_len: u64,
    pub fingerprint: Option<FileFingerprint>,
    pub valid_len: u64,
    pub needs_separator: bool,
}

pub(super) fn path(journal: &Path) -> PathBuf {
    journal.with_extension("history-index")
}

impl Builder {
    pub(super) fn record(&mut self, offset: u64, line: &[u8], batch: &BatchRecord) {
        if self.disabled {
            return;
        }
        let cost = batch.events.iter().fold(192usize, |n, event| {
            n.saturating_add(match event.data() {
                EventData::AgentInboxSpliced { inserted, .. } => {
                    inserted.iter().fold(0usize, |n, i| {
                        n.saturating_add(i.id.len()).saturating_add(64)
                    })
                }
                EventData::CompactionStart { compaction_id, .. } => {
                    compaction_id.len().saturating_add(64)
                }
                EventData::ToolCall { call, .. } => call.id.len().saturating_add(64),
                _ => 32,
            })
        });
        self.estimated_bytes = self.estimated_bytes.saturating_add(cost);
        if self.records.len() >= MAX_ENTRIES || self.estimated_bytes as u64 > MAX_INDEX_BYTES / 2 {
            *self = Self {
                disabled: true,
                ..Self::default()
            };
            return;
        }
        let first = batch.events.first().map_or(0, |e| e.seq);
        let end = batch
            .events
            .last()
            .map_or(first, |e| e.seq.saturating_add(1));
        self.records.push(Record {
            offset,
            len: line.len() as u64,
            first,
            end,
            revision: batch.revision,
            sha256: format!("{:x}", Sha256::digest(line)),
        });
        for event in &batch.events {
            let compaction_id = match event.data() {
                EventData::CompactionSummary { compaction_id, .. } => Some(compaction_id),
                EventData::UserMessage {
                    surface_replace: Some(replace),
                    ..
                } => Some(&replace.compaction_id),
                _ => None,
            };
            if let Some(sources) = compaction_id.and_then(|id| self.compactions.get_mut(id)) {
                sources.push(event.seq);
            }
            match event.data() {
                EventData::UserMessage { .. } | EventData::ToolResult { .. } => {
                    self.messages.push(event.seq)
                }
                EventData::AssistantMessage { turn, step, .. } => {
                    self.messages.push(event.seq);
                    self.completed.insert((*turn, *step));
                }
                EventData::AgentInboxSpliced { inserted, .. } => {
                    for input in inserted {
                        self.inbox.insert(input.id.clone(), event.seq);
                    }
                }
                EventData::CompactionStart { compaction_id, .. } => {
                    self.compactions
                        .insert(compaction_id.clone(), vec![event.seq]);
                }
                EventData::CompactionProgress { compaction_id, .. } => {
                    // Only the latest numeric snapshot is a page dependency.
                    // A sustained network wait must not create an unbounded context vector.
                    if let Some(sources) = self.compactions.get_mut(compaction_id) {
                        sources.truncate(1);
                        sources.push(event.seq);
                    }
                }
                EventData::ToolCall { call, .. } => {
                    self.calls.insert(call.id.clone(), event.seq);
                }
                EventData::RequestHeader { .. } => {
                    self.initial_request.get_or_insert(event.seq);
                }
                _ => {}
            }
        }
        if self.messages.len()
            + self.inbox.len()
            + self.compactions.len()
            + self.calls.len()
            + self.completed.len()
            > MAX_ENTRIES
        {
            *self = Self {
                disabled: true,
                ..Self::default()
            };
        }
    }

    /// Best effort only. Failing to publish an acceleration index MUST NOT
    /// turn a successful authoritative replay into a storage failure.
    pub(super) fn publish(self, journal: &Path, session: &Session, source: ReplayedSource) {
        self.publish_cursor(journal, &session.header().id, session.next_seq(), source);
    }

    fn publish_cursor(self, journal: &Path, id: &str, next_seq: u64, source: ReplayedSource) {
        if self.disabled
            || source.needs_separator
            || journal.extension().is_none_or(|x| x != "jsonl")
        {
            return;
        }
        let Some(original) = source.fingerprint else {
            return;
        };
        if original.len != source.valid_len {
            return;
        }
        if file_fingerprint(journal).ok().flatten() != Some(original) {
            return;
        }
        let index = Index {
            version: VERSION,
            session_id: id.to_owned(),
            fingerprint: original,
            format_version: source.format_version,
            header_len: source.header_len,
            next_seq,
            data: self,
        };
        let _ = publish_index(journal, &index);
    }
}

fn publish_index(journal: &Path, index: &Index) -> Result<(), StoreError> {
    #[derive(Serialize)]
    struct Output<'a> {
        sha256: String,
        index: &'a Index,
    }
    let body = serde_json::to_vec(index).map_err(|e| backend_message(e.to_string()))?;
    if body.len() as u64 > MAX_INDEX_BYTES {
        return Err(backend_message("history index exceeds its byte budget"));
    }
    let bytes = serde_json::to_vec(&Output {
        sha256: format!("{:x}", Sha256::digest(&body)),
        index,
    })
    .map_err(|e| backend_message(e.to_string()))?;
    if bytes.len() as u64 > MAX_INDEX_BYTES {
        return Err(backend_message("history index exceeds its byte budget"));
    }
    let sidecar = path(journal);
    // Unexpected filesystem objects are not replaced even for a cache write.
    if fs::symlink_metadata(&sidecar).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err(backend_message(
            "history index publication refuses a non-regular sidecar",
        ));
    }
    write_projection_file(&sidecar, &bytes, "history-index")
}

/// Repair only an exact catalogue source. A failed optional sidecar write
/// does not prevent serving the verified in-memory index for this request.
/// An unindexable source retains the caller's original full-replay fallback.
pub(super) fn repair(
    journal: &Path,
    catalog: &CatalogRecord,
) -> Result<Option<Arc<Index>>, StoreError> {
    let mut builder = Builder::default();
    let source = catalog_scan::scan(journal, catalog, |offset, line, batch| {
        builder.record(offset, line, batch);
        Ok(!builder.disabled)
    })?;
    let Some(source) = source else {
        return Ok(None);
    };
    let index = Arc::new(Index {
        version: VERSION,
        session_id: catalog.entry.header.id.clone(),
        fingerprint: catalog.fingerprint,
        format_version: source.format_version,
        header_len: source.header_len,
        next_seq: catalog.entry.next_seq,
        data: builder,
    });
    // Cache publication remains best-effort, just like normal replay. Never
    // turn a valid read-only journal into an error because its cache is unwritable.
    let _ = publish_index(journal, &index);
    Ok(Some(index))
}

fn valid(index: &Index, id: &str, fingerprint: FileFingerprint, next: u64) -> bool {
    if index.version != VERSION
        || index.session_id != id
        || index.fingerprint != fingerprint
        || index.next_seq != next
        || index.header_len > fingerprint.len
        || !matches!(
            index.format_version,
            FILE_FORMAT_VERSION | COMPRESSED_FILE_FORMAT_VERSION
        )
        || index.data.records.len() > MAX_ENTRIES
        || index
            .data
            .messages
            .len()
            .saturating_add(index.data.inbox.len())
            .saturating_add(index.data.compactions.len())
            .saturating_add(index.data.calls.len())
            .saturating_add(index.data.completed.len())
            > MAX_ENTRIES
    {
        return false;
    }
    let mut offset = index.header_len;
    let mut seq = 0;
    for (revision, r) in index.data.records.iter().enumerate() {
        if r.offset != offset
            || r.first != seq
            || r.end <= r.first
            || r.len == 0
            || r.len > MAX_RECORD_BYTES
            || r.revision.get() != revision as u64 + 1
            || r.sha256.len() != 64
        {
            return false;
        }
        let Some(end) = offset.checked_add(r.len) else {
            return false;
        };
        if end > fingerprint.len {
            return false;
        }
        offset = end;
        seq = r.end;
    }
    offset == fingerprint.len
        && seq == next
        && index.data.messages.windows(2).all(|w| w[0] < w[1])
        && index.data.messages.iter().all(|&s| s < next)
        && index
            .data
            .inbox
            .values()
            .chain(index.data.compactions.values().flatten())
            .chain(index.data.calls.values())
            .all(|&s| s < next)
        && index.data.initial_request.is_none_or(|s| s < next)
}

fn read_batch(
    file: &mut File,
    journal: &Path,
    index: &Index,
    n: usize,
    remaining: &mut u64,
) -> Result<Option<BatchRecord>, StoreError> {
    let Some(r) = index.data.records.get(n) else {
        return Ok(None);
    };
    if r.len > *remaining {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(r.offset))
        .map_err(|e| backend_error("seek history", journal, e))?;
    let mut bytes = vec![0; usize::try_from(r.len).map_err(|e| backend_message(e.to_string()))?];
    file.read_exact(&mut bytes)
        .map_err(|e| backend_error("read history", journal, e))?;
    if format!("{:x}", Sha256::digest(&bytes)) != r.sha256 {
        return Ok(None);
    }
    let expanded = if index.format_version == COMPRESSED_FILE_FORMAT_VERSION {
        let tag: RecordTag = match decode_owned_json(&bytes) {
            Ok(v) => v,
            Err(_) => return Ok(None),
        };
        if tag.record == COMPRESSED_BATCH_RECORD {
            let compressed: CompressedBatchRecord = match decode_owned_json(&bytes) {
                Ok(v) => v,
                Err(_) => return Ok(None),
            };
            compressed.uncompressed_len
        } else {
            r.len
        }
    } else {
        r.len
    };
    // Check expanded bytes BEFORE invoking the gzip decoder or JSON allocator.
    let cost = r.len.max(expanded);
    if cost > *remaining {
        return Ok(None);
    }
    *remaining -= cost;
    let mut batch = match decode_batch_line(&bytes, index.format_version) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if batch.record != BATCH_RECORD
        || batch.revision != r.revision
        || batch.events.len() as u64 != r.end - r.first
        || batch
            .events
            .iter()
            .enumerate()
            .any(|(i, e)| e.seq != r.first + i as u64)
    {
        return Ok(None);
    }
    // Release legacy inline request bodies one record at a time, BEFORE
    // accumulating the visible page. UI history never needs audit snapshots.
    for event in &mut batch.events {
        audit::elide(event);
    }
    Ok(Some(batch))
}

fn resident_weight(index: &Index, serialized: usize) -> usize {
    let data = &index.data;
    let mut bytes = std::mem::size_of::<Index>()
        .saturating_add(index.session_id.capacity())
        .saturating_add(
            data.records
                .capacity()
                .saturating_mul(std::mem::size_of::<Record>()),
        )
        .saturating_add(
            data.messages
                .capacity()
                .saturating_mul(std::mem::size_of::<u64>()),
        );
    for record in &data.records {
        bytes = bytes.saturating_add(record.sha256.capacity());
    }
    // Charge BTree node links/spare capacity per entry, not just JSON length.
    for key in data.inbox.keys() {
        bytes = bytes.saturating_add(key.capacity()).saturating_add(96);
    }
    for key in data.calls.keys() {
        bytes = bytes.saturating_add(key.capacity()).saturating_add(96);
    }
    for (key, values) in &data.compactions {
        bytes = bytes
            .saturating_add(key.capacity())
            .saturating_add(112)
            .saturating_add(values.capacity().saturating_mul(std::mem::size_of::<u64>()));
    }
    bytes = bytes.saturating_add(data.completed.len().saturating_mul(80));
    bytes.max(serialized.saturating_mul(4))
}

fn load_index(
    journal: &Path,
    sidecar: &Path,
    id: &str,
    fingerprint: FileFingerprint,
    next: u64,
    cache: &StdMutex<Cache>,
) -> Result<Option<Arc<Index>>, StoreError> {
    let m = match fs::symlink_metadata(sidecar) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if !m.is_file() || m.file_type().is_symlink() || m.len() > MAX_INDEX_BYTES {
        return Ok(None);
    }
    let cacheable = {
        let mut cache = cache
            .lock()
            .map_err(|_| backend_message("history index cache is poisoned"))?;
        let enabled = m.len() >= MIN_CACHED_INDEX_BYTES
            && cache.max_entries > 0
            && (m.len() as usize).saturating_mul(4) <= cache.max_bytes;
        if !enabled {
            cache.entries.remove(journal);
        }
        enabled
    };
    let original_sidecar = if cacheable {
        file_fingerprint(sidecar)?
    } else {
        None
    };
    if let Some(stamp) = original_sidecar {
        if let Some(index) = cache
            .lock()
            .map_err(|_| backend_message("history index cache is poisoned"))?
            .get(journal, stamp, fingerprint, id, next)
        {
            return Ok(Some(index));
        }
    }
    let mut bytes = Vec::new();
    let file = match secure_open_options().read(true).open(sidecar) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    if ensure_regular_file(&file, sidecar, "history index").is_err() {
        return Ok(None);
    }
    if file
        .take(MAX_INDEX_BYTES + 1)
        .read_to_end(&mut bytes)
        .is_err()
        || bytes.len() as u64 > MAX_INDEX_BYTES
    {
        return Ok(None);
    }
    let envelope: Envelope = match decode_owned_json(&bytes) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let body = serde_json::to_vec(&envelope.index).map_err(|e| backend_message(e.to_string()))?;
    let index = envelope.index;
    if format!("{:x}", Sha256::digest(&body)) != envelope.sha256
        || !valid(&index, id, fingerprint, next)
    {
        return Ok(None);
    }
    let index = Arc::new(index);
    if let Some(original) = original_sidecar {
        if file_fingerprint(sidecar)? != Some(original)
            || file_fingerprint(journal)? != Some(fingerprint)
        {
            return Ok(None);
        }
        cache
            .lock()
            .map_err(|_| backend_message("history index cache is poisoned"))?
            .insert(
                journal,
                original,
                index.clone(),
                resident_weight(&index, bytes.len()),
            );
    }
    Ok(Some(index))
}

pub(super) fn available(
    journal: &Path,
    id: &str,
    next: u64,
    cache: &StdMutex<Cache>,
) -> Result<bool, StoreError> {
    let Some(source) = file_fingerprint(journal)? else {
        return Ok(false);
    };
    Ok(load_index(journal, &path(journal), id, source, next, cache)?.is_some())
}

/// Called under the ordinary process/advisory locks. Any unusable sidecar or
/// bounded-window overflow returns None and leaves the journal untouched.
pub(super) fn read(
    journal: &Path,
    id: &str,
    next: u64,
    before: Option<u64>,
    max: usize,
    cache: &StdMutex<Cache>,
) -> Result<Option<SessionHistoryWindow>, StoreError> {
    let Some(fingerprint) = file_fingerprint(journal)? else {
        return Ok(None);
    };
    let sidecar = path(journal);
    let Some(index) = load_index(journal, &sidecar, id, fingerprint, next, cache)? else {
        return Ok(None);
    };
    read_prepared(journal, &index, before, max)
}

pub(super) fn read_prepared(
    journal: &Path,
    index: &Index,
    before: Option<u64>,
    max: usize,
) -> Result<Option<SessionHistoryWindow>, StoreError> {
    let fingerprint = index.fingerprint;
    let next = index.next_seq;
    if file_fingerprint(journal)? != Some(fingerprint) {
        return Ok(None);
    }
    let end = before.unwrap_or(next).min(next);
    let messages = index.data.messages.partition_point(|&s| s < end);
    let start = if messages >= max.max(1) {
        index.data.messages[messages - max.max(1)]
    } else {
        0
    };
    let first = index.data.records.partition_point(|r| r.end <= start);
    let mut file = secure_open_options()
        .read(true)
        .open(journal)
        .map_err(|e| backend_error("open indexed history", journal, e))?;
    ensure_regular_file(&file, journal, "indexed history")?;
    let mut remaining = MAX_WINDOW_BYTES;
    let mut events = Vec::new();
    for n in first..index.data.records.len() {
        if index.data.records[n].first >= end {
            break;
        }
        let Some(batch) = read_batch(&mut file, journal, index, n, &mut remaining)? else {
            return Ok(None);
        };
        events.extend(
            batch
                .events
                .into_iter()
                .filter(|e| e.seq >= start && e.seq < end),
        );
    }
    let mut needed = BTreeSet::new();
    for event in &events {
        match event.data() {
            EventData::UserMessage {
                message,
                surface_replace,
            } => {
                if let Some(seq) = message.id.as_ref().and_then(|id| index.data.inbox.get(id)) {
                    needed.insert(*seq);
                }
                if let Some(seq) = surface_replace
                    .as_ref()
                    .and_then(|r| index.data.compactions.get(&r.compaction_id))
                    .and_then(|sources| sources.first())
                {
                    needed.insert(*seq);
                }
            }
            EventData::AssistantMessage { message, .. } => {
                if let Some(seq) = message.id.as_ref().and_then(|id| index.data.inbox.get(id)) {
                    needed.insert(*seq);
                }
            }
            EventData::CompactionProgress { compaction_id, .. }
            | EventData::CompactionEnd { compaction_id, .. } => {
                if let Some(sources) = index.data.compactions.get(compaction_id) {
                    needed.extend(sources);
                }
            }
            EventData::ToolResult { result, .. } => {
                if let Some(seq) = index.data.calls.get(&result.call_id) {
                    needed.insert(*seq);
                }
            }
            _ => {}
        }
    }
    needed.retain(|&s| s < start || s >= end);
    let records: BTreeSet<_> = needed
        .iter()
        .map(|&s| index.data.records.partition_point(|r| r.end <= s))
        .collect();
    let mut context = Vec::new();
    for n in records {
        let Some(batch) = read_batch(&mut file, journal, index, n, &mut remaining)? else {
            return Ok(None);
        };
        context.extend(batch.events.into_iter().filter(|e| needed.contains(&e.seq)));
    }
    // Non-cooperating replacement must not make a mixed-version page visible.
    if file_fingerprint(journal)? != Some(fingerprint) {
        return Ok(None);
    }
    Ok(Some(SessionHistoryWindow {
        next_seq: next,
        has_more: start > 0,
        events,
        context,
        initial_request_header_seq: index.data.initial_request,
        completed_steps: index.data.completed.iter().copied().collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Index {
        Index {
            version: VERSION,
            session_id: "bounds".to_owned(),
            fingerprint: FileFingerprint {
                dev: 0,
                ino: 0,
                len: 200,
                modified_seconds: 0,
                modified_nanoseconds: 0,
                changed_seconds: 0,
                changed_nanoseconds: 0,
                sample_hash: 0,
            },
            format_version: FILE_FORMAT_VERSION,
            header_len: 100,
            next_seq: 2,
            data: Builder {
                records: vec![Record {
                    offset: 100,
                    len: 100,
                    first: 0,
                    end: 2,
                    revision: Revision(1),
                    sha256: "0".repeat(64),
                }],
                messages: vec![0, 1],
                ..Builder::default()
            },
        }
    }

    #[test]
    fn parsed_index_lru_tracks_hits_and_evicts_by_both_limits() {
        let mut cache = Cache {
            max_bytes: 20,
            max_entries: 2,
            ..Cache::default()
        };
        let index = Arc::new(sample());
        let stamp = index.fingerprint;
        cache.insert(Path::new("a"), stamp, index.clone(), 10);
        cache.insert(Path::new("b"), stamp, index.clone(), 10);
        let hit = cache
            .get(Path::new("a"), stamp, stamp, "bounds", 2)
            .unwrap();
        assert!(
            Arc::ptr_eq(&hit, &index),
            "reuse parsed allocation, not a deep clone"
        );
        cache.insert(Path::new("c"), stamp, index.clone(), 10);
        assert!(!cache.entries.contains_key(Path::new("b")));
        assert_eq!(cache.stats().accounted_bytes, 20);
        cache.insert(Path::new("large"), stamp, index.clone(), 21);
        assert_eq!(cache.stats().entries, 2);
        let mut changed = stamp;
        changed.len += 1;
        assert!(cache
            .get(Path::new("a"), changed, stamp, "bounds", 2)
            .is_none());
        assert!(!cache.entries.contains_key(Path::new("a")));
        assert!(cache
            .get(Path::new("c"), stamp, changed, "bounds", 2)
            .is_none());
        assert_eq!(cache.stats().entries, 0);
    }

    #[test]
    fn index_layout_rejects_forged_bounds_versions_and_coordinates_without_panicking() {
        let initial = sample();
        let fingerprint = initial.fingerprint;
        assert!(valid(&initial, "bounds", fingerprint, 2));
        for mutate in [
            (|i: &mut Index| i.version += 1) as fn(&mut Index),
            |i| i.session_id = "other".to_owned(),
            |i| i.next_seq = u64::MAX,
            |i| i.header_len = u64::MAX,
            |i| i.format_version = u32::MAX,
            |i| i.data.records[0].offset = u64::MAX,
            |i| i.data.records[0].len = u64::MAX,
            |i| i.data.records[0].first = u64::MAX,
            |i| i.data.records[0].end = u64::MAX,
            |i| i.data.records[0].revision = Revision(u64::MAX),
            |i| i.data.records[0].sha256.clear(),
            |i| i.data.messages = vec![1, 0],
            |i| i.data.messages = vec![0, 0],
            |i| {
                i.data.calls.insert("invalid".to_owned(), 2);
            },
            |i| i.data.initial_request = Some(2),
        ] {
            let mut index = sample();
            mutate(&mut index);
            assert!(!valid(&index, "bounds", fingerprint, 2));
        }
    }

    #[test]
    fn oversized_builder_discards_acceleration_state_not_session_events() {
        let event = LoggedEvent {
            seq: 0,
            revision: Revision(1),
            timestamp_ms: 0,
            event: EventData::TurnStart { turn: 1 }.into(),
        };
        let batch = BatchRecord {
            record: BATCH_RECORD.to_owned(),
            previous_revision: Revision::ZERO,
            revision: Revision(1),
            events: vec![event.clone()],
        };
        let mut builder = Builder {
            estimated_bytes: MAX_INDEX_BYTES as usize,
            ..Builder::default()
        };
        builder.record(100, b"example\n", &batch);
        assert!(builder.disabled);
        assert!(builder.records.is_empty());
        builder.record(100, b"example\n", &batch);
        assert!(builder.records.is_empty());
        assert_eq!(batch.events, vec![event]);
    }

    #[test]
    fn compressed_record_budget_is_checked_before_expansion() {
        let root = std::env::temp_dir().join(format!(
            "xharness-index-expansion-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("source");
        let bytes = serde_json::to_vec(&CompressedBatchRecord {
            record: COMPRESSED_BATCH_RECORD.to_owned(),
            uncompressed_len: MAX_WINDOW_BYTES + 1,
            sha256: "0".repeat(64),
            compressed_sha256: "0".repeat(64),
            data: "invalid base64; never decode".to_owned(),
        })
        .unwrap();
        fs::write(&path, &bytes).unwrap();
        let mut index = sample();
        index.format_version = COMPRESSED_FILE_FORMAT_VERSION;
        index.data.records[0].offset = 0;
        index.data.records[0].len = bytes.len() as u64;
        index.data.records[0].sha256 = format!("{:x}", Sha256::digest(&bytes));
        let mut file = File::open(&path).unwrap();
        let mut budget = MAX_WINDOW_BYTES;
        assert!(read_batch(&mut file, &path, &index, 0, &mut budget)
            .unwrap()
            .is_none());
        assert_eq!(budget, MAX_WINDOW_BYTES);
        assert!(
            read_batch(&mut file, &path, &index, usize::MAX, &mut budget)
                .unwrap()
                .is_none()
        );
        drop(file);
        fs::remove_dir_all(root).unwrap();
    }
}
