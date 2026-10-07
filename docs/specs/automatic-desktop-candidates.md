# Automatic desktop candidates (prepare, never publish)

`master` push → latest exact-SHA `CI` succeeds → `Desktop Candidate Prepare` →
reserve an immutable `desktop-vX.Y.Z` tag → existing `Desktop Release` **on that
tag**, with integrated acceptance → four protected signing/native workers →
complete private draft and receipts → stop at `awaiting_confirmation`.

Targets: Windows x64, Linux x64 AppImage, macOS arm64 and macOS x64. PR/fork runs,
failed/cancelled/skipped gates and obsolete CI attempts cannot prepare candidates.
A master CI cancelled by a newer commit has no green result, hence no candidate.

The controller never invokes `Desktop Promote`, publishes a release, changes the
public `latest.json` or website, or restarts installed apps. Draft assets are not
an update channel; users keep receiving the last **published** stable release.

## Source, version and recovery

- Controls come from trusted master. Authenticate CI through REST and verify the
  trigger SHA is a master ancestor. No PR artifacts, no substitution of current
  HEAD for the trigger SHA, even when master advances while work is queued.
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
- Per-tag candidate locks are separate from the serialized stable publication
  lock. A controller rerun restores its run-bound journal before doing anything.

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

## Policy and retention

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

```sh
python3 -B scripts/test-desktop-candidates.py
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
