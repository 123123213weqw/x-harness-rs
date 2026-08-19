use bytes::Bytes;
use xharness_core::ProviderError;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: String,
}

#[derive(Clone, Debug, Default)]
pub struct SseParser {
    pending: Vec<u8>,
    data_lines: Vec<String>,
    event_name: String,
    last_event_id: String,
}

impl SseParser {
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
            self.consume_line(&line, &mut output);
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
            self.consume_line(&line, &mut output);
        }

        if consumed > 0 {
            self.pending.drain(..consumed);
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

    fn consume_line(&mut self, line: &str, output: &mut Vec<SseEvent>) {
        if line.is_empty() {
            self.dispatch(output);
            return;
        }
        if line.starts_with(':') {
            return;
        }

        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "data" => self.data_lines.push(value.to_owned()),
            "event" => self.event_name = value.to_owned(),
            "id" if !value.contains('\0') => self.last_event_id = value.to_owned(),
            _ => {}
        }
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
    }
}
