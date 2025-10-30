use std::{future::Future, sync::Arc, time::Duration};

use futures::FutureExt;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    ResourceKeyResolver, ToolConcurrency, ToolDefinition, ToolHandler, ToolResult, ToolSpec,
};

/// Smallest supported model-facing tool-result budget.
///
/// The loop rejects smaller configured limits. [`tool_result_for_model`] also
/// uses this envelope as a fail-safe for direct callers, prioritizing valid
/// JSON over an impossible byte limit.
const LIMIT_TOO_SMALL_ENVELOPE: &str =
    r#"{"ok":false,"content":"","error":"tool result limit too small","truncated":true}"#;
pub const MIN_TOOL_RESULT_LIMIT_BYTES: usize = LIMIT_TOO_SMALL_ENVELOPE.len();

impl ToolSpec {
    pub fn new<F, Fut>(
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: Value,
        handler: F,
    ) -> Self
    where
        F: Fn(Value, CancellationToken) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ToolResult> + Send + 'static,
    {
        let handler: ToolHandler =
            Arc::new(move |arguments, cancellation| handler(arguments, cancellation).boxed());
        Self {
            definition: ToolDefinition {
                name: name.into(),
                description: description.into(),
                parameters,
            },
            handler,
            timeout: Duration::from_secs(120),
            concurrency: ToolConcurrency::Parallel,
            resource_key_resolver: None,
            requires_approval: false,
        }
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn keyed<F>(mut self, resolver: F) -> Self
    where
        F: Fn(&Value) -> Option<String> + Send + Sync + 'static,
    {
        self.concurrency = ToolConcurrency::Keyed;
        self.resource_key_resolver = Some(Arc::new(resolver) as ResourceKeyResolver);
        self
    }

    pub fn exclusive(mut self) -> Self {
        self.concurrency = ToolConcurrency::Exclusive;
        self.resource_key_resolver = None;
        self
    }

    /// Requires the host to approve each call before the handler is started.
    pub fn requires_approval(mut self) -> Self {
        self.requires_approval = true;
        self
    }
}

fn utf8_prefix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn encode_tool_result(result: &ToolResult, content: &str, error: &str, truncated: bool) -> String {
    serde_json::to_string(&json!({
        "ok": result.ok,
        "content": content,
        "error": error,
        "truncated": result.truncated || truncated,
    }))
    .expect("serializing a JSON object cannot fail")
}

fn utf8_suffix(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut start = value.len().saturating_sub(max_bytes);
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn sha256_hex(value: &str) -> String {
    let mut output = String::with_capacity(64);
    for byte in Sha256::digest(value.as_bytes()) {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn head_tail_excerpt(source: &str, keep_bytes: usize) -> (String, usize) {
    let head_budget = keep_bytes.saturating_mul(2) / 3;
    let head = utf8_prefix(source, head_budget);
    let tail = utf8_suffix(&source[head.len()..], keep_bytes.saturating_sub(head.len()));
    let omitted = source
        .len()
        .saturating_sub(head.len())
        .saturating_sub(tail.len());
    (
        format!("{head}\n...[{omitted} UTF-8 bytes omitted by head_tail/v1]...\n{tail}"),
        omitted,
    )
}

fn encode_reduced_tool_result(
    result: &ToolResult,
    excerpt: &str,
    source_is_error: bool,
    original_bytes: usize,
    omitted_bytes: usize,
    sha256: &str,
) -> String {
    serde_json::to_string(&json!({
        "ok": result.ok,
        "content": if source_is_error { "" } else { excerpt },
        "error": if source_is_error { excerpt } else { "" },
        "truncated": true,
        "reduction": {
            "strategy": "head_tail/v1",
            "original_bytes": original_bytes,
            "omitted_bytes": omitted_bytes,
            "sha256": sha256,
        }
    }))
    .expect("serializing a JSON object cannot fail")
}

/// Produces the bounded JSON value written back to the model. The original
/// [`ToolResult`] remains untouched and is emitted in `ToolCompleted`.
pub fn tool_result_for_model(result: &ToolResult, max_bytes: usize) -> (String, bool) {
    if max_bytes < MIN_TOOL_RESULT_LIMIT_BYTES {
        return (LIMIT_TOO_SMALL_ENVELOPE.to_owned(), true);
    }

    let full = encode_tool_result(result, &result.content, &result.error, false);
    if full.len() <= max_bytes {
        return (full, false);
    }

    let minimal = encode_tool_result(result, "", "", true);
    debug_assert!(minimal.len() <= max_bytes);

    let source = if result.content.is_empty() {
        &result.error
    } else {
        &result.content
    };
    let source_is_error = result.content.is_empty();
    let digest = sha256_hex(source);
    let mut low = 0usize;
    let mut high = source.len();
    let mut reduced = None;
    while low <= high {
        let midpoint = low + (high - low) / 2;
        let (excerpt, omitted) = head_tail_excerpt(source, midpoint);
        let candidate = encode_reduced_tool_result(
            result,
            &excerpt,
            source_is_error,
            source.len(),
            omitted,
            &digest,
        );
        if candidate.len() <= max_bytes {
            reduced = Some(candidate);
            low = midpoint.saturating_add(1);
        } else if midpoint == 0 {
            break;
        } else {
            high = midpoint - 1;
        }
    }
    if let Some(reduced) = reduced {
        return (reduced, true);
    }

    let mut low = 0usize;
    let mut high = source.len();
    let mut best = String::new();
    while low <= high {
        let midpoint = low + (high - low) / 2;
        let prefix = utf8_prefix(source, midpoint);
        let candidate = if result.content.is_empty() {
            encode_tool_result(result, "", prefix, true)
        } else {
            encode_tool_result(result, prefix, "", true)
        };
        if candidate.len() <= max_bytes {
            best = candidate;
            low = midpoint.saturating_add(1);
        } else if midpoint == 0 {
            break;
        } else {
            high = midpoint - 1;
        }
    }
    if best.is_empty() {
        best = minimal;
    }
    (best, true)
}
