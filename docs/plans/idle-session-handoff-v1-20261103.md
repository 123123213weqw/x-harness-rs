# Quiesced session handoff v1

## Scope and activation

Explicit native owner CLI only; not a browser endpoint, not automatic background
synchronization, not installed App activation. No dependencies or lock changes.
Both Hosts must be stopped: the peer retains the same state-directory ownership
lease as the normal Host and checks legacy per-agent leases. Do not use production
state for initial acceptance. Stop/drain external editors and process writers too;
advisory native leases cannot fence arbitrary same-user filesystem edits.

A committed common **code** checkpoint must already exist and both live source
trees must still match it. Pair binding, generation, manifest digest and full
shared transaction decision/receipt digest must agree, not just tree contents.
The peer holds native workspace/control/spool leases throughout the handoff.
Credentials, machine-global settings, memory, plugins and presets are NOT copied.
Target model/tool/environment configuration must be provisioned independently;
this CLI does not certify route readiness or arbitrary task portability.

## Protocol

1. `describe`: independently derive owner identity from native registered workspace
   descriptor and canonical state root; derive cwd/checkpoint, never accept roots
   or executable paths from a response/model/browser request.
2. `freeze`: under the session's process and cross-process writer locks, fully
   replay and validate the journal, require its source cwd to resolve to the
   registered native workspace, require portable idle state, collect referenced
   resources, durably save the content-hashed bundle and frozen ownership fence.
   Rewrite only the storage envelope with a permanent `handoff: 1` header marker;
   the pre-feature strict header schema rejects it. Do not acknowledge freeze
   before that marker is durable. Preserve the original source journal privately.
3. `prepare`: target validates the exact native destination/cwd/code checkpoint,
   full Session invariants and complete resource closure. Save receiving fence
   and bundle durably; do NOT expose an executable journal or call a model/tool.
   Existing unrelated session IDs are never replaced.
4. `release`: source validates the exact prepared receipt and unchanged source
   journal, then durably relinquishes ownership. No automatic unseal or timeout
   takeover. A missing reply is not evidence that release failed.
5. `activate`: require the exact relinquishment certificate, install independently
   verified resources and the complete journal, then durably activate epoch N+1.
   Only the native destination cwd is remapped; IDs/revisions/sequence numbers/
   timestamps, compaction replacements, plans and per-session settings remain.

Receipts are integrity/mismatch checks, **not signatures or authorization tokens**.
Only the existing authenticated owner SSH channel may carry them. No read-only
bearer capability is promoted. The target may prepare while the source is sealed,
but cannot execute before source relinquishment. A crash may leave neither side
active; it must never lead to automatic dual activation. Recovery reuses the exact
saved bundle/receipts. Replayed completed receipts are historical, not a claim
that later messages or files remain unchanged.

Reverse transfer uses epoch N+1 and may supersede only that same previously
relinquished session lineage. Retain the prior exact journal, refuse unrelated
IDs, altered owners, wrong checkpoint/epoch, damaged/missing evidence or drift.
There is no reset, abort/unseal, force-overwrite, deletion, GC or revert API.
Interrupted unpublished private stages are retained and never trusted on replay.
A crash between the initial required-pin and mutable-fence publication is safely
fenced and needs owner investigation; it is not silently bootstrapped again.

## Portable profile and bounds

- 16 MiB encoded bundle, 50,000 events, at most 128 handoff epochs.
  Forward bundle bytes as bounded base64, never parse/re-encode history through
  JavaScript numbers (large u64 and even integral floats must remain lossless).
  The owner stdio frame is bounded separately for base64 expansion.
- Require complete journal records; bound physical and advertised gzip expansion
  before replay. Resource expansion uses the existing per-blob limits and stops
  collecting once the total bundle budget is exceeded. Encoded limits are not
  an RSS or filesystem quota.
- Carry exact original events, referenced cold tool-result text, independent
  Harness snapshots and optional full request audits. Recreate their native
  hash-addressed namespaces and check every original reference before preparing.
- Reject open turns, queued input, uncompleted commands/compactions, unresolved
  tool calls/approvals/questions and deferred undelivered answers. Do not repair
  uncertain outcomes or replay effects to make a session eligible.
- First profile conservatively rejects histories involving Goals, schedules,
  job continuations, delegation, forks or custom agent presets (even settled),
  attachments/media and opaque provider-owned items. These need their own resource
  and authority closure. Textual old paths/URLs are not automatically rewritten.
- No terminal/process/browser connection, in-flight tool, OS handle, runtime task,
  attachment store, global memory or Git metadata migration.
- Frozen/relinquished/receiving sessions are not restored as executable sessions;
  startup reports them unavailable, without calling a model. Normal writes,
  seeded creation, deletion and cold compression respect the durable fence.
  Loss of both fence files still cannot reopen the marker-bearing journal.

## Explicit owner CLI

Build `workspace_sync_peer` and `session_handoff_peer` on WZU_Server or native
macOS CI; never compile Rust on the user's Mac. Use the workspace-sync owner-only
0600 config schema, but set each `binary` to **session_handoff_peer**. Keep separate
code-sync and handoff config files so the different command contracts cannot be
confused. Roots/registration/SSH alias are native owner configuration.

```
node scripts/session-handoff.mjs HANDOFF_CONFIG /absolute/local-state /absolute/cloud-state local-to-cloud SESSION_ID
node scripts/session-handoff.mjs HANDOFF_CONFIG /absolute/local-state /absolute/cloud-state cloud-to-local SESSION_ID
```

The existing SSH settings/keys/host verification are preserved, no agent
forwarding, no new public/write HTTP service. Only a bounded payload/receipt
channel is opened. Errors do not log history, prompts, raw errors or identifiers.
Clean process completion is observed; if unconfirmed, retain state for recovery.
Do not manually delete marker/fence/pin files or rename retained old journals into
live `.jsonl` names. Backups/retained inodes are not protected against arbitrary
same-user external editing, and receipts do not create a content-backup service.

## Validation

Remote JSONL regression suite; real BasicHost restore and one deterministic
provider continuation with original history (restore alone calls no provider;
relinquished source calls none); independent native-process tests over real
rsync with >2 MiB text, roundtrip epoch 2, controller loss at all four phases,
actual exit(86) after durable operation before reply, inode-preserving replay,
state-directory lease exclusion and dirty-code rejection. This is not a live
upstream model evaluation or production App migration. macOS runs on native CI.
