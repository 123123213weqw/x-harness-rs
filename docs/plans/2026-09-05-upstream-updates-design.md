# Upstreaming the Windows update channel

The user requests that this project's changes be submitted to the fork's upstream,
123123213weqw/x-harness-rs. Submit the release feature separately from open model
settings PR #21, on the current upstream base. Do not merge either PR on behalf
of maintainers, publish an upstream release, or transfer signing secrets.

Replace the original hardcoded fork owner with explicit repository opt-in:
XHARNESS_FRIENDS_RELEASE_REPOSITORY must exactly match GITHUB_REPOSITORY. Validate
that repository identity again in the release helper, including the final publish
preflight. Derive package and manifest URLs only from this validated identity.
Keep the optional friends-v* namespace and dedicated signing secrets isolated
from the existing desktop-v* production workflow. Preserve Windows-only scope;
the combined macOS/Windows channel remains separate future work.

Alternatives were submitting the fork-specific workflow unchanged (not useful to
upstream) or combining release policy with the unfinished multi-platform work
(unnecessary expansion). This narrowly generalizes the already-tested workflow.

CI should test the pure release contract on Linux without secrets. No actual
release is triggered by the PR. Existing fork clients keep their URL and key;
moving code upstream does not migrate installed clients' trust automatically.
