# Automatic desktop candidates (prepare, never publish)

`master` push → latest exact-SHA `CI` succeeds → quiet/idle admission → `Desktop Candidate Prepare` →
reserve an immutable `desktop-vX.Y.Z` tag → existing `Desktop Release` **on that
tag**, with integrated acceptance → four protected signing/native workers →
complete private draft and receipts → stop at `awaiting_confirmation`.

Targets: Windows x64, Linux x64 AppImage, macOS arm64 and macOS x64. PR/fork runs,
failed/cancelled/skipped gates and obsolete CI attempts cannot prepare candidates.
A master CI cancelled by a newer commit has no green result, hence no candidate.

## Idle prebuilds and fast delivery

The CI-completion trigger is supplemented by a scheduled check at minutes 17 and
47 of each hour and a manual `Desktop Candidate Prepare` dispatch on master.
These are admission checks, not unconditional builds. GitHub may delay scheduled
runs; this is not an exact delivery-time guarantee.

Before installing the checkpoint SDK or reserving a version, the read-only
`scripts/desktop-candidate-idle.py` admission must establish:

1. The controller checkout still equals current master, with its latest exact-SHA
   successful push CI and **every** CI job successful. An older `workflow_run`
   event cannot select a different source or an older green attempt.
2. That CI has been completed for at least **10 minutes**. A burst of merges
   therefore converges on the latest green source instead of packaging each commit.
3. No CI/desktop release workflow is queued, requested, pending, waiting for
   approval, or running. Any other actively running workflow also takes priority.
   Unrelated queued housekeeping does not consume a runner and does not starve
   preparation. For example, a stalled Gitee mirror queue is not release load.
4. No earlier failed/uncertain controller for this same source could have entered
   the journaled preparation action. Exact-attempt step evidence can prove a
   controller was cancelled while pending or failed **before** preparation; those
   runs do not poison the source. Missing/ambiguous evidence fails closed. No
   failed or unaccepted immutable build can be hidden by allocating a replacement
   version automatically.
5. There is no already accepted immutable candidate. An existing candidate is
   authenticated through its small plan, exact CI attempt, four native workers
   and signing policy. A ready candidate produces its promotion-only command;
   no package is downloaded or rebuilt during admission. Changed/expired evidence
   requires inspection rather than a silent rebuild.

Current master, CI identity, and activity are checked again before admission.
The existing coordinator rechecks source/CI before its first allocation and
dispatch. After allocation, source/version remain pinned even when master moves.
The idle controller has a single non-cancelling concurrency group, separate from
the stable publication lock. This prevents duplicate planning/allocation across
scheduled, manual, and CI-completion triggers. It is **best-effort admission**,
not hosted-runner priority or preemption: newly arriving CI may overlap a prebuild
that has already started. Do not cancel uncertain allocation/dispatch intents.

Rerunning the **same coordinator** restores and validates its write-ahead journal
before idle/latest-master selection. It continues the original source, CI,
version and signing policy; missing journals, changed policy, or stale CI fail
closed. An idle/deferred run with no journal should not be rerun as a recovery;
use the next scheduled check or a fresh manual dispatch instead.

Small `desktop-candidate-idle` JSON evidence and the job summary distinguish
`quiet_period`, `waiting_for_ci`, `master_moved`, `superseded_trigger`,
`repository_busy`, `resume_existing_controller`, `inspect_existing_build`,
`candidate_evidence_changed`, `candidate_ready`, and `idle_green_master`.
None of these decisions publishes a release or restarts an installed app.

After packaging, explicit release confirmation reuses the **same signed bytes**
and native receipts through the existing promotion-only entry below. Delivery
then avoids the compilation/signing/native-test stage, but still freshly checks
the live channel, draft, signatures, provenance, CI, and upgrade base. A prebuild
is preparation, not a promise that later publication cannot become stale.

### Activation and read-only inspection

The old automatic workflow was manually disabled on October 15 after a Windows
acceptance failure. A workflow edit does **not** clear GitHub's server-side
disabled flag. Only after this change reaches master and its exact-source CI is
green, enable the corrected controller:

