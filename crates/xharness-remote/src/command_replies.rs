//! Scoped terminal inbox results -> durable outgoing receipt, never task replay.
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
    gateway::{digest, ResultBudget},
    receive::current_lease,
    store,
    subscription::scope_in_transaction,
    *,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    delivery_state: DeliveryState,
    delivery_sha: String,
    plans_sha: String,
    outgoing: Vec<String>,
}
pub(crate) struct CommandReplyCommit {
    expected: Delivery,
    plans_sha: String,
}
fn terminal(d: &Delivery) -> bool {
    matches!(
        d.state,
        DeliveryState::Completed
            | DeliveryState::Rejected
            | DeliveryState::Uncertain
            | DeliveryState::Abandoned
    )
}
fn in_scope(tx: &Transaction<'_>, d: &Delivery, p: &Principal, b: &Binding) -> Result<bool, Error> {
    if matches!(d.inbound.command, Command::AutomationControl { .. })
        && d.state == DeliveryState::Completed
        && !matches!(d.result, Some(NativeCommandResult::Failure { .. }))
    {
        return Ok(d.principal == p.id
            && d.principal_revision == p.revision
            && d.binding == *b
            && crate::automation_commands::reply_proven(tx, &p.host, d)?);
    }
    if matches!(d.inbound.command, Command::CreateSession { .. })
        && d.state == DeliveryState::Completed
    {
        return crate::creation_commands::reply_in_scope(tx, &p.host, d, p, b);
    }
    if matches!(d.inbound.command, Command::Select { .. })
        && d.state == DeliveryState::Completed
        && !matches!(d.result, Some(NativeCommandResult::Failure { .. }))
    {
        return crate::selection::reply_in_scope(tx, d, p, b);
    }
    Ok(d.principal == p.id && d.principal_revision == p.revision && d.binding == *b)
}
impl CommandReplyCommit {
    pub(crate) fn verify(
        &self,
        tx: &Transaction<'_>,
        p: &Principal,
        b: &Binding,
    ) -> Result<(), Error> {
        if !terminal(&self.expected)
            || !in_scope(tx, &self.expected, p, b)?
            || store::delivery(tx, &self.expected.key)?.as_ref() != Some(&self.expected)
        {
            return Err(Error::IdentityConflict);
        }
        if let Some(old) = store::entity::<Receipt>(tx, "command-reply", &self.expected.key)? {
            if old.delivery_state == self.expected.state
                && (old.delivery_sha != digest(&json!(self.expected))
                    || old.plans_sha != self.plans_sha)
            {
                return Err(Error::IdentityConflict);
            }
        } else {
            let count: usize = tx.query_row(
                "SELECT COUNT(*) FROM entities WHERE kind='command-reply'",
                [],
                |r| r.get(0),
            )?;
            if count >= MAX_RECORDS {
                return Err(Error::Capacity);
            }
        }
        Ok(())
    }
    pub(crate) fn commit(self, tx: &Transaction<'_>, records: &[Outgoing]) -> Result<(), Error> {
        let receipt = Receipt {
            delivery_state: self.expected.state.clone(),
            delivery_sha: digest(&json!(self.expected)),
            plans_sha: self.plans_sha,
            outgoing: records.iter().map(|r| r.key.clone()).collect(),
        };
        store::put_entity(tx, "command-reply", &self.expected.key, &receipt)
    }
}
impl Gateway {
    /// One bounded terminal result, oldest first in the exact current scope.
    /// Reconciled state changes are separate notifications, not permission to
    /// repeat the native command. No raw external endpoint exposes this read.
    pub async fn command_reply_candidate(
        &self,
        lease: &AccountLease,
        scope: Subscription,
    ) -> Result<Option<Delivery>, Error> {
        if lease.account.channel != scope.sender.channel || lease.account.id != scope.sender.account
        {
            return Err(Error::Unauthorized);
        }
        let account = self.account_gate(&lease.account).await;
        let _account = account.read().await;
        let principal = self.principal_gate(&scope.principal).await;
        let _principal = principal.read().await;
        let host = self.host_id.clone();
        let l = lease.clone();
        let s = scope.clone();
        let (p, b) = self
            .store
            .transaction(move |tx| {
                current_lease(tx, &l)?;
                scope_in_transaction(tx, &host, &s)
            })
            .await?;
        if !self.reply_host_scope(&b).await? {
            return Err(Error::Unauthorized);
        }
        let host = self.host_id.clone();
        let l = lease.clone();
        self.store.transaction(move |tx| {
            current_lease(tx,&l)?;
            let (current,binding)=scope_in_transaction(tx,&host,&scope)?;
            if current!=p || binding!=b {return Err(Error::Unauthorized);}
            let raw:Option<String>=tx.query_row("SELECT i.body FROM inbox i LEFT JOIN entities e ON e.kind='command-reply' AND e.id=i.key
                LEFT JOIN entities s ON s.kind='selection-receipt' AND s.id=i.key
                LEFT JOIN entities c ON c.kind='creation-command-proof' AND c.id=i.key
                WHERE json_extract(i.body,'$.principal')=?2 AND ((i.body -> '$.principal_revision')=?3 OR (c.body -> '$.receipt.principal_revision')=?3)
                AND json_extract(i.body,'$.binding.id')=?4
                AND ((i.session=?1 AND (i.body -> '$.binding.generation')=?5)
                    OR (json_extract(s.body,'$.selection.binding.session')=?1 AND (s.body -> '$.selection.binding.generation')=?5))
                AND i.state IN ('completed','rejected','uncertain','abandoned')
                AND (e.id IS NULL OR json_extract(e.body,'$.delivery_state') IS NULL OR json_extract(e.body,'$.delivery_state')<>i.state) ORDER BY i.seq LIMIT 1",
                params![binding.session,current.id,current.revision.to_string(),binding.id,binding.generation.to_string()],|r|r.get(0)).optional()?;
            let candidate:Option<Delivery>=raw.map(|s|serde_json::from_str(&s)).transpose()?;
            if let Some(d)=&candidate {if !terminal(d)||!in_scope(tx,d,&current,&binding)? {return Err(Error::Unauthorized);}}
            Ok(candidate)
        }).await
    }
    /// Exact inbox snapshot, outgoing batch and consumed result receipt commit
    /// together. Cancellation or lost ACK cannot create a second batch on retry.
    pub async fn enqueue_command_replies(
        &self,
        lease: &AccountLease,
        scope: Subscription,
        expected: Delivery,
        plans: Vec<ReplyPlan>,
    ) -> Result<Vec<Outgoing>, Error> {
        if lease.account.channel != scope.sender.channel || lease.account.id != scope.sender.account
        {
            return Err(Error::Unauthorized);
        }
        if plans.is_empty() || plans.len() > MAX_REPLY_BATCH {
            return Err(Error::Invalid("command reply batch"));
        }
        for plan in &plans {
            crate::outbox::validate_plan(plan)?;
        }
        if serde_json::to_writer(&mut ResultBudget(MAX_RESULT_BYTES), &plans).is_err() {
            return Err(Error::Capacity);
        }
        let account = self.account_gate(&lease.account).await;
        let _guard = account.read().await;
        let plans_sha = digest(&json!(plans));
        self.enqueue_replies_inner(
            scope,
            plans,
            Some(lease.clone()),
            Some(crate::outbox::ProducerCommit::Command(Box::new(
                CommandReplyCommit {
                    expected,
                    plans_sha,
                },
            ))),
        )
        .await
    }
}
