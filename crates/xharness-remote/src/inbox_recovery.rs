//! Metadata-only trusted desktop recovery. No native replay capability.
use crate::{
    gateway::{valid_id, ResultBudget},
    receive::valid_digest,
    *,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InboxRecoveryIdentity {
    pub key: String,
    pub sequence: i64,
    pub principal: String,
    pub principal_revision: u64,
    pub binding: Binding,
    pub identity_sha256: String,
}
impl InboxRecoveryIdentity {
    pub(crate) fn for_delivery(d: &Delivery) -> Self {
        Self {
            key: d.key.clone(),
            sequence: d.sequence,
            principal: d.principal.clone(),
            principal_revision: d.principal_revision,
            binding: d.binding.clone(),
            identity_sha256: format!(
                "{:x}",
                Sha256::digest(
                    serde_json::to_vec(&json!([
                        d.key,
                        d.sequence,
                        d.principal,
                        d.principal_revision,
                        d.binding,
                        d.inbound
                    ]))
                    .expect("immutable delivery JSON")
                )
            ),
        }
    }
    pub(crate) fn validate(&self) -> Result<(), Error> {
        valid_id(&self.key)?;
        valid_digest(&self.identity_sha256)?;
        for id in [
            &self.principal,
            &self.binding.id,
            &self.binding.principal,
            &self.binding.conversation,
            &self.binding.workspace,
            &self.binding.session,
        ] {
            valid_id(id)?;
        }
        if self.sequence <= 0
            || self.principal_revision == 0
            || self.binding.generation == 0
            || self.binding.principal != self.principal
        {
            return Err(Error::Invalid("inbox recovery identity"));
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxCommand {
    Prompt,
    Cancel,
    History,
    Catalogue,
    Select,
    CreateSession,
    AutomationRead,
    AutomationControl,
    AnswerInteraction,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InboxInteractionKind {
    Approval,
    Question,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InboxRecoveryEntry {
    pub identity: InboxRecoveryIdentity,
    pub command: InboxCommand,
    pub interaction: Option<InboxInteractionKind>,
    pub observed_accepted_allowed: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InboxRecoveryPage {
    pub items: Vec<InboxRecoveryEntry>,
    pub next: Option<i64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InboxRecoveryReceipt {
    pub identity: InboxRecoveryIdentity,
    pub audit: RecoveryAudit,
}
impl Gateway {
    /// Closed metadata only. No input text, answer, ticket handle, nonce, native
    /// frame, raw reason or model/tool response is copied into this page.
    pub async fn uncertain_inbox(&self, after: i64) -> Result<InboxRecoveryPage, Error> {
        if after < 0 {
            return Err(Error::Invalid("inbox recovery cursor"));
        }
        self.store.transaction(move |tx| {
            let mut query=tx.prepare("SELECT body FROM inbox WHERE state='uncertain' AND seq>?1 ORDER BY seq LIMIT 26")?;
            let rows=query.query_map([after],|r|r.get::<_,String>(0))?;
            let mut records=rows.map(|r|Ok(serde_json::from_str::<Delivery>(&r?)?)).collect::<Result<Vec<_>,Error>>()?;
            let next=if records.len()>25 {records.pop();records.last().map(|d|d.sequence)} else {None};
            let items=records.iter().map(|d| {
                let identity=InboxRecoveryIdentity::for_delivery(d);identity.validate()?;
                let command=match d.inbound.command {Command::Prompt {..}=>InboxCommand::Prompt,Command::Cancel=>InboxCommand::Cancel,Command::History {..}=>InboxCommand::History,Command::Catalogue {..}=>InboxCommand::Catalogue,Command::Select {..}=>InboxCommand::Select,Command::CreateSession {..}=>InboxCommand::CreateSession,Command::AutomationRead {..}=>InboxCommand::AutomationRead,Command::AutomationControl {..}=>InboxCommand::AutomationControl,Command::AnswerInteraction {..}=>InboxCommand::AnswerInteraction};
                let interaction=crate::tickets::recovery_kind(tx,d)?;
                Ok(InboxRecoveryEntry {identity,command,interaction,observed_accepted_allowed:!matches!(command,InboxCommand::CreateSession|InboxCommand::AutomationControl)})
            }).collect::<Result<Vec<_>,Error>>()?;
            let page=InboxRecoveryPage {items,next};
            if serde_json::to_writer(&mut ResultBudget(MAX_RESULT_BYTES),&page).is_err(){return Err(Error::Capacity);}Ok(page)
        }).await
    }
    /// Identity CAS is checked in the same transaction as the append-only audit
    /// and ticket seal. A stale view cannot reconcile another mutable request.
    pub async fn resolve_inbox(
        &self,
        expected: InboxRecoveryIdentity,
        review: RecoveryReview,
    ) -> Result<InboxRecoveryReceipt, Error> {
        expected.validate()?;
        if review.delivery_key != expected.key {
            return Err(Error::IdentityConflict);
        }
        let audit = self
            .resolve_uncertain_checked(review, Some(expected.clone()))
            .await?;
        Ok(InboxRecoveryReceipt {
            identity: expected,
            audit,
        })
    }
}
