//! Opaque scoped single-use interaction handles. Not controller credentials;
//! durable private inbox/outbox may retain handles; Debug always redacts them.
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
    gateway::{valid_id, ResultBudget},
    store,
    subscription::scope_in_transaction,
    *,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use xharness_api::{RpcId, RpcResult, ScopedInteraction, ScopedInteractionReceipt};
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct TicketToken(String);
impl TicketToken {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for TicketToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TicketToken([REDACTED])")
    }
}
impl TryFrom<String> for TicketToken {
    type Error = &'static str;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        if value.len() != 48
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("invalid interaction handle");
        }
        Ok(Self(value))
    }
}
impl From<TicketToken> for String {
    fn from(t: TicketToken) -> Self {
        t.0
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InteractionTicket {
    pub token: TicketToken,
    pub expires_at_ms: u64,
    pub interaction: ScopedInteraction,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum State {
    Issued,
    Dispatching,
    Accepted,
    Stale,
    Invalid,
    Uncertain,
    Expired,
    Reviewed,
}
impl State {
    fn wire(self) -> &'static str {
        match self {
            Self::Issued => "issued",
            Self::Dispatching => "dispatching",
            Self::Accepted => "accepted",
            Self::Stale => "stale",
            Self::Invalid => "invalid",
            Self::Uncertain => "uncertain",
            Self::Expired => "expired",
            Self::Reviewed => "reviewed",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Record {
    token: TicketToken,
    scope: Subscription,
    revision: u64,
    instance: String,
    interaction: ScopedInteraction,
    issued_at_ms: u64,
    expires_at_ms: u64,
    state: State,
    delivery: Option<String>,
}
fn now() -> Result<u64, Error> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::HostUnavailable)?
        .as_millis()
        .try_into()
        .map_err(|_| Error::HostUnavailable)
}
fn ticket_time(tx: &rusqlite::Transaction<'_>) -> Result<u64, Error> {
    ticket_time_at(tx, now()?)
}
fn ticket_time_at(tx: &rusqlite::Transaction<'_>, observed: u64) -> Result<u64, Error> {
    let previous: Option<u64> = store::entity(tx, "interaction-clock", "watermark")?;
    if previous.is_some_and(|previous| observed < previous) {
        // A local wall-clock rollback cannot revive an expired handle. Do not
        // clamp it (which would freeze and extend expiry); fail closed instead.
        return Err(Error::HostUnavailable);
    }
    store::put_entity(tx, "interaction-clock", "watermark", &observed)?;
    Ok(observed)
}
fn key(token: &TicketToken) -> String {
    crate::gateway::digest(&serde_json::json!([token.as_str()]))
}
fn put(tx: &rusqlite::Transaction<'_>, r: &Record) -> Result<(), Error> {
    tx.execute(
        "UPDATE interaction_tickets SET state=?1,body=?2 WHERE id=?3",
        params![r.state.wire(), serde_json::to_string(r)?, key(&r.token)],
    )?;
    Ok(())
}
fn load(tx: &rusqlite::Transaction<'_>, t: &TicketToken) -> Result<Option<Record>, Error> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT body FROM interaction_tickets WHERE id=?1",
            [key(t)],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|v| serde_json::from_str(&v).map_err(Error::from))
        .transpose()
}
fn recovery_record(tx: &rusqlite::Transaction<'_>, d: &Delivery) -> Result<Option<Record>, Error> {
    let Command::AnswerInteraction { ticket, .. } = &d.inbound.command else {
        return Ok(None);
    };
    let r = load(tx, ticket)?.ok_or(Error::IdentityConflict)?;
    let fence: Option<(String, String)> = tx
        .query_row(
            "SELECT state,delivery FROM interaction_fences WHERE instance=?1",
            [&r.instance],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if r.delivery.as_deref() != Some(&d.key)
        || r.scope.principal != d.principal
        || r.revision != d.principal_revision
        || r.scope.binding != d.binding.id
        || r.scope.generation != d.binding.generation
        || r.scope.conversation != d.binding.conversation
        || r.interaction.frame.payload["sessionId"].as_str() != Some(&d.binding.session)
        || !matches!(
            r.state,
            State::Dispatching | State::Uncertain | State::Reviewed
        )
        || !fence.as_ref().is_some_and(|(state, owner)| {
            owner == &d.key && matches!(state.as_str(), "dispatching" | "uncertain" | "reviewed")
        })
    {
        return Err(Error::IdentityConflict);
    }
    Ok(Some(r))
}
pub(crate) fn recovery_kind(
    tx: &rusqlite::Transaction<'_>,
    d: &Delivery,
) -> Result<Option<InboxInteractionKind>, Error> {
    let Some(r) = recovery_record(tx, d)? else {
        return Ok(None);
    };
    validate_snapshot(
        &r.interaction,
        &d.binding.session,
        &r.interaction.frame.rpc_id,
    )?;
    let kind = match r.interaction.frame.method.as_str() {
        "approval/requested" => InboxInteractionKind::Approval,
        "question/requested" => InboxInteractionKind::Question,
        _ => return Err(Error::IdentityConflict),
    };
    Ok(Some(kind))
}
pub(crate) fn seal_reviewed(tx: &rusqlite::Transaction<'_>, d: &Delivery) -> Result<(), Error> {
    let Some(mut r) = recovery_record(tx, d)? else {
        return Ok(());
    };
    r.state = State::Reviewed;
    put(tx, &r)?;
    let changed = tx.execute(
        "UPDATE interaction_fences SET state='reviewed' WHERE instance=?1 AND delivery=?2",
        params![r.instance, d.key],
    )?;
    if changed != 1 {
        return Err(Error::IdentityConflict);
    }
    Ok(())
}
impl Gateway {
    /// Trusted projection/channel composition supplies verified sender/scope and
    /// a native stream RPC id. A controller never supplies a raw Host snapshot.
    pub async fn mint_interaction_ticket(
        &self,
        scope: Subscription,
        id: RpcId,
        ttl_seconds: u16,
    ) -> Result<InteractionTicket, Error> {
        if ttl_seconds == 0 || ttl_seconds > 600 {
            return Err(Error::Invalid("interaction expiry"));
        }
        valid_id(id.as_str())?;
        let gate = self.principal_gate(&scope.principal).await;
        let _guard = gate.read().await;
        let check = scope.clone();
        let host = self.host_id.clone();
        let (principal, binding) = self
            .store
            .transaction(move |tx| scope_in_transaction(tx, &host, &check))
            .await?;
        let interaction = tokio::time::timeout(
            Duration::from_secs(2),
            self.host
                .session_interaction(&binding.workspace, &binding.session, &id),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?
        .ok_or(Error::Invalid("interaction is not pending"))?;
        validate_snapshot(&interaction, &binding.session, &id)?;
        let instance = crate::gateway::digest(&serde_json::json!([
            self.host_id,
            binding.workspace,
            binding.session,
            id.as_str(),
            interaction.nonce
        ]));
        let scope_key = crate::gateway::digest(&serde_json::json!([scope, principal.revision]));
        self.store.transaction(move|tx|{
            let time=ticket_time(tx)?;
            let deadline=time.checked_add(u64::from(ttl_seconds)*1000).ok_or(Error::Capacity)?;
            // One native instance is consumed globally, even across controllers.
            let fence:Option<String>=tx.query_row("SELECT state FROM interaction_fences WHERE instance=?1",[&instance],|r|r.get(0)).optional()?;
            if fence.is_some_and(|state|state!="invalid"){return Err(Error::IdentityConflict);}
            let old:Option<String>=tx.query_row("SELECT body FROM interaction_tickets WHERE instance=?1 AND scope=?2 AND state='issued' AND expires>?3 ORDER BY rowid DESC LIMIT 1",params![instance,scope_key,time],|r|r.get(0)).optional()?;
            if let Some(raw)=old{
                let old:Record=serde_json::from_str(&raw)?;
                if old.issued_at_ms<=time && old.interaction==interaction{return Ok(InteractionTicket{token:old.token,expires_at_ms:old.expires_at_ms,interaction});}
            }
            let count:usize=tx.query_row("SELECT COUNT(*) FROM interaction_tickets",[],|r|r.get(0))?;
            if count>=MAX_RECORDS{return Err(Error::Capacity);}
            let mut bytes=[0u8;24];getrandom::fill(&mut bytes).map_err(|_|Error::HostUnavailable)?;
            let token=TicketToken(bytes.iter().map(|b|format!("{b:02x}")).collect());
            let record=Record{token:token.clone(),scope,revision:principal.revision,instance:instance.clone(),interaction:interaction.clone(),issued_at_ms:time,expires_at_ms:deadline,state:State::Issued,delivery:None};
            tx.execute("INSERT INTO interaction_tickets(id,instance,scope,state,expires,body) VALUES(?1,?2,?3,'issued',?4,?5)",params![key(&token),instance,scope_key,deadline,serde_json::to_string(&record)?])?;
            Ok(InteractionTicket{token,expires_at_ms:deadline,interaction})
        }).await
    }
    /// Scoped read for channel formatting/choice normalization. The handle
    /// alone is never authority, and raw native RPC/result input is not accepted.
    pub async fn interaction_ticket_for(
        &self,
        scope: Subscription,
        token: TicketToken,
    ) -> Result<InteractionTicket, Error> {
        let gate = self.principal_gate(&scope.principal).await;
        let _guard = gate.read().await;
        let host = self.host_id.clone();
        let found = self
            .store
            .transaction(move |tx| {
                let (p, b) = scope_in_transaction(tx, &host, &scope)?;
                let mut r = load(tx, &token)?.ok_or(Error::Unauthorized)?;
                let time = ticket_time(tx)?;
                if r.scope != scope || r.revision != p.revision || r.state != State::Issued {
                    return Err(Error::Unauthorized);
                }
                if time < r.issued_at_ms || time >= r.expires_at_ms {
                    r.state = State::Expired;
                    put(tx, &r)?;
                    return Ok(None);
                }
                Ok(Some((
                    InteractionTicket {
                        token: r.token,
                        expires_at_ms: r.expires_at_ms,
                        interaction: r.interaction,
                    },
                    b,
                )))
            })
            .await?;
        let (ticket, binding) = found.ok_or(Error::Unauthorized)?;
        if !tokio::time::timeout(
            Duration::from_secs(2),
            self.host
                .session_in_workspace(&binding.workspace, &binding.session),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?
        {
            return Err(Error::Unauthorized);
        }
        Ok(ticket)
    }

    /// Called under existing per-session + principal fences. Never the generic
    /// RPC/respond path. Full-commit claim precedes a possible native effect.
    pub(crate) async fn dispatch_interaction(&self, mut d: Delivery) -> Result<Delivery, Error> {
        let Command::AnswerInteraction { ticket, answer } = &d.inbound.command else {
            return Err(Error::Invalid("not an interaction answer"));
        };
        let token = ticket.clone();
        let answer = answer.clone();
        if d.state == DeliveryState::Dispatching {
            return self.finish_interaction(d, State::Uncertain, None).await;
        }
        let lookup = token.clone();
        let (record, time) = self
            .store
            .transaction(move |tx| Ok((load(tx, &lookup)?, ticket_time(tx)?)))
            .await?;
        let Some(record) = record else {
            return self
                .reject_interaction(d, "interaction-handle-unknown")
                .await;
        };
        if record.scope.principal != d.principal
            || record.revision != d.principal_revision
            || record.scope.binding != d.binding.id
            || record.scope.generation != d.binding.generation
            || record.scope.conversation != d.binding.conversation
        {
            return self
                .reject_interaction(d, "interaction-scope-changed")
                .await;
        }
        if time < record.issued_at_ms || time >= record.expires_at_ms {
            d.state = DeliveryState::Rejected;
            d.reason = Some("interaction-expired".into());
            return self
                .store
                .transaction(move |tx| {
                    if let Some(mut actual) = load(tx, &record.token)? {
                        if actual.state == State::Issued {
                            actual.state = State::Expired;
                            put(tx, &actual)?;
                        }
                    }
                    store::save(tx, &d)?;
                    Ok(d)
                })
                .await;
        }
        if record.state != State::Issued {
            return self.reject_interaction(d, "interaction-handle-used").await;
        }
        let current = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.session_interaction(
                &d.binding.workspace,
                &d.binding.session,
                &record.interaction.frame.rpc_id,
            ),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if current.as_ref() != Some(&record.interaction) {
            return self
                .reject_interaction(d, "interaction-no-longer-pending")
                .await;
        }
        let mut claimed = record.clone();
        let mut delivery = d.clone();
        let host = self.host_id.clone();
        let claimed_result=self.store.transaction(move|tx|{
            let (p,b)=scope_in_transaction(tx,&host,&claimed.scope)?;
            if p.revision!=claimed.revision||b!=delivery.binding{return Err(Error::Unauthorized);}
            let mut actual=load(tx,&claimed.token)?.ok_or(Error::Unauthorized)?;
            let time=ticket_time(tx)?;
            if actual.state!=State::Issued{return Ok(None);}
            if time<actual.issued_at_ms||time>=actual.expires_at_ms{actual.state=State::Expired;put(tx,&actual)?;return Ok(None);}
            let fence:Option<String>=tx.query_row("SELECT state FROM interaction_fences WHERE instance=?1",[&actual.instance],|r|r.get(0)).optional()?;
            if fence.is_some_and(|state|state!="invalid"){return Ok(None);}
            tx.execute("INSERT INTO interaction_fences(instance,state,delivery) VALUES(?1,'dispatching',?2) ON CONFLICT(instance) DO UPDATE SET state='dispatching',delivery=excluded.delivery",params![actual.instance,delivery.key])?;
            actual.state=State::Dispatching;actual.delivery=Some(delivery.key.clone());put(tx,&actual)?;
            delivery.state=DeliveryState::Dispatching;store::save(tx,&delivery)?;
            claimed=actual;Ok(Some(claimed))
        }).await?;
        let Some(claimed) = claimed_result else {
            return self
                .reject_interaction(d, "interaction-handle-used-or-expired")
                .await;
        };
        d.state = DeliveryState::Dispatching;
        let receipt = tokio::time::timeout(
            Duration::from_secs(30),
            self.host.answer_session_interaction(
                &d.binding.workspace,
                &d.binding.session,
                claimed.interaction,
                answer,
            ),
        )
        .await;
        let (state, result) = match receipt {
            Ok(Ok(ScopedInteractionReceipt::Accepted)) => (
                State::Accepted,
                Some(RpcResult::success(serde_json::json!({"accepted":true}))),
            ),
            Ok(Ok(ScopedInteractionReceipt::Invalid)) => (State::Invalid, None),
            Ok(Ok(ScopedInteractionReceipt::Stale)) => (State::Stale, None),
            _ => (State::Uncertain, None),
        };
        self.finish_interaction(d, state, result).await
    }
    async fn reject_interaction(
        &self,
        mut d: Delivery,
        reason: &'static str,
    ) -> Result<Delivery, Error> {
        d.state = DeliveryState::Rejected;
        d.reason = Some(reason.into());
        self.store
            .transaction(move |tx| {
                store::save(tx, &d)?;
                Ok(d)
            })
            .await
    }
    async fn finish_interaction(
        &self,
        mut d: Delivery,
        state: State,
        result: Option<RpcResult>,
    ) -> Result<Delivery, Error> {
        let Command::AnswerInteraction { ticket, .. } = &d.inbound.command else {
            return Err(Error::Invalid("not an interaction answer"));
        };
        let token = ticket.clone();
        self.store
            .transaction(move |tx| {
                // A crash never replays; only the identical durable owner may finish.
                let mut ticket = load(tx, &token)?.ok_or(Error::IdentityConflict)?;
                if ticket.delivery.as_deref() != Some(&d.key) {
                    return Err(Error::IdentityConflict);
                }
                let owner: Option<String> = tx
                    .query_row(
                        "SELECT delivery FROM interaction_fences WHERE instance=?1",
                        [&ticket.instance],
                        |r| r.get(0),
                    )
                    .optional()?;
                if owner.as_deref() != Some(&d.key) {
                    return Err(Error::IdentityConflict);
                }
                ticket.state = state;
                put(tx, &ticket)?;
                tx.execute(
                    "UPDATE interaction_fences SET state=?1 WHERE instance=?2 AND delivery=?3",
                    params![state.wire(), ticket.instance, d.key],
                )?;
                d.result = result;
                d.state = match state {
                    State::Accepted => DeliveryState::Completed,
                    State::Uncertain => DeliveryState::Uncertain,
                    _ => DeliveryState::Rejected,
                };
                d.reason = match state {
                    State::Accepted => None,
                    State::Invalid => Some("interaction-answer-invalid".into()),
                    State::Stale => Some("interaction-no-longer-pending".into()),
                    _ => Some("interaction-response-uncertain".into()),
                };
                store::save(tx, &d)?;
                Ok(d)
            })
            .await
    }
}
fn validate_snapshot(s: &ScopedInteraction, session: &str, id: &RpcId) -> Result<(), Error> {
    if s.nonce.is_empty()
        || s.nonce.len() > 512
        || s.frame.rpc_id != *id
        || s.frame.payload["sessionId"].as_str() != Some(session)
    {
        return Err(Error::Invalid("unscoped interaction snapshot"));
    }
    valid_id(&s.nonce)?;
    let parsed = serde_json::from_value::<xharness_api::MuxFrame>(s.frame.payload.clone())
        .map_err(|_| Error::Invalid("interaction snapshot shape"))?;
    if parsed.clone().into_server_request(s.frame.rpc_id.clone()) != s.frame {
        return Err(Error::Invalid("noncanonical interaction snapshot"));
    }
    let valid = match Ok::<_, Error>(parsed) {
        Ok(xharness_api::MuxFrame::ApprovalRequested { reviewing, .. }) => {
            s.frame.method == "approval/requested" && reviewing != Some(true)
        }
        Ok(xharness_api::MuxFrame::QuestionRequested { questions, .. }) => {
            s.frame.method == "question/requested"
                && !questions.is_empty()
                && questions.len() <= 32
                && questions
                    .into_iter()
                    .all(|q| serde_json::from_value::<SnapshotQuestion>(q).is_ok_and(|q| q.valid()))
        }
        _ => false,
    };
    if !valid || serde_json::to_writer(&mut ResultBudget(128 * 1024), s).is_err() {
        return Err(Error::Invalid("interaction snapshot shape or budget"));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SnapshotQuestion {
    id: String,
    header: String,
    question: String,
    options: Vec<SnapshotOption>,
    multi_select: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SnapshotOption {
    label: String,
    description: Option<String>,
}
impl SnapshotQuestion {
    fn valid(&self) -> bool {
        valid_id(&self.id).is_ok()
            && !self.header.is_empty()
            && self.header.len() <= 64 * 1024
            && !self.question.is_empty()
            && self.question.len() <= 64 * 1024
            && !self.multi_select
            && self.options.len() <= 32
            && self.options.iter().all(|o| {
                !o.label.is_empty()
                    && o.label.len() <= 4096
                    && o.description.as_ref().is_none_or(|d| d.len() <= 64 * 1024)
            })
    }
}

#[cfg(test)]
mod clock_tests {
    use super::*;
    #[test]
    fn durable_ticket_clock_rejects_rollback_instead_of_reviving_or_extending_handles() {
        let mut connection = rusqlite::Connection::open_in_memory().unwrap();
        connection
            .execute(
                "CREATE TABLE entities(kind TEXT,id TEXT,body TEXT,PRIMARY KEY(kind,id))",
                [],
            )
            .unwrap();
        let tx = connection.transaction().unwrap();
        assert_eq!(ticket_time_at(&tx, 1000).unwrap(), 1000);
        tx.commit().unwrap();
        let tx = connection.transaction().unwrap();
        assert!(matches!(
            ticket_time_at(&tx, 999),
            Err(Error::HostUnavailable)
        ));
        tx.rollback().unwrap();
        let tx = connection.transaction().unwrap();
        assert_eq!(
            store::entity::<u64>(&tx, "interaction-clock", "watermark").unwrap(),
            Some(1000)
        );
        assert_eq!(ticket_time_at(&tx, 2000).unwrap(), 2000);
        tx.commit().unwrap();
        let tx = connection.transaction().unwrap();
        assert!(matches!(
            ticket_time_at(&tx, 1500),
            Err(Error::HostUnavailable)
        ));
        assert_eq!(ticket_time_at(&tx, 2000).unwrap(), 2000);
        tx.commit().unwrap();
    }
}
