//! Read-only project instructions. No question, Goal or memory writer belongs here.
//!
//! Discovery stops at the session's bound workspace: no home/parent lookup,
//! recursive scan, watcher or model-selected host path. Nested rules are read
//! on demand with the existing file tools, under the policy below.

use std::{sync::Arc, time::Duration};

use tokio::sync::Semaphore;
use xharness_fs::{FsError, FsService};
use xharness_prompt::{PromptAssembler, PromptAssembly, PromptSection};

use crate::questions::{AGENT_MEMORY_BEGIN, AGENT_MEMORY_END};

const MAX_BYTES: usize = 64 * 1024;
const LOAD_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) const POLICY: &str = "AGENTS.md is scoped project instruction, not a conversation log or Goal. Before editing below the root, inspect AGENTS.md in its ancestor directories inside the workspace; do not scan the repository. More specific instructions apply only to their directory subtree and override parent project rules, never user instructions, Host policies or permissions. Change rules only for an authorized durable project-rule change: read first, preserve unrelated content, report the diff. Never auto-save answers, errors, results, temporary choices or inferred preferences; suggest new rules. Legacy XHARNESS:USER-MEMORY question answers are excluded.";

#[derive(Clone)]
pub(crate) struct InstructionLoader {
    slots: Arc<Semaphore>,
}

impl Default for InstructionLoader {
    fn default() -> Self {
        Self {
            slots: Arc::new(Semaphore::new(4)),
        }
    }
}

impl InstructionLoader {
    pub(crate) async fn assemble(
        &self,
        cwd: String,
        mut sections: Vec<PromptSection>,
    ) -> Result<PromptAssembly, String> {
        sections.push(PromptSection::new(
            "workspace/instructions-policy",
            "2",
            POLICY,
        ));
        if let Some(section) = self.load(cwd).await? {
            sections.push(section);
        }
        // Only explicitly shared policies belong in the reusable prefix.
        // Unknown/custom context remains in the tail; never sort user content
        // or demote permission/project rules to a lower-priority role.
        let (mut shared, contextual): (Vec<_>, Vec<_>) = sections.into_iter().partition(|s| {
            s.id.starts_with("agent-preset/")
                || matches!(
                    s.id.as_str(),
                    "coding/workflow"
                        | "tool/jobs"
                        | "tool/browser"
                        | "memory/policy"
                        | "workspace/instructions-policy"
                )
        });
        shared.extend(contextual);
        PromptAssembler
            .assemble(shared)
            .map_err(|e| format!("prompt assembly failed: {e}"))
    }

    async fn load(&self, cwd: String) -> Result<Option<PromptSection>, String> {
        let slots = Arc::clone(&self.slots);
        tokio::time::timeout(LOAD_TIMEOUT, async move {
            let permit = slots.acquire_owned().await.map_err(|e| e.to_string())?;
            // If the caller times out, an OS read may still be running. Keep
            // its slot in this owned task until completion, not in the caller.
            tokio::spawn(async move {
                let _permit = permit;
                load_root(cwd).await
            })
            .await
            .map_err(|e| format!("instruction worker stopped: {e}"))?
        })
        .await
        .map_err(|_| "AGENTS.md loading timed out; no model request was started".to_owned())?
    }
}

async fn load_root(cwd: String) -> Result<Option<PromptSection>, String> {
    // FsService supplies the same contained, regular-file-only, no-follow
    // read used by previews. Do not duplicate OS path/race checks in Host.
    let opened = tokio::task::spawn_blocking(move || {
        let fs = FsService::new(cwd)?;
        let target = fs.resolve("AGENTS.md")?;
        Ok::<_, FsError>((fs, target))
    })
    .await
    .map_err(|e| format!("AGENTS.md discovery worker stopped: {e}"))?;
    let (fs, target) = match opened {
        Ok(value) => value,
        Err(error) if absent(&error) => return Ok(None),
        Err(error) => return Err(format!("cannot load workspace AGENTS.md: {error}")),
    };
    let bytes = match fs.read_preview_bytes(&target, MAX_BYTES).await {
        Ok(bytes) => bytes,
        Err(error) if absent(&error) => return Ok(None),
        Err(error) => return Err(format!("cannot load workspace AGENTS.md: {error}")),
    };
    let text = std::str::from_utf8(&bytes)
        .map_err(|_| "workspace AGENTS.md must be UTF-8; no rules were truncated".to_owned())?;
    let rules = project_rules(text.trim_start_matches('\u{feff}'))?;
    if rules.trim().is_empty() {
        return Ok(None);
    }
    let root = serde_json::to_string(fs.workspace_root()).map_err(|e| e.to_string())?;
    Ok(Some(PromptSection::content_addressed(
        "workspace/instructions/AGENTS.md",
        format!("Project instructions from AGENTS.md\nScope: workspace {root} and its descendants only.\n\n{}", rules.trim()),
    )))
}

fn absent(error: &FsError) -> bool {
    matches!(error, FsError::NotFound { .. })
        || matches!(error, FsError::Io { source, .. } if source.kind() == std::io::ErrorKind::NotFound)
}

/// Leave legacy bytes on disk, but never promote old question answers into
/// project rules. Malformed markers fail visibly instead of leaking content.
fn project_rules(text: &str) -> Result<String, String> {
    let mut remaining = text;
    let mut rules = String::new();
    loop {
        let Some(start) = remaining.find(AGENT_MEMORY_BEGIN) else {
            if remaining.contains(AGENT_MEMORY_END) {
                return Err("AGENTS.md has an unmatched legacy memory end marker".into());
            }
            rules.push_str(remaining);
            return Ok(rules);
        };
        let before = &remaining[..start];
        if before.contains(AGENT_MEMORY_END) {
            return Err("AGENTS.md has an unmatched legacy memory end marker".into());
        }
        rules.push_str(before);
        rules.push('\n');
        let tail = &remaining[start + AGENT_MEMORY_BEGIN.len()..];
        let end = tail.find(AGENT_MEMORY_END).ok_or_else(|| {
            "AGENTS.md has an unclosed legacy memory section; repair it before continuing"
                .to_owned()
        })?;
        if tail[..end].contains(AGENT_MEMORY_BEGIN) {
            return Err("AGENTS.md has nested legacy memory markers".into());
        }
        remaining = &tail[end + AGENT_MEMORY_END.len()..];
    }
}

impl crate::BasicHost {
    pub(crate) async fn prompt_assembly(&self, session_id: &str) -> Result<PromptAssembly, String> {
        let (cwd, sections) = {
            let state = self.state.read().await;
            let session = state
                .sessions
                .get(session_id)
                .ok_or_else(|| format!("session {session_id:?} was not found"))?;
            (session.cwd.clone(), state.prompt_sections(session_id)?)
        };
        // No filesystem work while holding the global Host state lock.
        self.assemble_prompt(cwd, sections).await
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod turn_tests;
