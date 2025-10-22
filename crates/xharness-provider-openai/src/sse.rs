use bytes::Bytes;
use xharness_core::ProviderError;

pub const DEFAULT_SSE_PENDING_LIMIT_BYTES: usize = 1024 * 1024;
pub const DEFAULT_SSE_EVENT_LIMIT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: String,
}

#[derive(Clone, Debug)]
pub struct SseParser {
    pending: Vec<u8>,
    data_lines: Vec<String>,
    data_bytes: usize,
    event_name: String,
    last_event_id: String,
    max_pending_bytes: usize,
    max_event_bytes: usize,
}

impl Default for SseParser {
    fn default() -> Self {
        Self::with_limits(
            DEFAULT_SSE_PENDING_LIMIT_BYTES,
            DEFAULT_SSE_EVENT_LIMIT_BYTES,
        )
    }
}

impl SseParser {
    pub fn with_limits(max_pending_bytes: usize, max_event_bytes: usize) -> Self {
        Self {
            pending: Vec::new(),
            data_lines: Vec::new(),
            data_bytes: 0,
            event_name: String::new(),
            last_event_id: String::new(),
            max_pending_bytes,
            max_event_bytes,
        }
    }

    pub fn feed(
        &mut self,
        chunk: impl AsRef<[u8]>,
        final_chunk: bool,
    ) -> Result<Vec<SseEvent>, ProviderError> {
        self.pending.extend_from_slice(chunk.as_ref());
        let mut output = Vec::new();
        let mut consumed = 0usize;

        while let Some(relative) = self.pending[consumed..]
            .iter()
            .position(|byte| *byte == b'\n')
        {
            let line_end = consumed + relative;
            let mut content_end = line_end;
            if content_end > consumed && self.pending[content_end - 1] == b'\r' {
                content_end -= 1;
            }
            let line = std::str::from_utf8(&self.pending[consumed..content_end])
                .map_err(|error| ProviderError::new(format!("invalid UTF-8 in SSE line: {error}")))?
                .to_owned();
            consumed = line_end + 1;
            self.consume_line(&line, &mut output)?;
        }

        if final_chunk && consumed < self.pending.len() {
            let mut content_end = self.pending.len();
            if content_end > consumed && self.pending[content_end - 1] == b'\r' {
                content_end -= 1;
            }
            let line = std::str::from_utf8(&self.pending[consumed..content_end])
                .map_err(|error| ProviderError::new(format!("invalid UTF-8 in SSE line: {error}")))?
                .to_owned();
            consumed = self.pending.len();
            self.consume_line(&line, &mut output)?;
        }

        if consumed > 0 {
            self.pending.drain(..consumed);
        }
        if self.pending.len() > self.max_pending_bytes {
            return Err(ProviderError::new(format!(
                "SSE pending line exceeds {} bytes",
                self.max_pending_bytes
            )));
        }
        if final_chunk {
            if !self.pending.is_empty() {
                return Err(ProviderError::new("incomplete UTF-8 at end of SSE stream"));
            }
            self.dispatch(&mut output);
        }
        Ok(output)
    }

    pub fn feed_bytes(
        &mut self,
        chunk: Bytes,
        final_chunk: bool,
    ) -> Result<Vec<SseEvent>, ProviderError> {
        self.feed(chunk, final_chunk)
    }

    fn consume_line(
        &mut self,
        line: &str,
        output: &mut Vec<SseEvent>,
    ) -> Result<(), ProviderError> {
        if line.is_empty() {
            self.dispatch(output);
            return Ok(());
        }
        if line.starts_with(':') {
            return Ok(());
        }

        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "data" => {
                let separator = usize::from(!self.data_lines.is_empty());
                self.data_bytes = self
                    .data_bytes
                    .saturating_add(separator)
                    .saturating_add(value.len());
                self.data_lines.push(value.to_owned());
            }
            "event" => self.event_name = value.to_owned(),
            "id" if !value.contains('\0') => self.last_event_id = value.to_owned(),
            _ => {}
        }
        let retained_bytes = self
            .data_bytes
            .saturating_add(self.event_name.len())
            .saturating_add(self.last_event_id.len());
        if retained_bytes > self.max_event_bytes {
            return Err(ProviderError::new(format!(
                "SSE event exceeds {} bytes",
                self.max_event_bytes
            )));
        }
        Ok(())
    }

    fn dispatch(&mut self, output: &mut Vec<SseEvent>) {
        if self.data_lines.is_empty() {
            self.event_name.clear();
            return;
        }
        output.push(SseEvent {
            event: std::mem::take(&mut self.event_name),
            data: self.data_lines.join("\n"),
            id: self.last_event_id.clone(),
        });
        self.data_lines.clear();
        self.data_bytes = 0;
    }
}
