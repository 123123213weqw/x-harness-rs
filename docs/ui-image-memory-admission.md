# Conservative UI image / code admission

This is a resource-admission change, **not** a diagnosis of the installed Mac's
long-running footprint and not proof of a WebKit leak fix. Synthetic Linux
stress samples are capacity tests, not evidence that a user's chat rendered
those resources.

## Historical image thumbnails

- `session.attachment` accepts optional `thumbnail: true`. Authorization still
  uses the requesting session's real history (including authorized forks).
  Without the flag, the original response/bytes remain unchanged.
- The derivative is generated in the Host with the existing pinned image
  dependency, never by decoding full-size images in the WebView. The longest
  edge is 480 pixels (240 CSS pixels at 2×); small images are not upscaled.
  PNG output preserves alpha. Original bytes, references, model context,
  uploads, downloads, and edit/fork reuse are not replaced by the derivative.
- The first implementation handles static PNG and JPEG. JPEG orientation is
  applied, and bounded RGB ICC profiles are propagated. Animated GIF/WebP/APNG,
  non-RGB/oversized profiles and PNG gamma/chromaticity/HDR/EXIF metadata that
  cannot be faithfully round-tripped use an explicit original-open placeholder.
  They are not silently converted to a frozen/miscolored poster.
- One blocking thumbnail decoder runs at a time. Its permit follows the native
  work even if its RPC future is dropped. Busy work fails visibly rather than
  entering an unlimited native queue. Existing 20 MiB encoded / 16-megapixel
  source limits remain, decoder allocation limit is 128 MiB, output is at most
  1 MiB. There is no persistent server thumbnail cache or background scan.
- The client validates the optional response marker, encoded length, PNG header
  and dimensions **before** creating an image URL. An old Host that ignores the
  flag must not cause an original to be mounted as a “thumbnail”. Original-open
  and retry remain available. This intentionally does not silently fall back
  to loading the original in every tile.
- Thumbnail and original URL-cache keys are distinct and include the session.
  Both follow the existing session generation/disposal fence. A gallery uses
  only derivatives; an original is requested/mounted only after a click.

## Historical image admission budget

The platform has one **128 MiB estimated decoded RGBA ledger**, shared
by historical galleries/dialogs, workspace raster previews and local Markdown images. A thumbnail
conservatively reserves `480 × 480 × 4`; an original reserves its admitted
`width × height × 4`. Pending work reserves before loading. Invalid dimensions
or concurrent overcommit are refused before the read starts, with a visible
retry path; an existing visible image is not evicted to admit another one.
Closing/unmounting returns a lease exactly once. A late completion cannot reopen
a closed dialog. Image reads are serial, with at most 128 queued jobs; explicit originals and visible workspace reads take priority over queued gallery thumbnails;
unmounted queued requests are removed. StrictMode replay is covered.
Thumbnail and original **image** RPC reads have a 20-second deadline so a stalled read
cannot occupy the shared serial queue forever. Durable file downloads and other
non-image attachment reads retain their previous timeout policy. Transport failure remains visible
and retryable; queued cancellation does not pretend to stop native work already running.
Thumbnails additionally have a **48 MiB sub-limit within that same 128 MiB**,
leaving enough room to open one admitted 16-megapixel original even when the
gallery sub-limit is full. A refused tile retains its original-open button.

This is **not an application-wide physical-memory ceiling**. Drafts, PDF viewers and embedded browsers retain their separate existing
policies. Cached workspace URLs stay charged until close/LRU eviction; pressure
from other consumers evicts inactive raster entries before refusing a visible original. Decoder scratch space, extra animation frames, color conversion,
GPU surfaces and WebKit's resource/allocator caches are outside RGBA accounting.
Original URLs still obey the existing rendered-session cache lifetime; closing
a dialog is not evidence that its native backing store has been freed.

In particular, removing an image node, revoking a Blob URL, reaching zero tracked
references or reporting zero `Memory.images` is only lifecycle/accounting
evidence. Linux experiments observed high native residency after those counts
fell to zero; two equal reload/release cycles reused rather than doubled that
high-water mark. That does not establish a permanently growing leak or the
same behavior on macOS. No forced GC, cache purge, navigation or process restart
is introduced as a product “fix”. The prior static-file suspension remains a
separate behavior whose native-memory benefit requires a representative soak.

## Oversized code

