# Code Review P0: evidence-linked review and same-page model interaction

## Scope and actual progress

User requested all four P0 features: inline review discussions, CI failure detail,
same-page model interaction and structured AI findings. This is not an automatic
merge/repair rollout. Existing read-only GitHub RPC, account/head fences and
owned ModuleLoader/Host composition remain the integration boundary.

Implemented in the feature branch (not merged or released):
- [x] Read/paginate actual threads/replies, resolution/outdated state and code jump.
- [x] Read Actions run attempts/jobs/steps and bounded on-demand logs.
- [x] Same-page configured-model selection, read-only review/question streaming,
  cancellation and visible failed/incomplete output. Uses auxiliary provider,
  not another session/Agent loop; questions are independent PR-scoped requests.
- [x] Atomic initial/final review receipts, history, typed structured findings,
  SHA/account fences, exact quote validation, stale and coverage handling.
- [x] Controlled TS tests and Chromium/WebKit interaction tests.
- [x] Final isolated V100 Rust regression: 211 Host tests, 66 native-app tests,
  1 actual HTTP review-endpoint regression; 6 pre-existing ignored tests.
  Clippy for Host/native-app/server all targets passes with -D warnings.
- [x] Opt-in public GitHub / configured-key DeepSeek fixture: actual jobs/log,
  normal question, valid empty structured report, invalid JSON failure, pre-output
  cancellation and restart history. Production-route/OS acceptance remains below.
- [ ] CI green on Linux/macOS/Windows, review and merge.

Real HTTP acceptance found that three-segment `github/review/*` paths returned
405 despite controlled RPC doubles passing. Endpoints were flattened to
`github/review-*` to preserve the frozen transport. A server transport regression
now checks every review operation through the actual HTTP router. This demonstrates
why fixture success is not a substitute for live integration acceptance.

## Data and authority

ReviewRun belongs to a verified account, full repository identity, PR number,
head SHA, run id (containing creation time) and chosen model.
Host owns this metadata and status: running/completed/failed/cancelled. No separate
chat session/turn is created for this read-only auxiliary generation.
Staleness is a projection comparing the bound head with the latest verified head,
not a model assertion. Findings from a previous account/PR are never visible in
another scope. Keep previous runs as history, not active verdicts.

Model output: complete JSON `{version:1, findings:[...]}`. A finding has:
`priority` (0..3), `title`, `explanation`, `path`, `side` (left/right), `startLine`,
`endLine`, `evidence` (exact contiguous code without diff +/- markers).
No model-created credential, commit metadata, confirmation status or severity
confidence percentage is authority. Local finding IDs are assigned by the
consumer; persistent IDs must be assigned by the Host run owner.

Pipeline:
1. Verify target/account and capture an immutable, explicitly bounded evidence
   snapshot at that SHA. Load required missing context by read-only operations;
   record exactly what is supplied and omitted. Do not interpret an old cached
   summary as current authoritative code/checks.
2. Reuse configured model transport/session handling; deliver review instructions
   separately from untrusted diff, PR description, comments and logs. No
   repository mutation capability is required for P0. Do not create another
   general Agent loop or let the UI hold provider credentials.
3. Receive full response through the existing streaming transport. Partial JSON
   is draft text only. Validate after actual successful turn completion; network
   interruption, invalid JSON or cancellation is not a finished empty report.
4. Validate fields, find exact file/hunk/side/line range and exact quoted evidence.
   Reject invented or unavailable coordinates and quotes. Preserve valid findings
   but expose rejected count/reasons. Do not silently turn all-rejected into clean.
5. Display as **AI finding / needs confirmation**, not verified bug. Human
   confirmation or independent reproduction is a separate subsequent fact.
6. Compare verified head again before install. Changed head makes this run stale;
   old tasks may finish for their historical snapshot but cannot replace a newer
   report. Cancellation/generation fences prevent late replies crossing scope.

