# XHarness mobile relay (experimental)

The relay serves `ui/mobile` and forwards **only** the closed
`xharness_mobile::protocol::MobileAction` vocabulary. It is not a Host, Agent,
workspace filesystem, desktop RPC gateway, model proxy or credential store.
Every device request is authenticated and authorized again by the connected
Host. No operation is retried by this relay.

## Configuration

Private registered-Host file (`0600`, not a symlink):

```json
{"hosts":{"HOST_ID":{"key_sha256":"LOWERCASE_64_HEX_SHA256_OF_HOST_KEY"}}}
```

The file contains only key digests. The plaintext Host key remains in the
Host's private configuration. Do not place it in a URL, shell argument,
frontend file, service log or the registered-Host file.

For the V100_222 experiment, install the remotely built binary and frontend in
a dedicated user-owned directory. This does not require sudo, alter existing
port 80/443 services or expose the desktop admin API.

```sh
xharness-relay \
  --bind 127.0.0.1:31368 \
  --static-dir /absolute/private-install/ui/mobile \
  --hosts-file /absolute/private-config/hosts.json \
  --public-origin http://127.0.0.1:31368 \
  --allow-loopback-http
```

Use an SSH local forward to reach the experiment at exactly that origin.
Without the explicit loopback flag the public origin must be HTTPS. Even with
that flag, both the HTTP origin and bind address must be loopback. A public
installation should retain a loopback bind behind a HTTPS/WebSocket reverse
proxy, change `--public-origin` to its **exact origin without trailing slash**,
and use a `wss://` Host endpoint. No TLS termination or public port configuration
is performed by this binary.

Suggested user service (substitute actual absolute paths):

```ini
[Unit]
Description=XHarness experimental mobile relay
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/private-install
ExecStart=/absolute/private-install/bin/xharness-relay --bind 127.0.0.1:31368 --static-dir /absolute/private-install/ui/mobile --hosts-file /absolute/private-config/hosts.json --public-origin http://127.0.0.1:31368 --allow-loopback-http
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
TimeoutStopSec=15

[Install]
WantedBy=default.target
```

Do not enable login linger or change system services implicitly. User-service
availability and login lifetime are deployment concerns to verify separately.
SIGTERM/SIGINT initiates a drain: owner sockets are fenced, waiting HTTP
requests resolve as offline, and connections close with a bounded send timeout.

## Connect an experimental native Host

The existing `xharness-host` executable owns execution, sessions, files and
approvals. Enable the connector in that process's private launch environment:

| Variable | Purpose |
| --- | --- |
| `XHARNESS_REMOTE_CONTROL=enabled` | Opt into the existing scoped gateway. |
| `XHARNESS_MOBILE_RELAY_URL` | Public `wss://` Host ingress; no credentials, query or fragment. |
| `XHARNESS_MOBILE_HOST_KEY` | Separate random Host registration secret, not a model API key or pairing code. |
| `XHARNESS_MOBILE_PUBLIC_URL` | HTTPS mobile page URL used to generate pairing QR codes. |

The trusted gateway derives the Host ID from the canonical state-directory
path. Add that ID and the SHA-256 digest of its registration secret to the
relay's private registry before connecting. The relay loads this registry at
startup; adding a Host currently requires an owned relay restart. Do not
replace another Host's registry entry or reuse its key.

Use the normal private desktop UI's remote-control settings to choose an
existing workspace/session and generate a short-lived, single-use pairing QR.
The QR carries only the Host ID and pairing code in a URL fragment, never a
model key, registration key or desktop bootstrap token. A phone's permissions
are independent of another Host's pairing, and the first pairing form does not
grant permission to create sessions. Model configuration stays with the Host.

Pending approvals/questions are available through `Review (n)` in the mobile
navigation, independently of the chat-history scroll position. A review dialog
can close without answering. Approving still requires the user's explicit
once-only decision; neither opening the dialog nor losing the connection is
an approval. Reload the browser page after frontend changes.

The validated Mac experiment used a **separate isolated test Host**, not the
installed desktop app's existing sessions. Existing-app integration and saved
startup configuration remain unfinished. The Mac must stay awake and online;
the relay cannot execute Mac work while its Host is disconnected. Keep the
native desktop listener loopback-only and never expose desktop management RPCs
through the public mobile ingress.

`XHARNESS_MOBILE_ALLOW_LOOPBACK=enabled` is only a disposable development escape
hatch for a loopback `ws://` endpoint. It does not permit cleartext LAN/public
WebSockets and must not replace WSS in a public deployment.

## Wire boundary

- `GET /healthz`: process readiness and aggregate `connected_hosts` count of
  authenticated, Ready-sent owners only. No Host IDs, devices, secrets or model
  metadata are returned. It never implies a configured model or usable account;
  the public experiment ingress does not expose this deployment health route.
- `GET /api/mobile/host`: non-browser WebSocket, first message must be
  `HostFrame::Hello` within 8 seconds. Authentication compares a SHA-256 digest.
- `POST /api/mobile/pair`: `{host,code,name}`. Pair code is consumed at the Host.
  The exact `PairedDevice` response is checked against that Host. The device
  secret is returned only in a `HttpOnly; SameSite=Strict; Path=/` cookie, never
  in the HTTP JSON result. Public HTTPS cookies are `Secure` and `__Host-` scoped.
- `POST /api/mobile/action`: **only** a `MobileAction`. Host/device/secret are
  extracted from the cookie, not from browser-supplied action fields.
- `POST /api/mobile/logout`: clears the cookie; revoke a device at the Host to
  invalidate previously issued bearer credentials.
- Other `/api/**` paths return errors rather than a frontend SPA fallback.

All POSTs require exact configured `Origin` and `application/json`. Browser
Origins on the Host WebSocket are rejected. The relay does not trust forwarded
IP headers; a local reverse proxy shares an aggregate peer rate budget until
an explicitly trusted-proxy mechanism is implemented. HTTP/static responses
are `no-store`, with restrictive CSP and no framing. There is no CORS wildcard.

Limits: 8 MiB frames/body, 32 pending requests per Host, 30-second response
wait, 5-second socket send, 20-second heartbeat and 60-second incoming idle
fence; per-peer pair/action/connection rate limits have a bounded peer table.
A newly authenticated Host connection replaces and cancels its previous
owner. Late responses cannot resolve replacement-owner requests. Request
cancellation/timeouts remove waiters and **never** replay a mutation. An
ambiguous receipt must be reconciled using the original request ID at the Host.

The loopback fixture uses HTTP only for experimentation. It is not a public
mobile deployment or an acceptance of real personal-WeChat integration.

## Tests

Remote-only Rust compilation policy applies. Unit and mock WebSocket/HTTP tests
exercise exact origins, private registry files, cookie secrecy, Secure cookie
attributes, closed action decoding, unavailable Host errors, duplicate owner
fencing, pending limits, cancellation cleanup, disconnects and normal drains.
