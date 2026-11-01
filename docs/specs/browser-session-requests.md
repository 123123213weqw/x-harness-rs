# Browser session requests

The optional `@xharness/native-browser` bridge exposes `request` and
`read_response`. This is a desktop-only HTTP adapter, not arbitrary JavaScript,
a system-browser cookie importer, or a replacement for normal browser actions.

## Ownership and login state

- Host freezes the actual session owner; model arguments cannot select an owner,
  tab, profile, cookie, authorization header, or script.
- Requests require the existing loaded, visible, delegated native tab. The target
  must have the exact same scheme, host and effective port as its current page.
- Session binding isolates tool access and cached results, not browser profiles.
  Tabs keep the existing shared login profile; this is not per-chat account isolation.
- GET/HEAD use its read grant. JSON POST/PUT/PATCH/DELETE additionally require its
  action grant. JSON bodies are bounded to 16 KiB; arbitrary headers are absent.
- Every request reads the current native cookie store, including HttpOnly cookies.
  There is no persistent cookie copy or login-state reference in Host/history.
- macOS uses the actual WKWebView's WKHTTPCookieStore completion on the UI thread.
  Raw NSHTTPCookie domain metadata is checked before normalization; Wry 0.55's
  `cookies_for_url` cannot distinguish the required path/subdomain cases there.
  Windows/WebKitGTK use their engine-filtered URL getter on a blocking worker.
  Neither path blocks an async worker/UI thread while waiting for a callback.
- Domain/host-only, path, Secure and expiration constraints apply. Request headers
  have a 16 KiB / 256-cookie limit. Only exact-host Set-Cookie updates are accepted;
  parent-domain expansion and Secure cookies from HTTP are rejected. Browser
  interactions remain necessary for sites requiring broader cookie updates.
- Redirects are returned, never followed. Credentials cannot follow a Location
  to another origin (including another port or a downgrade). No HTTP retries.
- Navigation, hide/close, owner changes or delegation revocation invalidate cached
  responses. Pending requests monitor scope changes and discard late delivery.
  Cancellation after sending does **not** mean a write was undone: unknown effects
  must be inspected, never blindly replayed. Native store work is separately bounded.

## Model-visible results

```json
{"url":"https://example.com/api/items","auth":"auto"}
```

A request returns status, a fixed normalized content type, `authentication:
"browser"`, `untrusted: true`, at most 4 KiB of UTF-8 text, an ephemeral
`result_ref`, total bytes and `next_offset`. HTTP errors are tool errors, with the
status preserved. No Cookie, Set-Cookie, Authorization, Location or raw response
headers are output. Errors do not echo URLs, queries or transport diagnostics.
Known cookie-value reflections (literal, JSON-escaped and URL-encoded), and
credential-shaped JSON fields, are redacted **before** caching or previewing.
This is defense in depth, not a claim that arbitrary server-side transformations
of secrets can be detected or that other existing browser tools redact page data.

```json
{"result_ref":"<opaque reference>","json_pointer":"/items/0/title"}
```

`read_response` reuses the sanitized body without HTTP. It supports an RFC 6901
JSON pointer or repeated UTF-8 byte-offset pages. It is not a consuming stream.
One response (up to 1 MiB) is retained in memory per tab; a new request replaces
it. References become unreadable after 120 seconds and are removed on the next
read or invalidation. No response file, cookie file, export endpoint or credential
value is added to the model context. Only requested preview/selected pages enter
normal tool history, subject to the existing context policy.

## Limits and verification

This is cookie-based HTTP, **not** in-page `fetch`: site-specific CSRF, IndexedDB,
localStorage, browser TLS identity, partitioned credentials and anti-bot challenges
are not reconstructed. Use existing observe/perform/input tools when a site
requires the real page environment; never bypass a denial or replay a write to
try a different transport automatically. Non-UTF-8 and >1 MiB responses fail explicitly instead of silently losing the tail.

The existing isolated `browser-inspect-probe` exercises a genuine native store,
HttpOnly fixture login, path scoping, forbidden owner/origin/headers, read-only
writes, redirect non-following, a single failed write, bounded/repeatable field
reads, session-switch invalidation, cookie rotation/logout and hide-during-request.
It starts no model/Host and uses no production profile or paid API. Unit tests
also cover cookie matching, expiration, redaction, UTF-8 paging and cache expiry.
Playwright tests cover the existing activity UI only, not native cookie semantics.