The parser receives the immutable patch set captured by the Host and sent to the
model. The Host loads remaining file pages rather than silently reviewing only
the first page; over-bound inputs fail before sending, not silently trim. JSON size/count/range limits are input-validation/resource
bounds, not model context capacity or token-budget definitions. Model budgeting
must reuse the existing provider-capability/context service.

## Coverage and conclusions

An empty valid finding list means "no issue found in the supplied scope", never
"CI green", "safe to merge" or "all code reviewed". Distinguish incomplete file
pagination, unavailable binary/large patches, omitted prompt context, unavailable
logs and missing full-file context. Evidence linkage proves the quote/location
exists, not that the explanation is true. Do not score fabricated confidence.

## UI in one page

Keep repository/PR list on the left. Center tabs: Summary / Changes / Review.
Right metadata: Checks and discussions. Bottom composer: selected model and
"Ask about this PR". Findings show P0..P3, concise title, why/consequence,
path:line and jump-to-diff action. Generated raw JSON is not the default UI.
Show reviewer model/head SHA/run state in the results header. Do not fill the
empty state with fake examples, invented test results or a passing badge.

Diff parser provides old/new line numbers. Renamed paths, removed files, invalid
or truncated hunks and comments outside current hunks require explicit handling;
never map an old comment onto an unrelated current line by index. Source jumps
open the actual file/hunk and scroll to its current evidence line. Outdated
comments remain available as historical discussions.

## GitHub integration constraints

REST PR review comments expose positions/replies, but resolved discussion state
must come from GraphQL review threads rather than being guessed from missing
REST fields. Add this through the pinned credential/session seam, with separate
bounded pagination for threads and each thread's comments.

Actions job log downloads return a redirect. Current production JSON reader
intentionally refuses redirects, so do not globally enable follow-redirects.
Implement a dedicated bounded text-download reader: request the fixed GitHub
route, validate the download destination, omit GitHub Authorization on that
second host, reject private/link-local destinations and additional uncontrolled
redirects, and enforce cancellation/time/size limits. Never return signed download
URLs or credentials to the browser. Verify run/job belongs to the selected repo
and exact head SHA; distinguish PR merge-test commit when GitHub runs against it.
Permission failures and expired/removed logs remain visible; no fake log content.

Official references:
- https://docs.github.com/en/rest/actions/workflow-jobs
- https://docs.github.com/en/rest/pulls/comments
- https://docs.github.com/en/graphql/reference/objects#pullrequest

## Acceptance gates

- Exact SHA fixtures for an actionable bug, clean bounded scope and missing context.
- Bad fields, invented path, wrong side/range/quote, duplicates and malformed JSON.
- Empty response, streamed interruption and all-rejected output cannot become pass.
- User cancellation, rapid account/PR switch, new commit mid-review and stale late result.
- Inline thread pagination/replies/resolution, outdated positions and unavailable diff.
- CI in progress, failure, rerun/attempt changes, non-Actions checks, denied/expired logs.
- Structured review stays PR-scoped; discussion uses the global assistant through an explicit reference, not a per-PR chat binding.
- Real GitHub + real configured-model evidence, not fixture installation/self-rating.

No local Rust compilation. Sync source (excluding secrets/build trees) to
WZU_Server for all Rust checks/tests. UI-only pure tests can run locally.

## Verification record (2026-10-04)

Owned UI build/check: 54 modules, 165 assets. 87 focused JS/TS/type-policy
tests pass. Chromium and WebKit both pass real compiled-component interaction
for discussions/replies, diff jumps, jobs/steps/logs, model review/question,
stream failure and stale SHA. Repository/author filter regressions also pass
in both engines. Controlled tests are not paid-model or production OS acceptance.

Live GitHub RPC returned actual PR #213/#217 threads (empty), two current-head
workflow records and eight jobs for #217, run 37183238998 attempt 1. The first
full log return over SSH timed out despite the local download returning 200;
that attempt is not complete log acceptance. The fixture exercises actual Host
and native service routing, but signed-log HTTP on the acceptance workstation is
handled by the relay; production native redirect validation has controlled tests,
not direct production-credential live acceptance.

