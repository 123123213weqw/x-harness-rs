//! Atomic platform disposition + receive checkpoint, with connection fencing.
use crate::{
    gateway::{admit, digest, valid_id, validate_inbound},
    store, *,
};
use serde_json::json;

impl Gateway {
    /// Trusted adapter reconnect/takeover. Kernel journal ownership excludes
    /// another process; generation invalidates all previous adapter instances.
    pub async fn acquire_account(&self, account: Account) -> Result<AccountLease, Error> {
        self.acquire_account_revision(account, None).await
    }

    /// Production account workers must acquire against the exact enabled
    /// settings revision; a slow old credential/identity lookup cannot revive
    /// an account after a disable/rotation transaction.
    pub async fn acquire_configured_account(
        &self,
        account: Account,
        revision: u64,
    ) -> Result<AccountLease, Error> {
        self.acquire_account_revision(account, Some(revision)).await
    }
    async fn acquire_account_revision(
        &self,
        account: Account,
        revision: Option<u64>,
    ) -> Result<AccountLease, Error> {
        valid_id(&account.id)?;
        // A takeover linearizes after any bounded in-flight provider send.
        // Pending old workers revalidate generation before another send starts.
        let gate = self.account_gate(&account).await;
        let _guard = gate.write().await;
        let key = account_key(&account);
        self.store
            .transaction_fenced(_guard, move |tx| {
                let settings = store::entity::<AccountSettings>(tx, "account-settings", &key)?;
                match (settings, revision) {
                    (Some(s), Some(r)) if s.enabled && s.revision == r => {}
                    (None, None) => {} // Unconfigured trusted fixtures/transport composition.
                    _ => return Err(Error::StaleLease),
                }
                let previous = store::entity::<AccountLease>(tx, "account", &key)?;
                let generation = previous
                    .as_ref()
                    .map_or(Some(1), |old| old.generation.checked_add(1))
                    .ok_or(Error::IdentityConflict)?;
                let lease = AccountLease {
                    account,
                    generation,
                    cursor: previous.map_or_else(String::new, |old| old.cursor),
                };
                store::put_entity(tx, "account", &key, &lease)?;
                Ok(lease)
            })
            .await
    }

    /// Use the persisted cursor after a lost acknowledgement; do not infer that
    /// the entire long-poll batch committed from a network response alone.
    pub async fn account_checkpoint(&self, lease: &AccountLease) -> Result<AccountLease, Error> {
        let lease = lease.clone();
        self.store
            .transaction(move |tx| current_lease(tx, &lease))
            .await
    }

    /// Only the authenticated adapter calls this API. It journals either a
    /// normalized command or terminal rejection and cursor in ONE FULL commit.
    /// A stale connection cannot advance a cursor or inject an accepted task.
    pub async fn receive(
        &self,
        lease: AccountLease,
        event_id: String,
        payload_sha256: String,
        next_cursor: String,
        input: ReceiveInput,
    ) -> Result<ReceiveReceipt, Error> {
        valid_id(&event_id)?;
        valid_digest(&payload_sha256)?;
        if next_cursor.len() > 16 * 1024 || next_cursor.contains('\0') {
            return Err(Error::Invalid("receive cursor bounds"));
        }
        if let ReceiveInput::Command { sender, .. } = &input {
            if sender.channel != lease.account.channel || sender.account != lease.account.id {
                return Err(Error::Unauthorized);
            }
        }
        let principal = match &input {
            ReceiveInput::Command { principal, .. } => Some(principal),
            _ => None,
        };
        let gate = match principal {
            Some(id) => Some(self.principal_gate(id).await),
            None => None,
        };
        let _guard = match &gate {
            Some(gate) => Some(gate.read().await),
            None => None,
        };
        let validation = match &input {
            ReceiveInput::Command {
                conversation,
                inbound,
                ..
            } => validate_inbound(conversation, inbound),
            _ => Ok(()),
        };
        let host = self.host_id.clone();
        self.store
            .transaction(move |tx| {
                let mut current = current_lease(tx, &lease)?;
                let key = digest(&json!(["platform-frame-v1", lease.account, event_id]));
                if let Some(old) = store::entity::<ReceiveReceipt>(tx, "platform-frame", &key)? {
                    if old.payload_sha256 != payload_sha256 {
                        return Err(Error::IdentityConflict);
                    }
                    // A duplicate acknowledgement never moves the current cursor backward.
                    return Ok(old);
                }
                if current.cursor != lease.cursor {
                    return Err(Error::CursorConflict);
                }
                let count: usize = tx.query_row(
                    "SELECT COUNT(*) FROM entities WHERE kind='platform-frame'",
                    [],
                    |r| r.get(0),
                )?;
                if count >= MAX_RECORDS {
                    return Err(Error::Capacity);
                }
                let outcome = match (validation, input) {
                    (Err(Error::Invalid(_)), _) => ReceiveOutcome::Rejected {
                        code: RejectionCode::InvalidCommand,
                    },
                    (Err(error), _) => return Err(error), // Capacity/storage is backpressure, not rejection/ack.
                    (_, ReceiveInput::Reject { code }) => ReceiveOutcome::Rejected { code },
                    (
                        _,
                        ReceiveInput::Command {
                            principal,
                            sender,
                            conversation,
                            inbound,
                        },
                    ) => {
                        if sender.channel != lease.account.channel
                            || sender.account != lease.account.id
                        {
                            return Err(Error::Unauthorized); // Forged transport account, not a normal user rejection.
                        }
                        match admit(tx, &host, &principal, sender, conversation, *inbound) {
                            Ok(delivery) => ReceiveOutcome::Accepted {
                                delivery_key: delivery.key,
                            },
                            Err(Error::Unauthorized) => ReceiveOutcome::Rejected {
                                code: RejectionCode::Forbidden,
                            },
                            Err(error) => return Err(error),
                        }
                    }
                };
                let receipt = ReceiveReceipt {
                    account: lease.account,
                    event_id,
                    payload_sha256,
                    generation: current.generation,
                    outcome,
                };
                store::put_entity(tx, "platform-frame", &key, &receipt)?;
                current.cursor = next_cursor;
                store::put_entity(tx, "account", &account_key(&current.account), &current)?;
                Ok(receipt)
            })
            .await
    }
}
pub(crate) fn account_key(account: &Account) -> String {
    digest(&json!(["account-v1", account]))
}
pub(crate) fn current_lease(
    tx: &rusqlite::Transaction<'_>,
    lease: &AccountLease,
) -> Result<AccountLease, Error> {
    let current = store::entity::<AccountLease>(tx, "account", &account_key(&lease.account))?
        .ok_or(Error::StaleLease)?;
    if current.generation != lease.generation {
        return Err(Error::StaleLease);
    }
    Ok(current)
}
pub(crate) fn valid_digest(value: &str) -> Result<(), Error> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::Invalid("expected SHA-256 digest"));
    }
    Ok(())
}
