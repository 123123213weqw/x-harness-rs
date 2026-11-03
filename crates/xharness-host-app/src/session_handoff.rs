//! Quiesced native session ownership transfer; never a browser-selected root.
//! The installed UI does not enable migration until live admission/resource
//! drains and target configuration preflight have been integrated separately.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]
use crate::workspace_wire::{Participant, Phase, Role};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::{io, path::Path};
use xharness_agent::AgentLease;
use xharness_fs::FsService;
use xharness_session_jsonl::{
    handoff::{
        self, Bundle, Destination, Prepared, Released, WorkspaceCheckpoint, MAX_HANDOFF_BYTES,
    },
    JsonlSessionStore,
};

pub struct Owner {
    _ownership: Box<dyn AgentLease>,
    participant: Participant,
    store: JsonlSessionStore,
    id: String,
    cwd: String,
}
fn rejected() -> io::Error {
    io::Error::other("native session handoff rejected; retain state for recovery")
}
impl Owner {
    /// Both Hosts must be stopped. The normal installed Host uses this exact
    /// data-directory lease too; legacy per-agent leases are checked as well.
    pub async fn open(
        state: &Path,
        workspace: &FsService,
        control: &FsService,
        spool: &FsService,
        role: Role,
    ) -> io::Result<Self> {
        let ownership = crate::ownership::acquire(state).await?;
        let state = std::fs::canonicalize(state)?;
        for root in [
            workspace.workspace_root(),
            control.workspace_root(),
            spool.workspace_root(),
        ] {
            if state.starts_with(root) || root.starts_with(&state) {
                return Err(rejected());
            }
        }
        let participant = Participant::open(workspace, spool, role).map_err(|_| rejected())?;
        let id = handoff::digest(&(participant.descriptor(), &state)).map_err(|_| rejected())?;
        let cwd = workspace
            .workspace_root()
            .to_str()
            .ok_or_else(rejected)?
            .to_owned();
        let store = JsonlSessionStore::new(state.join("sessions")).map_err(|_| rejected())?;
        let owner = Self {
            _ownership: ownership,
            participant,
            store,
            id,
            cwd,
        };
        owner.destination()?; // Only a committed, idle, live-matching workspace.
        Ok(owner)
    }
    pub fn destination(&self) -> io::Result<Destination> {
        let s = self.participant.status().map_err(|_| rejected())?;
        let r = s.receipt.as_ref().ok_or_else(rejected)?;
        if s.round.is_some()
            || s.phase.is_some()
            || s.base.generation == 0
            || r.phase != Phase::Complete
            || r.generation != s.base.generation
            || s.decision.is_none()
        {
            return Err(rejected());
        }
        let snapshot = self.participant.snapshot().map_err(|_| rejected())?;
        let manifest = xharness_cloud::workspace_sync::WorkspaceManifest::from_json(
            s.base.manifest.as_bytes(),
        )
        .map_err(|_| rejected())?;
        if manifest.digest().map_err(|_| rejected())?.as_str() != r.manifest {
            return Err(rejected());
        }
        if snapshot.manifest != s.base.manifest {
            return Err(rejected());
        }
        Ok(Destination {
            owner: self.id.clone(),
            cwd: self.cwd.clone(),
            workspace: WorkspaceCheckpoint {
                binding: s.base.binding,
                generation: s.base.generation,
                manifest: r.manifest.clone(),
                transaction: handoff::digest(&(
                    &r.round,
                    &r.plan,
                    r.generation,
                    &r.manifest,
                    &s.decision,
                ))
                .map_err(|_| rejected())?,
            },
        })
    }
    pub async fn request(&self, request: Request) -> io::Result<serde_json::Value> {
        match request {
            Request::Describe {} => {
                serde_json::to_value(self.destination()?).map_err(|_| rejected())
            }
            Request::Status { session } => serde_json::to_value(
                self.store
                    .handoff_status(&session)
                    .await
                    .map_err(|_| rejected())?,
            )
            .map_err(|_| rejected()),
            Request::Freeze {
                session,
                destination,
            } => {
                if destination.workspace != self.destination()?.workspace {
                    return Err(rejected());
                }
                let bundle = self
                    .store
                    .freeze_handoff_at(
                        &session,
                        self.id.clone(),
                        destination,
                        Some(self.cwd.clone()),
                    )
                    .await
                    .map_err(|_| rejected())?;
                // Never round-trip original event JSON through JavaScript numbers.
                // The coordinator forwards only this bounded opaque byte string.
                let bytes = serde_json::to_vec(&bundle).map_err(|_| rejected())?;
                Ok(serde_json::Value::String(BASE64.encode(bytes)))
            }
            Request::Prepare { bundle } => {
                if bundle.len() > MAX_HANDOFF_BYTES.div_ceil(3) * 4 {
                    return Err(rejected());
                }
                let bytes = BASE64.decode(bundle).map_err(|_| rejected())?;
                if bytes.len() > MAX_HANDOFF_BYTES {
                    return Err(rejected());
                }
                let bundle: Bundle = serde_json::from_slice(&bytes).map_err(|_| rejected())?;
                serde_json::to_value(
                    self.store
                        .prepare_handoff(self.id.clone(), self.destination()?, bundle)
                        .await
                        .map_err(|_| rejected())?,
                )
                .map_err(|_| rejected())
            }
            Request::Release { prepared } => {
                if prepared.workspace != self.destination()?.workspace {
                    return Err(rejected());
                }
                serde_json::to_value(
                    self.store
                        .release_handoff(prepared)
                        .await
                        .map_err(|_| rejected())?,
                )
                .map_err(|_| rejected())
            }
            Request::Activate { released } => serde_json::to_value(
                self.store
                    .activate_handoff(self.id.clone(), self.destination()?, released)
                    .await
                    .map_err(|_| rejected())?,
            )
            .map_err(|_| rejected()),
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Describe {},
    Status {
        session: String,
    },
    Freeze {
        session: String,
        destination: Destination,
    },
    Prepare {
        bundle: String,
    },
    Release {
        prepared: Prepared,
    },
    Activate {
        released: Released,
    },
}
