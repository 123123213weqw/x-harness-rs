//! Durable formatter state/cursor + outgoing batch in one FULL commit.
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

use crate::{
    gateway::{digest, valid_id, ResultBudget},
    receive::current_lease,
    store,
    subscription::{canonical_frame, scope_in_transaction},
    *,
};
use rusqlite::Transaction;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};
const MAX_PROJECTION_STATE: usize = 1024 * 1024;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProjectionCheckpoint {
    pub key: String,
    pub revision: u64,
    pub next_seq: u64,
    pub state: Value,
    pub links: BTreeMap<String, String>,
    pub pending: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct ProjectedReply {
    pub slot: Option<String>,
    pub plan: ReplyPlan,
}
pub struct ProjectionUpdate {
    pub next_seq: u64,
    pub state: Value,
    pub retain: BTreeSet<String>,
    pub replies: Vec<ProjectedReply>,
}
pub(crate) struct ProjectionAdvance {
    expected: ProjectionCheckpoint,
    next_seq: u64,
    state: Value,
    retain: BTreeSet<String>,
    slots: Vec<Option<String>>,
}
fn key(host: &str, scope: &Subscription, revision: u64) -> String {
    digest(&json!(["output-projection-v1", host, scope, revision]))
}
// Internal provenance index, not controller input or an authority grant.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Resume {
    principal_revision: u64,
    scope: Subscription,
    binding: Binding,
    checkpoint: String,
}
fn resume_key(host: &str, scope: &Subscription, revision: u64, b: &Binding) -> String {
    digest(&json!([
        "output-resume-v1",
        host,
        scope.principal,
        revision,
        scope.sender,
        scope.conversation,
        scope.binding,
        b.workspace,
        b.session
    ]))
}
fn remember_projection(
    tx: &Transaction<'_>,
    host: &str,
    scope: &Subscription,
    p: &Principal,
    b: &Binding,
    checkpoint: &ProjectionCheckpoint,
) -> Result<(), Error> {
    let id = resume_key(host, scope, p.revision, b);
    if store::entity::<Resume>(tx, "projection-resume", &id)?.is_none() {
        let count: usize = tx.query_row(
            "SELECT COUNT(*) FROM entities WHERE kind='projection-resume'",
            [],
            |r| r.get(0),
        )?;
        if count >= MAX_RECORDS {
            return Err(Error::Capacity);
        }
    }
    store::put_entity(
        tx,
        "projection-resume",
        &id,
        &Resume {
            principal_revision: p.revision,
            scope: scope.clone(),
            binding: b.clone(),
            checkpoint: checkpoint.key.clone(),
        },
    )
}
/// Only a validated inbox selection transaction may carry a prior visit's
/// forward cursor and formatter state. Never reuse old-generation edit targets
/// or regenerate an ambiguous send. First visits still backfill from zero.
pub(crate) fn seed_selected_projection(
    tx: &Transaction<'_>,
    host: &str,
    previous: &Subscription,
    p: &Principal,
    selected: &Binding,
) -> Result<(), Error> {
    let scope = Subscription {
        generation: selected.generation,
        ..previous.clone()
    };
    seed_resumed_projection(tx, host, &scope, p, selected).map(|_| ())
}
fn seed_resumed_projection(
    tx: &Transaction<'_>,
    host: &str,
    scope: &Subscription,
    p: &Principal,
    selected: &Binding,
) -> Result<bool, Error> {
    let mut source = p.clone();
    let (resume, source_revision) = loop {
        if !source.workspaces.contains(&selected.workspace)
            || !source.sessions.contains(&selected.session)
        {
            return Ok(false);
        }
        let id = resume_key(host, scope, source.revision, selected);
        if let Some(resume) = store::entity::<Resume>(tx, "projection-resume", &id)? {
            break (resume, source.revision);
        }
        let Some(parent) = crate::creation_commands::projection_parent(tx, host, &source)? else {
            return Ok(false);
        };
        // Every certified parent removes exactly one granted session; the chain
        // is bounded by the existing 4096-session allowlist, not arbitrary revs.
        if parent.sessions.len().checked_add(1) != Some(source.sessions.len()) {
            return Err(Error::IdentityConflict);
        }
        source = parent;
    };
    let mut expected_scope = scope.clone();
    expected_scope.generation = resume.binding.generation;
    let mut expected_binding = selected.clone();
    expected_binding.generation = resume.binding.generation;
    if resume.principal_revision != source_revision
        || resume.scope != expected_scope
        || resume.binding != expected_binding
        || resume.binding.generation == 0
        || resume.binding.generation > selected.generation
        || resume.checkpoint != key(host, &resume.scope, source_revision)
    {
        return Err(Error::IdentityConflict);
    }
    let old: ProjectionCheckpoint =
        store::entity(tx, "projection", &resume.checkpoint)?.ok_or(Error::IdentityConflict)?;
    if old.key != resume.checkpoint {
        return Err(Error::IdentityConflict);
    }
    let new_key = key(host, scope, p.revision);
    if store::entity::<ProjectionCheckpoint>(tx, "projection", &new_key)?.is_some() {
        return Err(Error::IdentityConflict);
    }
    let count: usize = tx.query_row(
        "SELECT COUNT(*) FROM entities WHERE kind='projection'",
        [],
        |r| r.get(0),
    )?;
    if count >= MAX_RECORDS {
        return Err(Error::Capacity);
    }
    let cp = ProjectionCheckpoint {
        key: new_key,
        revision: 1,
        next_seq: old.next_seq,
        state: old.state,
        links: BTreeMap::new(),
        pending: vec![],
    };
    store::put_entity(tx, "projection", &cp.key, &cp)?;
    remember_projection(tx, host, scope, p, selected, &cp)?;
    Ok(true)
}
impl ProjectionAdvance {
    pub(crate) fn verify(
        &self,
        tx: &Transaction<'_>,
        host: &str,
        scope: &Subscription,
        p: &Principal,
    ) -> Result<(), Error> {
        if self.expected.key != key(host, scope, p.revision)
            || store::entity::<ProjectionCheckpoint>(tx, "projection", &self.expected.key)?.as_ref()
                != Some(&self.expected)
        {
            return Err(Error::IdentityConflict);
        }
        Ok(())
    }
    pub(crate) fn commit(self, tx: &Transaction<'_>, records: &[Outgoing]) -> Result<(), Error> {
        let mut checkpoint = self.expected;
        checkpoint.revision = checkpoint
            .revision
            .checked_add(1)
            .ok_or(Error::IdentityConflict)?;
        checkpoint.next_seq = self.next_seq;
        checkpoint.state = self.state;
        checkpoint
            .links
            .retain(|slot, _| self.retain.contains(slot));
        checkpoint.pending = records.iter().map(|r| r.key.clone()).collect();
        for (slot, record) in self.slots.into_iter().zip(records) {
            if let Some(slot) = slot {
                if self.retain.contains(&slot) {
                    checkpoint.links.insert(slot, record.key.clone());
                }
            }
        }
        store::put_entity(tx, "projection", &checkpoint.key, &checkpoint)
    }
}
impl Gateway {
    pub async fn read_event_page(
        &self,
        lease: &AccountLease,
        scope: Subscription,
        after: Option<u64>,
    ) -> Result<ScopedEventPage, Error> {
        if lease.account.channel != scope.sender.channel || lease.account.id != scope.sender.account
        {
            return Err(Error::Unauthorized);
        }
        let account_gate = self.account_gate(&lease.account).await;
        let _account = account_gate.read().await;
        let gate = self.principal_gate(&scope.principal).await;
        let _guard = gate.read().await;
        let host = self.host_id.clone();
        let check = scope.clone();
        let l = lease.clone();
        let (p, b) = self
            .store
            .transaction(move |tx| {
                current_lease(tx, &l)?;
                scope_in_transaction(tx, &host, &check)
            })
            .await?;
        let owned = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.session_in_workspace(&b.workspace, &b.session),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if !owned {
            return Err(Error::Unauthorized);
        }
        let mut page = tokio::time::timeout(
            Duration::from_secs(2),
            self.host
                .session_event_page(&b.workspace, &b.session, after),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if !page.is_scoped(&b.session, after) {
            return Err(Error::Invalid("unscoped or noncontiguous event page"));
        }
        if serde_json::to_writer(
            &mut ResultBudget(xharness_api::MAX_SCOPED_EVENT_BYTES),
            &page,
        )
        .is_err()
        {
            return Err(Error::Capacity);
        }
        page.events = page
            .events
            .into_iter()
            .map(|frame| canonical_frame(frame, &b.session))
            .collect::<Result<_, _>>()?;
        let host = self.host_id.clone();
        let l = lease.clone();
        self.store
            .transaction(move |tx| {
                current_lease(tx, &l)?;
                let (current, binding) = scope_in_transaction(tx, &host, &scope)?;
                if current != p || binding != b {
                    return Err(Error::Unauthorized);
                }
                Ok(())
            })
            .await?;
        Ok(page)
    }
    /// Initial binding backfills its authorized durable history in bounded
    /// batches. Never skip a first prompt racing observer startup. Restart and
    /// gaps reuse the persisted forward cursor.
    pub async fn projection_checkpoint(
        &self,
        lease: &AccountLease,
        scope: Subscription,
    ) -> Result<ProjectionCheckpoint, Error> {
        if lease.account.channel != scope.sender.channel || lease.account.id != scope.sender.account
        {
            return Err(Error::Unauthorized);
        }
        let host = self.host_id.clone();
        let s = scope.clone();
        let l = lease.clone();
        let (existing, p, b) = self
            .store
            .transaction(move |tx| {
                current_lease(tx, &l)?;
                let (p, b) = scope_in_transaction(tx, &host, &s)?;
                let id = key(&host, &s, p.revision);
                let mut existing = store::entity::<ProjectionCheckpoint>(tx, "projection", &id)?;
                if existing.is_none() && seed_resumed_projection(tx, &host, &s, &p, &b)? {
                    existing = store::entity(tx, "projection", &id)?;
                }
                if let Some(cp) = &existing {
                    remember_projection(tx, &host, &s, &p, &b, cp)?;
                }
                Ok((existing, p, b))
            })
            .await?;
        if let Some(checkpoint) = existing {
            return Ok(checkpoint);
        }
        let _head = self
            .read_event_page(lease, scope.clone(), None)
            .await?
            .head_seq;
        let host = self.host_id.clone();
        let l = lease.clone();
        self.store
            .transaction(move |tx| {
                current_lease(tx, &l)?;
                let (current, binding) = scope_in_transaction(tx, &host, &scope)?;
                if current != p || binding != b {
                    return Err(Error::Unauthorized);
                }
                let id = key(&host, &scope, p.revision);
                if let Some(old) = store::entity(tx, "projection", &id)? {
                    return Ok(old);
                }
                let count: usize = tx.query_row(
                    "SELECT COUNT(*) FROM entities WHERE kind='projection'",
                    [],
                    |r| r.get(0),
                )?;
                if count >= MAX_RECORDS {
                    return Err(Error::Capacity);
                }
                let checkpoint = ProjectionCheckpoint {
                    key: id,
                    revision: 1,
                    next_seq: 0,
                    state: Value::Null,
                    links: BTreeMap::new(),
                    pending: vec![],
                };
                store::put_entity(tx, "projection", &checkpoint.key, &checkpoint)?;
                remember_projection(tx, &host, &scope, &p, &b, &checkpoint)?;
                Ok(checkpoint)
            })
            .await
    }
    /// Called only by trusted formatters; no external state/cursor writer API.
    pub async fn advance_projection(
        &self,
        lease: &AccountLease,
        scope: Subscription,
        expected: ProjectionCheckpoint,
        update: ProjectionUpdate,
    ) -> Result<(), Error> {
        let ProjectionUpdate {
            next_seq,
            state,
            retain,
            replies,
        } = update;
        if next_seq < expected.next_seq
            || retain.len() > MAX_REPLY_BATCH
            || replies.len() > MAX_REPLY_BATCH
        {
            return Err(Error::Invalid("projection advance bounds"));
        }
        if serde_json::to_writer(&mut ResultBudget(MAX_PROJECTION_STATE), &state).is_err() {
            return Err(Error::Capacity);
        }
        for slot in &retain {
            valid_id(slot)?;
        }
        let mut seen = BTreeSet::new();
        for slot in replies.iter().filter_map(|r| r.slot.as_ref()) {
            valid_id(slot)?;
            if !seen.insert(slot.clone()) {
                return Err(Error::IdentityConflict);
            }
        }
        if lease.account.channel != scope.sender.channel || lease.account.id != scope.sender.account
        {
            return Err(Error::Unauthorized);
        }
        let gate = self.account_gate(&lease.account).await;
        let _guard = gate.read().await;
        let slots = replies.iter().map(|r| r.slot.clone()).collect();
        let plans = replies.into_iter().map(|r| r.plan).collect();
        self.enqueue_replies_inner(
            scope,
            plans,
            Some(lease.clone()),
            Some(crate::outbox::ProducerCommit::Projection(
                ProjectionAdvance {
                    expected,
                    next_seq,
                    state,
                    retain,
                    slots,
                },
            )),
        )
        .await?;
        Ok(())
    }
}
