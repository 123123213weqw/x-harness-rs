# Durable attachments aligned with DeepSeek Harness

## Status

Accepted: the user requested replication of the upstream attachment approach after reviewing it. Reference: deepseek-ai/deepseek-harness at c389f96bf3a9b6807cb71ed6bdad5849be0df6d8.

## Context and decision

The existing composer displays images, but the Rust host retains their base64 only in memory and sends a placeholder to every model. Implement a shared, provider-neutral attachment boundary: immutable, content-addressed storage; ordered text/image/file references in durable messages; request-time image capability projection; and file handles for ordinary documents. Existing string-only logs must continue to deserialize unchanged. Desktop and browser use the same host.

The user previously preferred an auxiliary vision model, but the latest request explicitly selects upstream behavior: text-only routes get an explicit omitted-image descriptor, never an implicit paid call to another model. `read_image` must enforce the calling route's image capability before reading.

```text
composer -> validated upload/admission -> immutable attachment objects
                                      -> durable message references
durable references -> request projection -> text model: omitted-image text
                                        -> vision model: image payload
                                        -> generic file: read-only file handle
```

## Alternatives

1. UI-only image preview: rejected; it does not persist bytes or provide vision input.
2. Import the entire new Node backend: rejected; duplicates the Rust runtime and desktop lifecycle.
3. Reproduce upstream contracts in Rust and adapt the existing shared UI: selected. Provider-specific Files API transport optimizations are separate from the required inline image transport.

## Failure and security boundaries

- Decode and validate image signatures, dimensions and bytes before admission; reject the complete prompt on a bad part.
- Do not store base64, credentials, browser paths or provider file IDs in durable messages.
- Never trust a client-supplied local path or metadata. Canonical store paths come from validated digests; sanitize both Windows and Unix filenames.
- Attachment retrieval requires an actual reference in the requested session, including after restart and forks.
- Publish complete files atomically; cancellation/failure cannot expose a partial object. No automatic deletion of objects referenced by history.
- Bound image decoding and transport memory. Report deployment limits explicitly; generic file upload does not imply automatic PDF/Office parsing.
- Keep current installations, release channels, keys and application processes untouched.

## Verification

Storage corruption/path traversal/admission tests; image and generic-file restart/replay tests; Chat Completions and Responses request fixtures; text-only fallback and model switching; token budget coverage; UI drag/paste/select/remove/send/error tests. Run Rust tests remotely per AGENTS.md (CI when the designated SSH server is unavailable), never compile Rust on this Windows workstation.
