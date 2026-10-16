//! Durable external replies, independent from inbox admission/Agent execution.
//! One provider effect per record. Unknown send outcomes never auto-replay.
use crate::{
    gateway::{digest, valid_id, ResultBudget},
    receive::{account_key, current_lease, valid_digest},
    subscription::scope_in_transaction,
    *,
};
use async_trait::async_trait;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio_util::sync::CancellationToken;

pub const MAX_REPLY_BATCH: usize = 64;
const MAX_SEND_ATTEMPTS: u32 = 32;
const SCOPE_DEADLINE: Duration = Duration::from_secs(2);
const SEND_DEADLINE: Duration = Duration::from_secs(60);

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplyButton {
    pub label: String,
    pub ticket: String,
}
impl std::fmt::Debug for ReplyButton {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReplyButton")
            .field("label", &self.label)
            .field("ticket", &"[REDACTED]")
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplyBody {
    pub text: String,
    pub buttons: Vec<Vec<ReplyButton>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment: Option<ReplyAttachment>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplyPlan {
    /// Stable semantic projection/delivery identity, never a new random id on retry.
    pub id: String,
    pub body: ReplyBody,
    /// Only edit a previous delivered record in this exact scope, not a raw
    /// controller-supplied platform message id.
    pub replace_of: Option<String>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyState {
    Pending,
    Sending,
    Delivered,
    Rejected,
    Uncertain,
    Abandoned,
}
impl ReplyState {
    fn wire(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sending => "sending",
            Self::Delivered => "delivered",
            Self::Rejected => "rejected",
            Self::Uncertain => "uncertain",
            Self::Abandoned => "abandoned",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyFailure {
    InvalidInput,
    InvalidCredentials,
    Forbidden,
    Unsupported,
    TargetGone,
    ProviderRejected,
    ScopeChanged,
    ScopeUnavailable,
    Interrupted,
    InvalidReceipt,
    RetryExhausted,
    ProviderUncertain,
    ManuallyNotSent,
    ManuallyAbandoned,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProviderReceipt {
    pub message_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outgoing {
    pub sequence: i64,
    pub key: String,
    pub account: Account,
    pub sender: Sender,
    pub principal: String,
    pub principal_revision: u64,
    pub binding: Binding,
    pub plan: ReplyPlan,
    pub state: ReplyState,
    pub attempts: u32,
    pub sending_generation: Option<u64>,
    pub not_before_ms: u64,
    pub expected_message: Option<String>,
    pub receipt: Option<ProviderReceipt>,
    pub failure: Option<ReplyFailure>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SendRequest {
    pub account: Account,
    pub sender: Sender,
    pub conversation: String,
    pub body: ReplyBody,
    pub replace_message: Option<String>,
    pub attachment: Option<xharness_api::ScopedAttachment>,
}
/// A retry is permitted only for an authoritative NOT-SENT rate-limit response.
/// Generic HTTP errors/disconnects/timeouts must be Uncertain, not RetryAfter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendOutcome {
    Delivered(ProviderReceipt),
    Rejected(ReplyFailure),
    RetryAfter { seconds: u32 },
    Uncertain,
}
#[async_trait]
pub trait ReplyTransport: Send + Sync + 'static {
    fn account(&self) -> &Account;
    async fn send(&self, request: SendRequest) -> SendOutcome;
}

pub(crate) enum ProducerCommit {
    Projection(crate::projection::ProjectionAdvance),
    Command(Box<crate::command_replies::CommandReplyCommit>),
}
impl ProducerCommit {
    fn verify(
        &self,
        tx: &Transaction<'_>,
        host: &str,
        scope: &Subscription,
        p: &Principal,
        b: &Binding,
    ) -> Result<(), Error> {
        match self {
            Self::Projection(advance) => advance.verify(tx, host, scope, p),
            Self::Command(reply) => reply.verify(tx, p, b),
        }
    }
    fn commit(self, tx: &Transaction<'_>, records: &[Outgoing]) -> Result<(), Error> {
        match self {
            Self::Projection(advance) => advance.commit(tx, records),
            Self::Command(reply) => reply.commit(tx, records),
        }
    }
}
impl Gateway {
    /// Trusted projection/formatter composition only. Not controller ingress.
    /// All parts of a long reply commit together, with independent send receipts.
    pub async fn enqueue_replies(
        &self,
        scope: Subscription,
        plans: Vec<ReplyPlan>,
    ) -> Result<Vec<Outgoing>, Error> {
        self.enqueue_replies_inner(scope, plans, None, None).await
    }
    /// Account producers must fence their lease in the same FULL commit as
    /// the output, including a transaction whose caller was cancelled.
    pub async fn enqueue_account_replies(
        &self,
        lease: &AccountLease,
        scope: Subscription,
        plans: Vec<ReplyPlan>,
    ) -> Result<Vec<Outgoing>, Error> {
        if scope.sender.channel != lease.account.channel || scope.sender.account != lease.account.id
        {
            return Err(Error::Unauthorized);
        }
        let gate = self.account_gate(&lease.account).await;
        let _guard = gate.read().await;
        self.account_checkpoint(lease).await?;
        self.enqueue_replies_inner(scope, plans, Some(lease.clone()), None)
            .await
    }
    pub(crate) async fn enqueue_replies_inner(
        &self,
        scope: Subscription,
        plans: Vec<ReplyPlan>,
        lease: Option<AccountLease>,
        projection: Option<ProducerCommit>,
    ) -> Result<Vec<Outgoing>, Error> {
        if (plans.is_empty() && projection.is_none()) || plans.len() > MAX_REPLY_BATCH {
            return Err(Error::Invalid("reply batch bound"));
        }
        for plan in &plans {
            validate_plan(plan)?;
        }
        if serde_json::to_writer(&mut ResultBudget(MAX_RESULT_BYTES), &plans).is_err() {
            return Err(Error::Capacity);
        }
        let gate = self.principal_gate(&scope.principal).await;
        let _guard = gate.read().await;
        let host = self.host_id.clone();
        let check = scope.clone();
        let (principal, binding) = self
            .store
            .transaction(move |tx| scope_in_transaction(tx, &host, &check))
            .await?;
        if !self.reply_host_scope(&binding).await? {
            return Err(Error::Unauthorized);
        }
        let host = self.host_id.clone();
        self.store.transaction(move |tx| {
            if let Some(lease)=&lease {current_lease(tx,lease)?;}
            let (current,current_binding)=scope_in_transaction(tx,&host,&scope)?;
            if current!=principal || current_binding!=binding { return Err(Error::Unauthorized); }
            if let Some(advance)=&projection {advance.verify(tx,&host,&scope,&principal,&binding)?;}
            let account=Account {channel:scope.sender.channel.clone(),id:scope.sender.account.clone()};
            let route=route_key(&scope.sender,&binding.conversation);
            let mut records=Vec::with_capacity(plans.len());
            let mut seen=std::collections::HashSet::new();
            for plan in plans {
                let key=digest(&json!(["reply-v1",host,scope.sender,binding.conversation,plan.id]));
                if !seen.insert(key.clone()) { return Err(Error::IdentityConflict); }
                if let Some(old)=load(tx,&key)? {
                    if old.plan!=plan || old.principal!=principal.id || old.binding!=binding
                        || old.principal_revision!=principal.revision { return Err(Error::IdentityConflict); }
                    records.push(old);continue;
                }
                let pending:usize=tx.query_row("SELECT COUNT(*) FROM outbox WHERE state IN ('pending','sending','uncertain')",[],|r|r.get(0))?;
                let retained:usize=tx.query_row("SELECT COUNT(*) FROM outbox",[],|r|r.get(0))?;
                if pending>=MAX_PENDING || retained>=MAX_RECORDS { return Err(Error::Capacity); }
                let mut record=Outgoing {sequence:0,key,account:account.clone(),sender:scope.sender.clone(),principal:principal.id.clone(),
                    principal_revision:principal.revision,binding:binding.clone(),plan,state:ReplyState::Pending,
                    attempts:0,sending_generation:None,not_before_ms:0,expected_message:None,receipt:None,failure:None};
                // Validate edit provenance before committing any new record.
                replacement(tx,&record)?;
                tx.execute("INSERT INTO outbox(key,account,route,state,not_before,body) VALUES (?1,?2,?3,'pending',0,'{}')",
                    params![record.key,account_key(&account),route])?;
                record.sequence=tx.last_insert_rowid();save(tx,&record)?;records.push(record);
            }
            if let Some(advance)=projection {advance.commit(tx,&records)?;}
            Ok(records)
        }).await
    }
    // The same bounded scope fence applies before enqueue/send. An unavailable
    // Host must not retain revoke/account-takeover gates indefinitely.
    pub(crate) async fn reply_host_scope(&self, binding: &Binding) -> Result<bool, Error> {
        tokio::time::timeout(
            SCOPE_DEADLINE,
            self.host
                .session_in_workspace(&binding.workspace, &binding.session),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)
    }
    /// Trusted service/admin read. No unauthenticated transport route is mounted.
    pub async fn inspect_reply(&self, key: &str) -> Result<Option<Outgoing>, Error> {
        let key = key.to_owned();
        self.store.transaction(move |tx| load(tx, &key)).await
    }
    pub async fn pending_replies(&self, lease: &AccountLease) -> Result<Vec<Outgoing>, Error> {
        let lease = lease.clone();
        let now = now_ms();
        self.store.transaction(move |tx| {
            current_lease(tx,&lease)?;
            let mut q=tx.prepare("SELECT body FROM outbox AS current WHERE account=?1
                AND state IN ('pending','sending') AND not_before<=?2
                AND NOT EXISTS(SELECT 1 FROM outbox AS earlier WHERE earlier.route=current.route
                    AND earlier.seq<current.seq AND earlier.state IN ('pending','sending','uncertain')) ORDER BY seq LIMIT 32")?;
            let rows=q.query_map(params![account_key(&lease.account),now],|r|r.get::<_,String>(0))?;
            rows.map(|r|Ok(serde_json::from_str(&r?)?)).collect()
        }).await
    }
    /// No Host task dispatch occurs here. Hold account/principal read fences
    /// through a bounded provider operation; revoke/takeover linearize after it.
    /// Worker shutdown can interrupt the send, but then its outcome is uncertain.
    pub async fn deliver_reply(
        &self,
        lease: AccountLease,
        key: &str,
        transport: Arc<dyn ReplyTransport>,
        shutdown: CancellationToken,
    ) -> Result<Outgoing, Error> {
        if transport.account() != &lease.account {
            return Err(Error::Unauthorized);
        }
        let initial = self
            .inspect_reply(key)
            .await?
            .ok_or(Error::Invalid("unknown reply"))?;
        if initial.account != lease.account {
            return Err(Error::Unauthorized);
        }
        let route_gate = self
            .reply_gate(&route_key(&initial.sender, &initial.binding.conversation))
            .await;
        let _route_guard = route_gate.lock().await;
        let account_gate = self.account_gate(&lease.account).await;
        let _account_guard = account_gate.read().await;
        let gate = self.principal_gate(&initial.principal).await;
        let _guard = gate.read().await;
        let host = self.host_id.clone();
        let key = key.to_owned();
        let operation_lease = lease.clone();
        let mut record=self.store.transaction(move |tx| {
            current_lease(tx,&operation_lease)?;
            let mut r=load(tx,&key)?.ok_or(Error::Invalid("unknown reply"))?;
            if !matches!(r.state,ReplyState::Pending|ReplyState::Sending) {return Ok(r);}
            let earlier:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE route=?1 AND seq<?2 AND state IN ('pending','sending','uncertain'))",
                params![route_key(&r.sender,&r.binding.conversation),r.sequence],|row|row.get(0))?;
            if earlier {return Err(Error::ReplyBlocked);}
            if r.state==ReplyState::Sending {
                if r.sending_generation==Some(operation_lease.generation) {return Err(Error::ReplyBusy);}
                r.state=ReplyState::Uncertain;r.failure=Some(ReplyFailure::Interrupted);save(tx,&r)?;return Ok(r);
            }
            if r.not_before_ms>now_ms() {return Err(Error::ReplyDeferred);}
            let scope=subscription(&r);
            let authorized=scope_in_transaction(tx,&host,&scope).is_ok_and(|(p,b)|p.revision==r.principal_revision&&b==r.binding);
            if !authorized {r.state=ReplyState::Rejected;r.failure=Some(ReplyFailure::ScopeChanged);save(tx,&r)?;}
            Ok(r)
        }).await?;
        if record.state != ReplyState::Pending {
            return Ok(record);
        }
        if shutdown.is_cancelled() {
            return Ok(record);
        } // Never mark an unstarted operation uncertain.
        if !self.reply_host_scope(&record.binding).await? {
            record.state = ReplyState::Rejected;
            record.failure = Some(ReplyFailure::ScopeChanged);
            return self.persist_reply(record, &lease).await;
        }
        // Resolve before claiming a send. Missing/unsupported media remains a
        // visible pending failure, never a provider effect or task replay.
        let attachment = if let Some(reference) = &record.plan.body.attachment {
            Some(
                self.resolve_outgoing_attachment(&record.binding, reference)
                    .await?,
            )
        } else {
            None
        };
        if shutdown.is_cancelled() {
            return Ok(record);
        }
        let claim = record.clone();
        let claim_lease = lease.clone();
        record = self
            .store
            .transaction(move |tx| {
                current_lease(tx, &claim_lease)?;
                let mut r = load(tx, &claim.key)?.ok_or(Error::Invalid("unknown reply"))?;
                if r != claim {
                    return Err(Error::IdentityConflict);
                }
                if r.attempts >= MAX_SEND_ATTEMPTS {
                    r.state = ReplyState::Rejected;
                    r.failure = Some(ReplyFailure::RetryExhausted);
                } else {
                    r.expected_message = replacement(tx, &r)?;
                    r.attempts += 1;
                    r.sending_generation = Some(claim_lease.generation);
                    r.state = ReplyState::Sending;
                }
                save(tx, &r)?;
                Ok(r)
            })
            .await?;
        if record.state != ReplyState::Sending {
            return Ok(record);
        }
        let request = SendRequest {
            account: record.account.clone(),
            sender: record.sender.clone(),
            conversation: record.binding.conversation.clone(),
            body: record.plan.body.clone(),
            replace_message: record.expected_message.clone(),
            attachment,
        };
        let outcome = tokio::select! {
            biased;
            _=shutdown.cancelled()=>SendOutcome::Uncertain,
            outcome=tokio::time::timeout(SEND_DEADLINE,transport.send(request))=>outcome.unwrap_or(SendOutcome::Uncertain),
        };
        match outcome {
            SendOutcome::Delivered(receipt)
                if valid_id(&receipt.message_id).is_ok()
                    && record
                        .expected_message
                        .as_ref()
                        .is_none_or(|expected| expected == &receipt.message_id) =>
            {
                record.receipt = Some(receipt);
                record.state = ReplyState::Delivered;
                record.failure = None;
            }
            SendOutcome::Delivered(_) => {
                record.state = ReplyState::Uncertain;
                record.failure = Some(ReplyFailure::InvalidReceipt);
            }
            SendOutcome::Rejected(failure)
                if matches!(
                    failure,
                    ReplyFailure::InvalidInput
                        | ReplyFailure::InvalidCredentials
                        | ReplyFailure::Forbidden
                        | ReplyFailure::Unsupported
                        | ReplyFailure::TargetGone
                        | ReplyFailure::ProviderRejected
                ) =>
            {
                record.state = ReplyState::Rejected;
                record.failure = Some(failure);
            }
            SendOutcome::Rejected(_) => {
                record.state = ReplyState::Uncertain;
                record.failure = Some(ReplyFailure::InvalidReceipt);
            }
            SendOutcome::RetryAfter { seconds } => {
                record.not_before_ms =
                    now_ms().saturating_add(u64::from(seconds.clamp(1, 3600)) * 1000);
                record.state = ReplyState::Pending;
                record.failure = None;
            }
            SendOutcome::Uncertain => {
                record.state = ReplyState::Uncertain;
                record.failure = Some(ReplyFailure::ProviderUncertain);
            }
        }
        self.persist_reply(record, &lease).await
    }
    async fn persist_reply(
        &self,
        record: Outgoing,
        lease: &AccountLease,
    ) -> Result<Outgoing, Error> {
        let lease = lease.clone();
        self.store
            .transaction(move |tx| {
                current_lease(tx, &lease)?;
                save(tx, &record)?;
                Ok(record)
            })
            .await
    }
    /// Independent serial account sender. Its cancellation never reaches Agent
    /// admission. Ambiguity fences this conversation, not independent recipients.
    pub async fn run_replies(
        self: Arc<Self>,
        lease: AccountLease,
        transport: Arc<dyn ReplyTransport>,
        shutdown: CancellationToken,
    ) -> Result<(), Error> {
        let mut tick = tokio::time::interval(Duration::from_millis(200));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {biased;_=shutdown.cancelled()=>return Ok(()),_=tick.tick()=>{}}
            for record in self.pending_replies(&lease).await? {
                if shutdown.is_cancelled() {
                    return Ok(());
                }
                match self
                    .deliver_reply(
                        lease.clone(),
                        &record.key,
                        transport.clone(),
                        shutdown.clone(),
                    )
                    .await
                {
                    Ok(_) | Err(Error::ReplyBlocked | Error::ReplyDeferred | Error::ReplyBusy) => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
fn route_key(sender: &Sender, conversation: &str) -> String {
    digest(&json!(["reply-route-v1", sender, conversation]))
}
fn subscription(r: &Outgoing) -> Subscription {
    Subscription {
        principal: r.principal.clone(),
        sender: r.sender.clone(),
        conversation: r.binding.conversation.clone(),
        binding: r.binding.id.clone(),
        generation: r.binding.generation,
    }
}
pub(crate) fn validate_plan(plan: &ReplyPlan) -> Result<(), Error> {
    valid_id(&plan.id)?;
    if (plan.body.text.is_empty() && plan.body.attachment.is_none())
        || plan.body.text.len() > 128 * 1024
        || plan.body.text.contains('\0')
    {
        return Err(Error::Invalid("reply text bound"));
    }
    if let Some(media) = &plan.body.attachment {
        valid_digest(&media.id)?;
        if !plan.body.buttons.is_empty()
            || plan.replace_of.is_some()
            || plan.body.text.encode_utf16().count() > 1024
        {
            return Err(Error::Invalid("media caption/keyboard/edit"));
        }
    }
    if plan.body.buttons.len() > 16 || plan.body.buttons.iter().map(Vec::len).sum::<usize>() > 64 {
        return Err(Error::Invalid("reply keyboard bound"));
    }
    for button in plan.body.buttons.iter().flatten() {
        valid_id(&button.label)?;
        if button.label.encode_utf16().count() > 64
            || button.ticket.is_empty()
            || button.ticket.len() > 64
            || button.ticket.chars().any(char::is_control)
        {
            return Err(Error::Invalid("reply button bound"));
        }
    }
    if let Some(key) = &plan.replace_of {
        let hash = key
            .strip_prefix("remote-v1-")
            .ok_or(Error::Invalid("reply record identity"))?;
        valid_digest(hash)?;
    }
    Ok(())
}
fn replacement(tx: &Transaction<'_>, r: &Outgoing) -> Result<Option<String>, Error> {
    let Some(key) = &r.plan.replace_of else {
        return Ok(None);
    };
    let old = load(tx, key)?.ok_or(Error::Invalid("unknown replacement reply"))?;
    if old.state != ReplyState::Delivered
        || old.principal != r.principal
        || old.principal_revision != r.principal_revision
        || old.binding != r.binding
        || old.sender != r.sender
        || old.plan.body.attachment.is_some()
    {
        return Err(Error::Unauthorized);
    }
    Ok(Some(
        old.receipt
            .ok_or(Error::Invalid("missing provider receipt"))?
            .message_id,
    ))
}
fn load(tx: &Transaction<'_>, key: &str) -> Result<Option<Outgoing>, Error> {
    let raw: Option<String> = tx
        .query_row("SELECT body FROM outbox WHERE key=?1", [key], |r| r.get(0))
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Error::from))
        .transpose()
}
fn save(tx: &Transaction<'_>, r: &Outgoing) -> Result<(), Error> {
    tx.execute(
        "UPDATE outbox SET state=?1,not_before=?2,body=?3 WHERE key=?4",
        params![
            r.state.wire(),
            r.not_before_ms,
            serde_json::to_string(r)?,
            r.key
        ],
    )?;
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplyReview {
    pub key: String,
    pub actor: String,
    pub evidence_sha256: String,
    pub resolution: ReplyResolution,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReplyResolution {
    ObservedDelivered { receipt: ProviderReceipt },
    VerifiedNotSent,
    AbandonWithoutReplay,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyAudit {
    pub sequence: i64,
    pub review: ReplyReview,
    pub previous: ReplyState,
    pub current: ReplyState,
}
impl Gateway {
    /// Bounded trusted recovery read; no platform/controller ingress route.
    pub async fn reply_audit(&self, key: &str) -> Result<Vec<ReplyAudit>, Error> {
        let key = key.to_owned();
        self.store
            .transaction(move |tx| {
                let mut query =
                    tx.prepare("SELECT body FROM reply_audit WHERE key=?1 ORDER BY seq LIMIT 100")?;
                let rows = query.query_map([key], |r| r.get::<_, String>(0))?;
                rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
            })
            .await
    }
    /// Trusted desktop recovery only, with observed evidence and no retry option.
    pub async fn resolve_reply(&self, review: ReplyReview) -> Result<ReplyAudit, Error> {
        valid_id(&review.actor)?;
        valid_digest(&review.evidence_sha256)?;
        if let ReplyResolution::ObservedDelivered { receipt } = &review.resolution {
            valid_id(&receipt.message_id)?;
        }
        let initial = self
            .inspect_reply(&review.key)
            .await?
            .ok_or(Error::Invalid("unknown reply"))?;
        let gate = self
            .reply_gate(&route_key(&initial.sender, &initial.binding.conversation))
            .await;
        let _guard = gate.lock().await;
        self.store
            .transaction(move |tx| {
                let mut record = load(tx, &review.key)?.ok_or(Error::Invalid("unknown reply"))?;
                let old: Option<String> = tx
                    .query_row(
                        "SELECT body FROM reply_audit WHERE key=?1 ORDER BY seq DESC LIMIT 1",
                        [&review.key],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(old) = old {
                    let audit: ReplyAudit = serde_json::from_str(&old)?;
                    return if audit.review == review {
                        Ok(audit)
                    } else {
                        Err(Error::IdentityConflict)
                    };
                }
                if record.state != ReplyState::Uncertain {
                    return Err(Error::Invalid("only uncertain reply may be resolved"));
                }
                match &review.resolution {
                    ReplyResolution::ObservedDelivered { receipt } => {
                        if record
                            .expected_message
                            .as_ref()
                            .is_some_and(|id| id != &receipt.message_id)
                        {
                            return Err(Error::IdentityConflict);
                        }
                        record.state = ReplyState::Delivered;
                        record.receipt = Some(receipt.clone());
                        record.failure = None;
                    }
                    ReplyResolution::VerifiedNotSent => {
                        record.state = ReplyState::Rejected;
                        record.failure = Some(ReplyFailure::ManuallyNotSent);
                    }
                    ReplyResolution::AbandonWithoutReplay => {
                        record.state = ReplyState::Abandoned;
                        record.failure = Some(ReplyFailure::ManuallyAbandoned);
                    }
                }
                save(tx, &record)?;
                let mut audit = ReplyAudit {
                    sequence: 0,
                    review,
                    previous: ReplyState::Uncertain,
                    current: record.state,
                };
                tx.execute(
                    "INSERT INTO reply_audit(key,body) VALUES (?1,'{}')",
                    [&audit.review.key],
                )?;
                audit.sequence = tx.last_insert_rowid();
                tx.execute(
                    "UPDATE reply_audit SET body=?1 WHERE seq=?2",
                    params![serde_json::to_string(&audit)?, audit.sequence],
                )?;
                Ok(audit)
            })
            .await
    }
}
