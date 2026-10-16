# CI latency: preserve acceptance, remove repeated work

Baseline source: master `0ea0538851c1f2be625d16fc062271fe3e194074`.

| Hosted run | Observed elapsed time | Critical path |
| --- | ---: | --- |
| [PR CI 38326355241](https://github.com/123123213weqw/x-harness-rs/actions/runs/38326355241) | 16m22s | Windows Rust/native tests |
| [master CI 38324707873](https://github.com/123123213weqw/x-harness-rs/actions/runs/38324707873) | 23m33s | Windows native packaging and acceptance |
| [release 38326979759](https://github.com/123123213weqw/x-harness-rs/actions/runs/38326979759) | 36m39s, failed | Windows build; profile ownership guard failed |

## Changes

- Export native wire fixtures during the existing `cargo test --locked --workspace --all-targets`. Retain all strict TypeScript/schema consumers using the same fresh runner paths. This removes repeated filtered Cargo builds/test invocations, not test coverage. The serialized runtime-drop rerun remains: it intentionally tests a different concurrency condition.
- Save ordinary Rust CI caches only from trusted master pushes. PRs can still restore compatible base caches; they no longer upload large merge-ref caches that master cannot reuse. Release caches stay separate. Do not blindly retain all workspace binaries: existing native caches already consume substantial space and upload time.
- Set Windows release symbol/profile environment **before** rust-cache calculates its fingerprint. Include only public compile-time account/installation/channel configuration alongside the default compiler environment prefixes; never add private signing credentials to caches. Keep platform/toolchain/configuration isolation.
- Tune the existing four UI contract shards and four shards per browser using the complete successful per-test receipts from PR CI 38326355241. The committed baseline records the PR **merge SHA** `59a014cf1f037d8ba35142d1cd4f621893de89f1`, not its head SHA. Commands, browser/implementation variants, order within each shard, frozen occurrence coverage and same-run artifact verification remain unchanged.

Historical duration replay (test execution only, excluding setup, queueing and uploads):

| Lane | Previous slowest shard | Calibrated slowest shard |
| --- | ---: | ---: |
| UI contracts | 579s | 444s |
| Chromium | 497s | 349s |
| WebKit | 610s | 442s |

These numbers replay old measurements through the new schedule; they are **not** measured new-run speedups or a guarantee of overall elapsed time. Windows is still a separate critical path. First runs after changing cache fingerprints may be cold.

## Verification and future calibration

```sh
node --test scripts/test-ci-ui-suite.mjs scripts/test-ci-ui-timing.mjs
python3 -B scripts/test-ci-tiering.py
python3 -B scripts/test-ci-latency.py
node scripts/ci-ui-timing.mjs --check
actionlint .github/workflows/ci.yml .github/workflows/desktop-release.yml
```

After a complete successful hosted run, review its `dist/ci-ui-timings` receipts and replace the public timing baseline; `node scripts/ci-ui-timing.mjs --write` changes weights only. Failed, duplicate or incomplete rows are rejected. Changed/new argv or environment variants retain fallback weights instead of borrowing stale samples. CI uses the committed deterministic schedule, not live fetched timings. Rust validation remains remote-only.

## Deliberately unchanged

Exact-SHA green CI, signed packages, three Unix production updater rounds, Windows data-preservation acceptance, complete immutable aggregate and publication gates are not weakened. The coordinator is not a duplicate builder. Faster platform-local acceptance would require a separately reviewed evidence-binding design; this change does not invent a partial public feed or substitute acceptance of different bytes. The separate Windows profile-isolation fix (#279) is now in the master base; a subsequent real release must still pass native acceptance. Client download bandwidth and mirror delivery were not measured or modified here.
