# Durable image and file attachments

This implements the portable attachment behavior of DeepSeek Harness, referenced
at upstream `c389f96bf3a9b6807cb71ed6bdad5849be0df6d8`, in the shared Rust host and
shared Web/desktop composer. It is not a separate Windows UI or a second agent.

## User behavior

- Drag files into the conversation, paste clipboard images, or use **添加附件**.
- Images have thumbnail/original previews; other formats have filename/size cards.
- Remove unwanted drafts before sending. Rejected sends retain all drafts.
- Historical images can be reopened; ordinary files can be downloaded. Retrieval
  uses the authenticated session attachment RPC and supports retries.
- In model settings, open a model's advanced settings and enable **支持图片输入**
  only when that exact model/API route accepts images. Existing models remain
  text-only until explicitly enabled. The setting is persisted as
  `inputModalities: ["text", "image"]` in provider profiles; the legacy native JSON
  config uses `input_modalities`.
- A capable model receives image bytes. A text-only model receives an explicit
  omission descriptor; the original attachment stays in the conversation. This
  does **not** automatically call another vision model or silently incur a second
  model call.
- Generic files are preserved byte-for-byte and exposed to tools at a verified
  read-only path retaining a safe extension. PDF/Office/archive attachment does
  not imply automatic document extraction: the agent needs a suitable available
  tool. SVG/HTML are downloadable files, not active inline previews.

## Storage and protocol

The native host uses `<state-dir>/attachments/v1`. SHA-256-addressed objects are
published atomically before a message/result can reference them. A read checks
the digest and size. Safe filename aliases are separate from immutable objects.
Session messages and tool-result metadata store typed refs, never image base64.
Request image caches are disposable and do not replace the durable originals.

Authorization uses typed references in durable session events, including old
history outside the bounded Web cache. Arbitrary tool arguments, request headers,
guessed IDs and client-provided local paths do not grant attachment access.
Generic attachments are projected into a stable per-session directory, including
new steering inputs and refs inherited by forks. Only that session directory is an
additional **read-only** filesystem/sandbox root; other sessions and the global
object store are not granted. This does not enlarge normal workspace write authority. OS read-only attributes
and hashes are not protection against a hostile administrator/same-user process.

PNG/JPEG/WebP/GIF are decoded with allocation/dimension limits and EXIF orientation,
then normalized (animated inputs become a static frame). Request variants are
bounded separately. `read_image` uses the existing filesystem permission seam,
checks the exact active route before reading, and produces durable image refs.

Chat Completions tool messages support text only, so tool images become a
request-local user-image envelope **after the complete tool-result batch**.
Responses uses image parts in `function_call_output`. Durable history is unchanged.
See the [Chat schema](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
and [function output guidance](https://developers.openai.com/api/docs/guides/function-calling).

## Deliberate compatibility limits

- Current inline JSON RPC: 128 attachments, 20 images, 20 MiB per image,
  32 MiB per generic file and 96 MiB combined per prompt. This is **not** the
  latest upstream's unbounded streaming generic-file upload transport.
- Images: maximum decoded dimension 8192, 64 million source pixels; normalized
  at most 4 million pixels/4 MiB; request variants at most 640,000 pixels/1 MiB,
  retaining the newest 20 images per request with explicit omissions for others.
- Portable inline provider images are implemented. DeepSeek-specific Files API
  uploads/cache optimization are not part of this implementation.
- Legacy text-only session JSON remains readable. Images whose bytes existed
  only in the previous process's memory cannot be recovered after that process
  has exited. Existing on-disk sessions/configuration are not rewritten.
- There is no automatic object garbage collection; retain the attachment folder
  together with the session store when backing up or migrating application data.

## Verification

Rust tests cover normalization, corrupt payload rejection, byte-exact generic
files, reopened storage, persisted refs, bounded-history authorization, cross-session
refusal, route projection, tool-image call ordering, and read-only file access.
`read_image` tests cover capability gating, actual image output, invalid bytes,
and cancellation without paid model calls.

`node scripts/test-attachments.mjs` exercises the shipped conversation controller
and actual wire schemas. `scripts/test-attachments-browser.mjs` mounts the shipped
React attachment components in an isolated fixture: mixed picker/drop, real image
decode/lightbox, removal, disabled input, history retry and narrow layout. CI runs
this with Chromium and WebKit. This component fixture is not an installer or a
live-provider end-to-end test.

Per repository policy, Rust compilation/testing runs remotely or in CI, never on
the local Windows development machine. No live user application is restarted by
these tests, and no real model credentials are used.