```sh
gh workflow enable desktop-candidates.yml --repo 123123213weqw/x-harness-rs
gh workflow run desktop-candidates.yml --ref master --repo 123123213weqw/x-harness-rs
```

The existing exact-repository `XHARNESS_FRIENDS_RELEASE_REPOSITORY` opt-in and
protected signing environments remain required. Disabling the workflow stops
future admission checks; do not cancel an in-flight journaled controller as a
substitute for recovery. No publication consent is implied by enabling prebuilds.

Inspect the live decision without enabling or dispatching anything:

```sh
python3 -B scripts/desktop-candidate-idle.py --inspect \
  --repo 123123213weqw/x-harness-rs --scope all-macos-preview
```

The controller never invokes `Desktop Promote`, publishes a release, changes the
public `latest.json` or website, or restarts installed apps. Draft assets are not
an update channel; users keep receiving the last **published** stable release.

## Source, version and recovery

- Controls come from trusted master. Authenticate CI through REST and verify the
  newly admitted source is current master. A restored journal may continue its
  pinned master ancestor. No PR artifacts, no substitution of current HEAD for
  an already allocated source, even when master advances while work is queued.
- Version = next patch after the highest canonical desktop/friends release or
  reserved desktop tag, including drafts/failed builds. Gaps are expected. Failed
  version numbers, drafts and tags are never reused/deleted/overwritten.
- Tag allocation and dispatch upload write-ahead checkpoints **before** POST.
  Lost replies reconcile the same intent by GET. Only a confirmed tag conflict
  can pick another version, within a bounded budget. An uncertain POST with no
  visible result stops for same-run recovery, never blind redispatch.
- Immutable tag dispatch makes checkout, workflow SHA, signed bytes, plan and
  receipts identify the same source. Only the build workflow allows this mode;
  tags must resolve to commits in master ancestry. All four native workers must
  pass; a successful aggregator alone is not acceptance.
- Global idle-controller and per-tag build locks are separate from the serialized
  stable publication lock. A controller rerun restores its run-bound journal
  before planning any new work.

### 2026-10-14：首个自动候选的 Run 可见性竞争

`0.2.46` 的精确源码 CI 已通过，但汇总 worker 启动时 GitHub REST 的整个 Run
仍是 `queued`，原先要求立即 `in_progress` 的门禁误拒绝了同一次构建。
失败 Run `38572902260` 和不可变标签保留，不覆盖、不推广；修复后分配新的版本。

同机物料交接现在只对这一暂态做最多 8 次、每次 15 秒的只读等待。每次都重新验证
仓库、Workflow、Run ID、源码、attempt、触发事件及不可变标签；只有看到
`in_progress` 且无 conclusion 才能继续，身份变动、终态、未知状态或等待耗尽立即失败。
这不改变发布门禁：推广仍要求整个 Run 及四平台签名与原生升级验收全部成功。
回归覆盖 queued→running、等待耗尽、每次读取身份/事件漂移及 queued/running 不能成为发布证据。

### 2026-10-15：Windows 文件占用恢复与可诊断性

`0.2.47` 的 Windows 安装后 Reconcile 在独占读写检查时报错，退出码为 3。
旧日志未保留初装/重装阶段和底层 HRESULT，不能认定是 Defender、Host 泄漏或句柄保留。
同源码 CI 安装包（不是失败版的原始字节）两次回放均通过；这些对照不能代替正式升级验收。

明确修复单次瞬时共享冲突就中止安装的缺陷：只有 Win32 32/33 的 IOException 可在
全文件集合共用的单调时钟 10 秒预算内等待。每次重验路径、重解析点和文件元数据；
文件变化、ACL/权限错误、其他 I/O 错误与持续占用仍失败。等待后重验进程，PID 复用
与新启动的进程不能利用等待窗口绕过原来的活进程门禁。不杀进程、不删除锁、不改文件内容。