Both HTML and line-token highlighter entrypoints refuse source exceeding any
of: **64 Ki UTF-16 code units, 1,000 lines, or 4,096 code units on one line**.
Admission happens before grammar imports or tokenization, including after a
grammar is already warm and while a source grows during streaming.

Callers use their existing complete plain-text fallback: no source truncation,
no per-token span expansion, and the existing copy/export semantics remain.
Small code still highlights normally. This deliberately does not add a risky
“highlight anyway” override or complex line virtualization, nor claim to bound
all large-text layout/native allocations.

## Acceptance and remaining release checks

Existing CI entrypoints cover the changes, without dropping baseline checks:

- Attachment source tests: safe arithmetic, concurrent reservations, idempotent
  release, serial/cancelled/failed work and exact existing styles/slots.
- Attachment Chromium/WebKit: real thumbnail intrinsic dimensions, no automatic
  original reads, original open/Escape, budget refusal before another read,
  return/retry, unsupported/old-Host fallback, StrictMode and late completion.
- Actual Session / conversation tests: old-Host rejection before Base64 decode,
  mismatched PNG dimensions, original compatibility, separate cache variants,
  and pending session-generation invalidation.
- Rust attachment / Host tests: aspect ratio, alpha, no upscaling, orientation,
  ICC propagation, malformed/animated inputs, busy decoder, original-byte
  preservation, inherited references and cross-session denial.
- Highlighter tests and real CodeBlock Chromium/WebKit: exact guard boundaries,
  no grammar work on refusal, complete 16,000-line plain source, no token spans,
  return to normal highlighting and unchanged frozen small-code pixel oracles.

Native Windows/macOS CI and representative long-running physical-footprint
validation are still release requirements, not replaced by the above tests.
Nothing in this change installs/restarts the running App or Host.

## Workspace adaptive fit and retained URLs

- `display/image-preview` is additive. The original session/permission/path read
  runs first, including remote-OS relative resolution. It never writes files,
  attachments, journals or model context. `display/read` stays unchanged.
- Fit targets are panel CSS dimensions times actual DPR, bounded to 4096 pixels
  per edge / 4 megapixels. Larger physical displays use explicit original bytes
  instead of silently reducing visual density. Small images are never upscaled.
  Changing panel size or DPR debounces a new derivative; the prior frame remains
  visible while loading. Portrait CSS geometry uses logical panel dimensions,
  not derivative pixel dimensions, so Retina height-limited fits do not blur.
  Small originals keep their intrinsic CSS size. Explicit zoom requests the
  original, not an upscaled fit.
- The derivative carries oriented source dimensions and a content-derived source
  ID. Zoom/resize requests bind that ID: an externally changed file requires
  Refresh rather than silently combining different snapshots. PNG output uses
  the existing bounded area resampler, applies JPEG orientation and propagates
  bounded RGB ICC. Unsupported animation/color/HDR metadata stays explicit-original.
- A shared URL pool retains at most 12 entries / 32 MiB encoded bytes, also
  subject to the common decoded budget. Hide/show reuses a bounded snapshot URL;
  hidden static image DOM is removed, but its retained URL stays charged. LRU
  evicts only inactive entries. Closing/refreshing the owner revokes all its URLs.
  Animated/unknown original viewers keep their mounted identity on hide to avoid
  resetting playback; their budget stays charged. No native RSS cap is claimed.
- Local Markdown static image DOM also suspends while hidden; a placeholder uses
  the browser-decoded dimensions (including EXIF orientation), not raw file-header
  dimensions. Animated/unknown decoders retain DOM identity. Compressed snapshots
  and charged URLs can be reused offline.
- Native PDF reading position is opaque. Automatic hidden PDF teardown is NOT
  enabled: explicit Pause removes the iframe and warns that Resume can reset its
  reading position. This is lifecycle behavior, not measured immediate RAM return.
- The measured Gaussian-blur shadow is removed only from QuestionComposer's
  question card. Borders/background/theme, keyboard/IME and answer behavior stay.

## Acceptance

The new tests are registered in `scripts/ci/ui-plan.json`, with no dependency,
lockfile, runner-image or CI-version updates. Native Rust tests run only remotely.
Include DPR/resize, zoom/fit, content changes, unsupported/old Hosts, late RPCs,
StrictMode, queued cancellation/priority, hidden/closed tabs, inactive-cache pressure,
Markdown scroll/layout and animated/PDF identity in acceptance. Native memory
benefit needs long process-level curves, not reference counts alone. Linux WebKit
results do not attribute the installed Mac's graphics ledger.
