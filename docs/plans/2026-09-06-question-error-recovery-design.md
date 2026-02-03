# Question error recovery design

The shared Rust runtime must let malformed user-question calls return ordinary
tool errors without weakening durable human-interaction ordering. This fixes all
Host clients and operating systems without shell or UI changes.

Decision: before a durable request exists, permit error/unknown results, never a
successful answer. After a request exists, retain the existing settlement guard.
Rejecting all results before a request turns parameter errors into journal
failures; removing the guard entirely would accept answers without user input.

Recovery revalidates unresolved question arguments using the tool's own parser.
Only provably invalid calls without a request receive deterministic error results,
including after an older failed turn has closed. Other interrupted operations
retain outcome_unknown and must not be blindly replayed. Existing pending or
settled questions keep their stable-identity recovery path. Recovery appends via
the normal revision-checked store and never rewrites history or invents answers.

Use synthetic missing-option-ID fixtures, not private session transcripts.
Validate retry, closed-turn recovery, idempotence, and rejection of premature
success/results for pending questions. Multi-Host exclusivity, network failures,
and context budgeting are separate changes. Existing installations are untouched.