The first paid DeepSeek Flash review returned invalid JSON (unescaped embedded
quotes), and the Host correctly persisted a failed run and its raw output/usage;
it did not display a passing or empty review. Reported usage: 21,527 input tokens,
762 output tokens. This is a verified negative-path acceptance, not a successful
structured review or independent bug confirmation. Account billing/currency cost
has not been verified. A distinct manually initiated follow-up completed a normal question and a valid
empty structured review; neither is an independent quality endorsement.

The acceptance reuses the locally configured DeepSeek credential/model through
an OpenAI-compatible, thinking-off fixture. It does not establish fidelity with
the installed application's default Anthropic-format/xhigh route. GitHub and
provider secrets remain on the workstation, never in the fixture artifacts.
Artifacts are retained outside the repository under the dedicated
`xharness-github-native-preview/p0-acceptance` directory. No installed app
replacement, PR push, merge or release occurred in this implementation turn.

### Live acceptance matrix

All model calls below were explicitly initiated tests, not automatic paid retry.

| Scenario | Observed evidence | Status / limits |
| --- | --- | --- |
| Public GitHub discussions | #213/#217 returned an actual empty thread list | Empty-state read passed; populated/resolved/nested threads remain controlled fixtures |
| CI runs/jobs | Two runs; eight jobs at run 37183238998 attempt 1 | Real read passed |
| CI failure log | Job 111379843268 returned 495,430 characters, not truncated | Remote loopback RPC passed; earlier local-forward return timed out; native signed-download adapter itself remains controlled-test coverage |
| DeepSeek question | Completed, 531 characters; described the supplied assistant visibility diff without claiming test execution | Normal return passed; reported input 21,472 / output 208 |
| DeepSeek second review | Completed `{version:1,findings:[]}`; owned decoder accepted 10/10 supplied patches, no rejected findings | Valid empty report passed, not approval or known-bug detection; reported input 21,060 / output 10 / cache read 512 |
| Invalid first review | Invalid JSON persisted as failed with raw output and reported usage | Failure is not a clean result |
| Cancellation | Question entered cancelled before any visible output, zero characters, no usage receipt | Pre-output cancellation passed; actual mid-output cancellation and billing are unverified |
| Isolated Host restart | Four receipts restored: failed review, completed question, completed review, cancelled question | Passed on the final rebuilt example; no production app restart |

Full output, original negative receipt, exact snapshots, final structured decoder
result, downloaded log and restart record remain in the external acceptance
artifact directory. Do not publish raw credentials or private chat logs. The
installed default protocol/effort, live populated thread pagination, a paid
known-defect positive finding, real mid-stream interruption and packaged
Linux/macOS/Windows behavior are not established by this fixture. Cross-platform
CI remains a release gate. Observed 44.14/46.90 second end-to-end model tests
include repeated GitHub evidence reads and SSH fixture transport; they are not
pure inference latency or a production performance benchmark.

Worker regression also covers panics from provider generation, final head reader
and final receipt store; each becomes a visible terminal failure and releases its
running slot instead of leaving an indefinitely Running review. Initial/final
persistence errors are not presented as a successful durable report.

Remote source and Cargo target directories are isolated per feature. Sharing the
root Cargo target with another chat produced inconsistent dependency metadata
(`ScheduleRecord`/`ScheduleChange` from a different branch); a clean isolated
target removed that interference and the complete tested set passed. Do not
"fix" a feature branch's source to match another branch's cached rmeta.

## Visual verification

Actual compiled-component screenshots with explicitly controlled demo data were
inspected. Preview exposed an inherited broad `pre span` rule making nested diff
line numbers wrap onto separate rows. Narrowed the rule to direct diff rows;
Chromium/WebKit regression now asserts inline line-number layout. Review buttons
use the feature's existing theme/border system rather than browser-default chrome.
Owned UI build/check and all 87 focused tests pass after this CSS-only correction.
These screenshots are not live GitHub/model findings or installed-app acceptance.
