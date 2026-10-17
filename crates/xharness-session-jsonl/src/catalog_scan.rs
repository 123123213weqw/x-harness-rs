//! Bounded-resident display maintenance on an exact, previously validated
//! catalogue source. This reader never builds a Session or recovery stamp.
use super::*;

pub(super) fn scan(
    path: &Path,
    catalog: &CatalogRecord,
    mut visit: impl FnMut(u64, &[u8], &BatchRecord) -> Result<bool, StoreError>,
) -> Result<Option<history_index::ReplayedSource>, StoreError> {
    let id = &catalog.entry.header.id;
    if read_catalog_record(path, id)?
        .is_none_or(|c| c.entry != catalog.entry || c.fingerprint != catalog.fingerprint)
    {
        return Ok(None);
    }
    let file = secure_open_options()
        .read(true)
        .open(path)
        .map_err(|e| backend_error("open catalogue scan", path, e))?;
    ensure_regular_file(&file, path, "catalogue scan")?;
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    read_record(&mut reader, &mut line, path)?;
    let header: HeaderRecord = decode_owned_json(&line)
        .map_err(|e| corrupt(path, 1, format!("invalid scan header: {e}")))?;
    validate_header_record(path, id, &header)?;
    if header.header != catalog.entry.header || !line.ends_with(b"\n") {
        return Ok(None);
    }
    let header_len = line.len() as u64;
    let mut offset = header_len;
    let mut revision = Revision::ZERO;
    let mut next = 0u64;
    let mut line_number = 1;
    loop {
        // Drop the preceding batch before reading/expanding the next one.
        // read_record and gzip decoding retain the normal 128 MiB per-record
        // safeguards; cumulative transcript text is never retained here.
        line.clear();
        let len = read_record(&mut reader, &mut line, path)?;
        if len == 0 {
            break;
        }
        line_number += 1;
        if !line.ends_with(b"\n") {
            return Ok(None);
        }
        let mut batch = decode_batch_line(&line, header.format_version)
            .map_err(|e| corrupt(path, line_number, format!("invalid scan batch: {e}")))?;
        validate_batch_record(path, line_number, revision, &batch)?;
        for event in &batch.events {
            if event.seq != next
                || event.revision != batch.revision
                || next >= catalog.entry.next_seq
            {
                return Err(corrupt(
                    path,
                    line_number,
                    "catalogue scan coordinates do not match",
                ));
            }
            next += 1;
        }
        for event in &mut batch.events {
            audit::elide(event);
        }
        if !visit(offset, &line, &batch)? {
            return Ok(None);
        }
        revision = batch.revision;
        offset += len as u64;
    }
    if offset != catalog.fingerprint.len
        || next != catalog.entry.next_seq
        || file_fingerprint(path)? != Some(catalog.fingerprint)
        || read_catalog_record(path, id)?
            .is_none_or(|c| c.entry != catalog.entry || c.fingerprint != catalog.fingerprint)
    {
        return Ok(None);
    }
    Ok(Some(history_index::ReplayedSource {
        format_version: header.format_version,
        header_len,
        fingerprint: Some(catalog.fingerprint),
        valid_len: offset,
        needs_separator: false,
    }))
}
