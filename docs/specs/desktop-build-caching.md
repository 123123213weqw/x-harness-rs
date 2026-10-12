# Desktop build caching and diagnostic benchmarks

## Scope

Reduce repeated native compilation and cache compression, not release validation.
The 0.2.51 baseline needed 2,772 seconds to prepare a four-platform candidate;
promotion of those immutable bytes needed only 94 seconds. Windows and Intel Mac
both reported `No cache found`. See the linked run identities and step timings in
`docs/evidence/desktop-build-cache-20261015.json`.

## Production changes

- Pin Rust to **1.99.0**, the compiler already used by the accepted 0.2.51 build.
  Ordinary workflow setup and `rust-toolchain.toml` agree. The existing explicit
  historical compiler experiment keeps its separate compiler selection.
- Preserve the native release cache namespace, target, compiler/configuration
  fingerprints and Windows release symbol settings. Do not combine incompatible
  inferred-host/explicit-target or debug/release artifacts to manufacture a hit.
- Use **zstd level 1** for CI/release cache compression. This changes the cache
  archive tradeoff only; no optimizer settings, binary stripping or PDB retention
  change. A larger archive is possible; the benchmark must include cache post-job
  time, not just report faster compilation as a total pipeline speedup.
- Keep **workspace-crate caching disabled in production**. The opt-in benchmark
  compares it independently; there is no assumption that retaining more files is
  beneficial on fresh checkouts.
- Cache portable ripgrep independently of project source/lockfile churn. Keys bind
  OS, architecture, the compiler pin, Cargo configuration and installer/verifier
  source. Only successful master jobs save production search caches; PRs restore
  but never write them. The binary is still built with a pinned version, locked
  dependencies and `--no-default-features` (no dynamic Homebrew/PCRE2 dependency).
- Before executing a restored `rg`, verify its bounded receipt, build identity,
  binary hash and Mach-O architecture. Then verify its version with a timeout.
  Missing, corrupt or incompatible caches rebuild; symlink roots fail without
  deleting their targets. A receipt detects corruption, **not cryptographic
  authenticity**; trust still comes from the controlled master cache producer.

Cache misses remain correct builds, not release failures. Compiler versions,
profiles and output bytes are never silently substituted to obtain cache hits.

## Same-source experiment

Before this workflow is merged, the existing **GUI Acceptance Candidate** manual
entry accepts `build_cache_benchmark=true` and
`workspace_cache_experiment=true` on the reviewed branch. It calls the new
reusable benchmark workflows and skips the unrelated GUI build jobs for that
manual invocation. Its normal pull-request/native-observation behavior remains.

1. Populate independent Windows and Intel Mac dependency caches. Also populate
   an Intel Mac workspace-cache variant when explicitly requested.
2. On **fresh hosted runners**, check out the **same exact source SHA** and restore
   each variant. Use the same toolchain, target, lockfiles and public profile flags.
3. Measure Host release compilation, sidecar staging, all-target desktop tests,
   Clippy with warnings denied, and desktop release compilation. Stage pinned
   PowerShell/ripgrep on Windows as usual.
4. Upload a small `metrics.json` even when a compilation step fails. It records
   source/run/attempt, compiler, lockfile hashes, cache-hit output, configuration,
   elapsed times and exit codes. Full command output remains in GitHub job logs.
5. Compare matching variants only. Include GitHub job setup, cache restoration and
   post-job cache save time separately; parallel job durations are not additive.

The benchmark has read-only repository permission, no inherited secrets, no
version allocation, bundling, installer execution or release mutations. Its cache
namespace and branch scope are separate from production. Every report explicitly
sets `diagnosticOnly=true` and `releaseEligible=false`; it emits no acceptance or
candidate artifact and cannot replace native upgrade acceptance. These timings
measure **compilation**, not end-to-end publication or an actual signed upgrade.

## Regression and rollout

`python3 -B scripts/test-desktop-build-cache.py` runs without Rust compilation or
network. It covers corruption-before-execution, architecture/compiler/flag drift,
version/PCRE2/timeouts, safe rebuilds, symlink refusal, trust scopes, unchanged
release checks, pinned workflow compilers and benchmark isolation. It is enrolled
in the architecture check and native Windows CI.

Existing native tests, signing, complete manifest/receipt verification, three Unix
upgrade rounds, real Windows upgrade/data preservation and independent Promote
remain unchanged. Automatic candidate preparation remains paused. No new release
is created by implementing or running this experiment. Report measured warm
results before changing the production workspace-cache policy.

## Measured result (2026-10-15 UTC)

The corrected experiment used source `2e0e72ffe56d6e25c2a9e8e085e0218fe063ce93`
on fresh hosted runners. All six reports passed the source, compiler, lock/config,
cache-hit and zero-exit checks. Warm samples restored the exact populated cache.

| Compilation variant | Populate | Warm |
| --- | ---: | ---: |
| Windows dependency-only | 1,503.735 s | 783.844 s |
| Intel Mac dependency-only | 1,707.427 s | 605.899 s |
| Intel Mac workspace retention | 1,594.906 s | 658.314 s |

**Keep production dependency-only.** Workspace retention was not faster in this
sample and its cache post-job step took 305 s versus 114 s for dependency-only.
This is one sample per variant, not statistical proof of a universal performance
ordering. Cache/post-job timings are observational, not a compression-only A/B.
Portable ripgrep's verified cache reuse also ran successfully on fresh Mac runners.

The first scratch run exposed missing Windows sandbox-runner staging in the
benchmark, now fixed and regression-tested. The corrected run's workspace warm
job hit npm's `Exit handler never called` before Rust started; only that job was
retried once on unchanged source. The first five successful reports remain from
attempt 1; workspace warm is from attempt 2. Failed logs/attempts are retained and
excluded from performance claims. The evidence JSON binds each report hash and
tested implementation-file hash to the exact remote run.

These improvements do not establish a new four-platform release duration. The
public 0.2.51 packages and all production acceptance requirements are unchanged.