安装验收保留分阶段退出码与失败堆栈，文件探测保留异常类型和 HRESULT。
失败 Windows worker 单独保留 3 天的 `desktop-windows-unaccepted-diagnostic`，只含安装器、
公开签名/计划/依赖审计，不含私钥与用户数据；该名称不满足候选或验收物料契约，不能推广。
旧失败 tag/Run 保持不变，修复后新建版本，四平台原生验收与唯一 Promote 门禁不变。

### 2026-10-15：独立聚合机的 Windows 运行时依赖

`0.2.48` 已通过 Windows 安装归属/崩溃回收（阶段退出码 `0 / 2 / 0`），
但 Linux 汇总机未 staging 固定版 PowerShell，独立 NSIS 审计在缺失运行时目录时中止。
聚合入口现在先从受信源码 lock 的固定供应商 ZIP staging 并验哈希，再审计收到的安装器；
不相信候选包自报的 manifest，不取消完整 vendor .NET/许可证/PE 校验。

同时固定生成的 runtime `manifest.json` 为 UTF-8/LF。此前 Windows 默认 CRLF 与 Linux
默认 LF 会产生不同摘要，即使内容相同也不能通过严格的跨平台验证。回归模拟 Windows
文本换行转换，要求字节一致；依赖 staging 或安装器审计任一失败都不能进入聚合。
失败版本保持不变，后续新版本仍须完整签名和原生升级验收。

### 2026-10-15: Process liveness is not product readiness

Candidate `0.2.49` passed independent aggregation and Windows installation ownership,
but its one-hop updater acceptance queried `session.list` while the new Host was
still restoring sessions. Captured status identified the new version and a live
process, but `startup.hostReadyMs` was null and the page was `/desktop/starting`;
the API correctly returned its temporary startup HTTP 503.

Native attachment now waits for a finite, non-negative `hostReadyMs` whenever the
installed version exposes startup telemetry, and rejects any startup error.
Legacy versions without that snapshot retain compatibility. Cache rehearsals still
require frontend hydration and the first frame as additional gates. No installer
relaunch, API error retry, delay increase, or data-preservation assertion bypass is
introduced. Regression tests replay restoring-to-ready snapshots in both modes.
The failed candidate remains immutable; a fresh version must pass full acceptance.

## Policy and retention

### 2026-10-15: Background update preparation in native acceptance

Candidate `0.2.50` passed aggregation but its Windows base app began downloading
the target before manual discovery. Captured requests show the real background
download; discovery kept calling `desktop_check_update` and eventually reported
the updater's busy guard. The old test also incorrectly required observing the
transient `available` phase and armed corruption only after discovery.

Acceptance now arms the corrupted response before launching the base app, follows
the production updater snapshot, and waits without issuing checks during
`checking`/`downloading`. Verified `downloaded` is a valid terminal preparation
state, not permission to skip install or retention checks. Corrupt rejection must
be a download error for the exact target with an intercepted corrupt request;
a verified corrupt payload, different candidate, or unexpected install fails
immediately. Only the deliberate corruption rejection permits one explicit retry.

Metadata discovery keeps its 90-second deadline. Once payload transfer begins,
the driver uses the existing production download's 30-minute bound instead of
misapplying the short discovery deadline. A bounded, rolling updater snapshot
log is retained for failures. No production updater setting, automatic-install
consent, signature policy, or release evidence requirement changes.

Reuse `XHARNESS_FRIENDS_RELEASE_REPOSITORY` and existing protected signing
environments. `XHARNESS_DESKTOP_TAG_RELEASE_SCOPE` selects `all-macos-preview`
(existing default, ad-hoc/unnotarized), `all-macos-selfsigned` (fixed protected
publisher), or `all` (Apple Developer ID/notarization required). Automatic mode
rejects `windows-linux`; missing credentials never silently drop platforms.

The controller has no updater/Apple private keys. Only existing protected signing
workers receive them. Automatic build artifacts/journals: **14 days**; manual
release artifacts: 90 days; small ready pointers: 30 days. Expired evidence is an
error, not authorization to rebuild or trust caches. Draft cleanup is not automatic.

