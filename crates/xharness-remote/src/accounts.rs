//! Trusted native account configuration, references only; never provider secrets.
use crate::{gateway::valid_id, receive::account_key, store, *};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_ACCOUNTS: usize = 16;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountSettings {
    pub account: Account,
    pub enabled: bool,
    pub revision: u64,
    /// Role -> opaque reference in the CHANNEL-only native credential namespace.
    pub credentials: BTreeMap<String, String>,
}
impl Gateway {
    /// Trusted native settings only. Revision CAS and connection invalidation
    /// commit together; no secret/token field is accepted in this schema.
    pub async fn set_account_settings(&self, settings: AccountSettings) -> Result<(), Error> {
        valid_id(&settings.account.id)?;
        if settings.revision == 0
            || settings.credentials.len() > 8
            || (settings.enabled && settings.credentials.is_empty())
        {
            return Err(Error::Invalid("account settings bound"));
        }
        for (role, reference) in &settings.credentials {
            if role.is_empty()
                || role.len() > 32
                || !role.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
                || !reference.starts_with("REMOTE_")
                || reference.len() > 160
                || !reference
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
            {
                return Err(Error::Invalid("credential reference"));
            }
        }
        let gate = self.account_gate(&settings.account).await;
        let _guard = gate.write().await;
        self.store
            .transaction_fenced(_guard, move |tx| {
                let key = account_key(&settings.account);
                for reference in settings.credentials.values() {
                    if store::entity::<bool>(tx, "credential-retired", reference)?.is_some() {
                        return Err(Error::IdentityConflict);
                    }
                }
                let old = store::entity::<AccountSettings>(tx, "account-settings", &key)?;
                if old.as_ref() == Some(&settings) {
                    return Ok(());
                }
                if settings.revision
                    != old
                        .as_ref()
                        .map_or(Some(1), |s| s.revision.checked_add(1))
                        .ok_or(Error::IdentityConflict)?
                {
                    return Err(Error::IdentityConflict);
                }
                if old.is_none() {
                    let count: usize = tx.query_row(
                        "SELECT COUNT(*) FROM entities WHERE kind='account-settings'",
                        [],
                        |r| r.get(0),
                    )?;
                    if count >= MAX_ACCOUNTS {
                        return Err(Error::Capacity);
                    }
                }
                let previous = store::entity::<AccountLease>(tx, "account", &key)?;
                let lease = AccountLease {
                    account: settings.account.clone(),
                    generation: previous
                        .as_ref()
                        .map_or(Some(1), |s| s.generation.checked_add(1))
                        .ok_or(Error::IdentityConflict)?,
                    cursor: previous.map_or_else(String::new, |s| s.cursor),
                };
                store::put_entity(tx, "account", &key, &lease)?;
                if let Some(old) = old {
                    for reference in old.credentials.values() {
                        if !settings.credentials.values().any(|r| r == reference) {
                            if store::entity::<String>(tx, "credential-cleanup", reference)?
                                .is_none()
                            {
                                let count: usize = tx.query_row(
                                    "SELECT COUNT(*) FROM entities WHERE kind='credential-cleanup'",
                                    [],
                                    |r| r.get(0),
                                )?;
                                if count >= MAX_PENDING {
                                    return Err(Error::Capacity);
                                }
                            }
                            store::put_entity(tx, "credential-cleanup", reference, reference)?;
                        }
                    }
                }
                for reference in settings.credentials.values() {
                    tx.execute(
                        "DELETE FROM entities WHERE kind='credential-cleanup' AND id=?1",
                        [reference],
                    )?;
                }
                store::put_entity(tx, "account-settings", &key, &settings)
            })
            .await
    }
    pub async fn account_settings(&self) -> Result<Vec<AccountSettings>, Error> {
        self.store
            .transaction(move |tx| {
                let mut query = tx.prepare(
                    "SELECT body FROM entities WHERE kind='account-settings' ORDER BY id LIMIT 16",
                )?;
                let rows = query.query_map([], |r| r.get::<_, String>(0))?;
                rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
            })
            .await
    }
    /// Journal an inactive native reference BEFORE writing its secret. A
    /// cancelled/crashed setup cannot orphan an untracked keyring entry.
    pub async fn stage_credential_reference(&self, reference: &str) -> Result<(), Error> {
        if !reference.starts_with("REMOTE_")
            || reference.len() > 160
            || !reference
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        {
            return Err(Error::Invalid("credential reference"));
        }
        let reference = reference.to_owned();
        self.store.transaction(move |tx| {
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entities,json_each(body,'$.credentials') AS refs WHERE kind='account-settings' AND refs.value=?1)",[&reference],|r|r.get(0))?;
            if active || store::entity::<bool>(tx,"credential-retired",&reference)?.is_some() {return Err(Error::IdentityConflict);}
            let count:usize=tx.query_row("SELECT COUNT(*) FROM entities WHERE kind='credential-cleanup'",[],|r|r.get(0))?;
            if count>=MAX_PENDING {return Err(Error::Capacity);}
            store::put_entity(tx,"credential-cleanup",&reference,&reference)
        }).await
    }
    pub async fn pending_credential_cleanup(&self) -> Result<Vec<String>, Error> {
        self.store.transaction(move |tx| {
            let mut query=tx.prepare("SELECT body FROM entities WHERE kind='credential-cleanup' AND NOT EXISTS (SELECT 1 FROM entities AS settings,json_each(settings.body,'$.credentials') AS refs WHERE settings.kind='account-settings' AND refs.value=entities.id) ORDER BY id LIMIT 100")?;
            let rows=query.query_map([],|r|r.get::<_,String>(0))?;
            rows.map(|r|Ok(serde_json::from_str(&r?)?)).collect()
        }).await
    }
    /// Tombstone before native deletion: a concurrent settings update cannot
    /// reactivate this reference between the inactive check and keyring delete.
    pub async fn claim_credential_cleanup(&self, reference: &str) -> Result<(), Error> {
        let reference = reference.to_owned();
        self.store
            .transaction(move |tx| {
                if store::entity::<String>(tx, "credential-cleanup", &reference)?.is_none() {
                    return Err(Error::Invalid("unknown retired reference"));
                }
                retire_reference(tx, &reference)
            })
            .await
    }
    pub async fn finish_credential_cleanup(&self, reference: &str) -> Result<(), Error> {
        let reference = reference.to_owned();
        self.store.transaction(move |tx| {
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entities,json_each(body,'$.credentials') AS refs WHERE kind='account-settings' AND refs.value=?1)",[&reference],|r|r.get(0))?;
            if active {return Err(Error::IdentityConflict);}
            retire_reference(tx,&reference)?;
            tx.execute("DELETE FROM entities WHERE kind='credential-cleanup' AND id=?1",[reference])?;
            Ok(())
        }).await
    }
}

fn retire_reference(tx: &rusqlite::Transaction<'_>, reference: &str) -> Result<(), Error> {
    let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entities,json_each(body,'$.credentials') AS refs WHERE kind='account-settings' AND refs.value=?1)",[reference],|r|r.get(0))?;
    if active {
        return Err(Error::IdentityConflict);
    }
    if store::entity::<bool>(tx, "credential-retired", reference)?.is_none() {
        let count: usize = tx.query_row(
            "SELECT COUNT(*) FROM entities WHERE kind='credential-retired'",
            [],
            |r| r.get(0),
        )?;
        if count >= MAX_RECORDS {
            return Err(Error::Capacity);
        }
        store::put_entity(tx, "credential-retired", reference, &true)?;
    }
    Ok(())
}
