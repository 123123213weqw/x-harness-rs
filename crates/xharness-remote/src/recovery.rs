//! Trusted desktop-only recovery: terminal observations, never automatic replay.
use crate::{gateway::valid_id, receive::valid_digest, store, *};
use rusqlite::params;
use serde_json::json;
use xharness_api::RpcResult;

impl Gateway {
    /// Resolve exactly the persisted uncertain operation after external/manual
    /// verification. Evidence is a digest (not secret content). The state change
    /// and append-only audit record commit atomically. Controller ingress cannot
    /// call this method, and no resolution authorizes an automatic retry.
    pub async fn resolve_uncertain(&self, review: RecoveryReview) -> Result<RecoveryAudit, Error> {
        self.resolve_uncertain_checked(review, None).await
    }
    pub(crate) async fn resolve_uncertain_checked(
        &self,
        review: RecoveryReview,
        expected: Option<InboxRecoveryIdentity>,
    ) -> Result<RecoveryAudit, Error> {
        valid_id(&review.actor)?;
        valid_digest(&review.evidence_sha256)?;
        let initial = self
            .inspect(&review.delivery_key)
            .await?
            .ok_or(Error::Invalid("unknown request"))?;
        let gate = self.session_gate(&initial.binding.session).await;
        let _guard = gate.lock().await;
        self.store
            .transaction(move |tx| {
                let mut d = store::delivery(tx, &review.delivery_key)?
                    .ok_or(Error::Invalid("unknown request"))?;
                if expected
                    .as_ref()
                    .is_some_and(|e| e != &InboxRecoveryIdentity::for_delivery(&d))
                {
                    return Err(Error::IdentityConflict);
                }
                let old: Option<String> = tx
                    .query_row(
                        "SELECT body FROM recovery_audit WHERE key=?1 ORDER BY seq DESC LIMIT 1",
                        [&review.delivery_key],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(raw) = old {
                    let audit: RecoveryAudit = serde_json::from_str(&raw)?;
                    if audit.review == review {
                        return Ok(audit);
                    }
                    return Err(Error::IdentityConflict);
                }
                if d.state != DeliveryState::Uncertain {
                    return Err(Error::Invalid("only uncertain delivery may be resolved"));
                }
                if matches!(
                    d.inbound.command,
                    Command::CreateSession { .. } | Command::AutomationControl { .. }
                ) && review.resolution == RecoveryResolution::ObservedAccepted
                {
                    return Err(Error::Invalid(
                        "mutation requires original native proof, not a manual accepted result",
                    ));
                }
                // Every review keeps the original native instance sealed, even
                // verified-not-applied. It never remints a handle or answers Host.
                crate::tickets::seal_reviewed(tx, &d)?;
                d.state = match review.resolution {
                    RecoveryResolution::ObservedAccepted => DeliveryState::Completed,
                    RecoveryResolution::VerifiedNotApplied => DeliveryState::Rejected,
                    RecoveryResolution::AbandonWithoutReplay => DeliveryState::Abandoned,
                };
                d.result = match review.resolution {
                    RecoveryResolution::ObservedAccepted => Some(RpcResult::success(
                        json!({"accepted":true,"reconciled":true}),
                    )),
                    _ => None,
                };
                d.reason = Some(
                    match review.resolution {
                        RecoveryResolution::ObservedAccepted => "manually-observed-accepted",
                        RecoveryResolution::VerifiedNotApplied => "manually-verified-not-applied",
                        RecoveryResolution::AbandonWithoutReplay => "abandoned-without-replay",
                    }
                    .into(),
                );
                store::save(tx, &d)?;
                let mut audit = RecoveryAudit {
                    sequence: 0,
                    review,
                    previous: DeliveryState::Uncertain,
                    current: d.state,
                };
                tx.execute(
                    "INSERT INTO recovery_audit(key,body) VALUES (?1,'{}')",
                    [&audit.review.delivery_key],
                )?;
                audit.sequence = tx.last_insert_rowid();
                tx.execute(
                    "UPDATE recovery_audit SET body=?1 WHERE seq=?2",
                    params![serde_json::to_string(&audit)?, audit.sequence],
                )?;
                Ok(audit)
            })
            .await
    }

    pub async fn recovery_audit(&self, key: &str) -> Result<Vec<RecoveryAudit>, Error> {
        let key = key.to_owned();
        self.store
            .transaction(move |tx| {
                let mut query = tx.prepare(
                    "SELECT body FROM recovery_audit WHERE key=?1 ORDER BY seq LIMIT 100",
                )?;
                let rows = query.query_map([key], |r| r.get::<_, String>(0))?;
                rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
            })
            .await
    }
}
use rusqlite::OptionalExtension;