## Publish an accepted candidate, without rebuilding

The successful controller summary gives the reserved version and **Desktop
Release build run id** (not the controller/CI id). Substitute those exact values:

```sh
python3 -B scripts/release.py VERSION --repo 123123213weqw/x-harness-rs \
  --candidate-run-id BUILD_RUN_ID --confirm-publish VERSION
```

This entry authenticates the successful build and immutable plan, adopts that
run, and dispatches **only Desktop Promote**. The same run supplies integrated
Unix/Windows evidence. No compilation, version changes, re-signing or second
Desktop Release. Resume the same version task after transport errors.
Without `--confirm-publish`, stop for confirmation. `--retry`, `--pipeline` and
`--hosted` cannot be mixed with this promotion-only entry.

The promoter freshly verifies latest CI, signatures, unchanged draft/bytes,
native receipts and live channel. Older source cannot roll code backwards just
because its reserved version is higher. If another publication changed the
Windows stable base since the one-hop test, select a freshly accepted candidate
against that base; there is **no hidden rebuild or acceptance bypass**.

Legacy new-build release remains available. For ready candidates, use the reuse
entry, not a second build with an already-reserved version.

## Validation

### Windows-first diagnostic replay

While automatic candidates are paused, manually dispatch `Windows installer process probe`
with `source_release_run_id`, `expected_source_sha`, and `expected_version` to replay
an existing signed Windows target. Leave `source_ci_run_id` empty. This path builds
no Rust and signs or publishes nothing. It verifies the exact immutable tag/run/
attempt, successful aggregation and producer safety steps, the complete signed
candidate, the current stable trust key, and the extracted Windows runtime before
executing the existing native upgrade driver on a disposable Windows runner.

Failed candidates are eligible only when their sole producer failure was Windows
upgrade acceptance. The original failure is
never erased or converted into successful release provenance. The updated harness
source and original package source are recorded separately. Evidence is uploaded
as `windows-upgrade-replay`, with `diagnosticOnly=true` and `releaseEligible=false`;
no formal `acceptance.json` is issued and Promote cannot consume this result.
The real signed download, corruption rejection, consent barrier, Host stop, native
installation/restart and unchanged session/config/key/workspace checks still run.
Automatic candidate preparation must be disabled at staging and reporting, and
the diagnostic never re-enables it, including after a successful replay.

The first real replay passed on 2026-10-15: signed stable `0.2.44` to the unchanged
signed `0.2.50` installer, [run 38709926712](https://github.com/123123213weqw/x-harness-rs/actions/runs/38709926712),
Windows native job 126 seconds including staging. The test observed background
`checking`, real corrupt rejection, and `downloaded` without ever requiring an
`available` snapshot. Exactly one corrupt package and one valid package were
requested. Confirmation, signature/runtime verification, native installation,
restart, product readiness, and unchanged journal/config/credential/workspace
fixtures passed. Script hashes and scope are recorded in
[`windows-upgrade-replay-20261015.json`](../evidence/windows-upgrade-replay-20261015.json).
This is diagnostic proof for those package bytes, not authorization to publish
the original failed candidate or skip a fresh release's formal acceptance.

```sh
python3 -B scripts/test-desktop-candidates.py
python3 -B scripts/test-desktop-candidate-idle.py
python3 -B scripts/test-release-orchestrator.py
python3 -B scripts/test-release-service.py
python3 -B scripts/test-desktop-release-build.py
python3 -B scripts/test-unified-desktop-release.py
node scripts/test-desktop-windows-acceptance.mjs
actionlint -shellcheck= -pyflakes= .github/workflows/desktop-candidates.yml \
  .github/workflows/desktop-release.yml .github/workflows/ci.yml
```

Offline cases cover authentication, source movement, version races, lost replies,
restore, preparation-only enforcement, tag provenance, four-platform gates,
signing policy, stale base rejection and promotion-only reuse. They do not replace
the first real four-platform signed candidate run after this feature reaches master.
