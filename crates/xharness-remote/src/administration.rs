//! Bounded trusted desktop scope management, not Bot/controller ingress.
use crate::{
    gateway::{authorize, valid_id, ResultBudget},
    store, *,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::time::Duration;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantEntry {
    pub principal: Principal,
    pub bindings: Vec<Binding>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creation_policy: Option<CreationPolicy>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrantPage {
    pub items: Vec<GrantEntry>,
    pub next: Option<String>,
}
impl Gateway {
    /// Exact principal/binding update in one commit; no half-created authority
    /// if native scope/generation/permission checks fail. One active private
    /// sender grant avoids ambiguous routing; groups remain separate work.
    pub async fn configure_private_grant(&self, p: Principal, b: Binding) -> Result<(), Error> {
        if p.workspaces.len() != 1 || p.sessions.len() != 1 {
            return Err(Error::Unauthorized);
        }
        self.configure_private_scopes(p, b, None).await.map(|_| ())
    }

    /// Full allowlists and an explicit creation policy commit atomically with
    /// the private route. None preserves a stale old capability (never enables
    /// it); Some uses exact policy-generation CAS and the new grant revision.
    pub async fn configure_private_scopes(
        &self,
        p: Principal,
        b: Binding,
        creation: Option<CreationPolicy>,
    ) -> Result<GrantEntry, Error> {
        for id in [
            &p.id,
            &p.sender.account,
            &p.sender.user,
            &b.id,
            &b.principal,
            &b.conversation,
            &b.workspace,
            &b.session,
        ] {
            valid_id(id)?;
        }
        for id in p.workspaces.iter().chain(&p.sessions) {
            valid_id(id)?;
        }
        if p.workspaces.is_empty()
            || p.sessions.is_empty()
            || p.workspaces.len() > 256
            || p.sessions.len() > 4096
        {
            return Err(Error::Capacity);
        }
        if p.host != self.host_id || b.conversation != p.sender.user {
            return Err(Error::Unauthorized);
        }
        authorize(&p, &b)?;
        if creation.as_ref().is_some_and(|c| {
            c.principal != p.id
                || c.principal_revision != p.revision
                || c.generation == 0
                || !c.workspaces.is_subset(&p.workspaces)
        }) {
            return Err(Error::Unauthorized);
        }
        let gate = self.principal_gate(&p.id).await;
        let _guard = gate.write().await;
        if creation.is_none() && p.workspaces.len() == 1 && p.sessions.len() == 1 {
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
        } else {
            // Paginated exact native metadata, never one hydration per candidate.
            // Every selected session and workspace must actually be present; no
            // truncated subset can be mistaken for a complete grant validation.
            let mut query = xharness_api::ScopedCatalogueQuery {
                workspaces: p.workspaces.clone(),
                sessions: p.sessions.clone(),
                after: None,
            };
            let mut found_sessions = std::collections::BTreeSet::new();
            let mut found_workspaces = std::collections::BTreeSet::new();
            let mut bound = false;
            let mut finished = false;
            for _ in 0..=4096 / 25 {
                let page = tokio::time::timeout(
                    Duration::from_secs(2),
                    self.host.scoped_catalogue(query.clone()),
                )
                .await
                .map_err(|_| Error::HostUnavailable)?
                .map_err(|_| Error::HostUnavailable)?;
                if !query.admits(&page) {
                    return Err(Error::Invalid("unscoped grant catalogue"));
                }
                found_workspaces.extend(page.workspaces.iter().map(|w| w.id.clone()));
                for session in &page.sessions {
                    bound |= session.workspace == b.workspace && session.id == b.session;
                    found_sessions.insert(session.id.clone());
                }
                match page.next {
                    Some(next) => query.after = Some(next),
                    None => {
                        finished = true;
                        break;
                    }
                }
            }
            if !finished {
                return Err(Error::Capacity);
            }
            if found_workspaces != p.workspaces || found_sessions != p.sessions || !bound {
                return Err(Error::Unauthorized);
            }
        }
        self.store.transaction_fenced(_guard,move |tx| {
            let channel=serde_json::to_value(&p.sender.channel)?;
            let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM entities WHERE kind='principal' AND id<>?1 AND json_extract(body,'$.revoked')=0 AND json_extract(body,'$.sender.channel')=?2 AND json_extract(body,'$.sender.account')=?3 AND json_extract(body,'$.sender.user')=?4)",params![p.id,channel.as_str(),p.sender.account,p.sender.user],|r|r.get(0))?;
            if duplicate {return Err(Error::IdentityConflict);}
            let old=store::entity::<Principal>(tx,"principal",&p.id)?;
            let updating=old.is_some();
            match old {
                Some(old) if !old.revoked && old.sender==p.sender && old.host==p.host
                    && old.revision.checked_add(1)==Some(p.revision)=>{},
                None if p.revision==1=>{
                    let count:usize=tx.query_row("SELECT COUNT(*) FROM entities WHERE kind='principal'",[],|r|r.get(0))?;
                    if count>=MAX_RECORDS {return Err(Error::Capacity);}
                },
                _=>return Err(Error::IdentityConflict),
            }
            match store::entity::<Binding>(tx,"binding",&b.id)? {
                Some(old) if updating && old.principal==b.principal && old.generation.checked_add(1)==Some(b.generation)=>{},
                None if !updating && b.generation==1=>{},
                _=>return Err(Error::IdentityConflict),
            }
            let previous_policy:Option<CreationPolicy>=store::entity(tx,"creation-policy",&p.id)?;
            let policy=match creation {
                Some(policy)=>{
                    let expected=previous_policy.as_ref().map_or(Some(1),|old|old.generation.checked_add(1));
                    if expected!=Some(policy.generation) {return Err(Error::IdentityConflict);}
                    store::put_entity(tx,"creation-policy",&p.id,&policy)?;
                    Some(policy)
                },
                None=>previous_policy,
            };
            store::put_entity(tx,"principal",&p.id,&p)?;
            store::put_entity(tx,"binding",&b.id,&b)?;
            Ok(GrantEntry {principal:p,bindings:vec![b],creation_policy:policy})
        }).await
    }
    /// Explicit 25-entry pagination; at most 32 bindings per principal. Never
    /// silently hide excess scopes as if an administration page were complete.
    pub async fn grant_page(&self, after: Option<String>) -> Result<GrantPage, Error> {
        if let Some(cursor) = &after {
            valid_id(cursor)?;
        }
        self.store.transaction(move |tx| {
            let mut query=tx.prepare("SELECT body FROM entities WHERE kind='principal' AND id>?1 ORDER BY id LIMIT 26")?;
            let rows=query.query_map([after.unwrap_or_default()],|r|r.get::<_,String>(0))?;
            let mut principals=rows.map(|r|Ok(serde_json::from_str::<Principal>(&r?)?)).collect::<Result<Vec<_>,Error>>()?;
            let next=if principals.len()>25 {principals.pop();principals.last().map(|p|p.id.clone())} else {None};
            let mut items=Vec::with_capacity(principals.len());
            for principal in principals {
                let mut query=tx.prepare("SELECT body FROM entities WHERE kind='binding' AND json_extract(body,'$.principal')=?1 ORDER BY id LIMIT 33")?;
                let rows=query.query_map([&principal.id],|r|r.get::<_,String>(0))?;
                let bindings=rows.map(|r|Ok(serde_json::from_str::<Binding>(&r?)?)).collect::<Result<Vec<_>,Error>>()?;
                if bindings.len()>32 {return Err(Error::Capacity);}
                let creation_policy=store::entity::<CreationPolicy>(tx,"creation-policy",&principal.id)?;
                items.push(GrantEntry {principal,bindings,creation_policy});
            }
            let page=GrantPage {items,next};
            if serde_json::to_writer(&mut ResultBudget(MAX_RESULT_BYTES),&page).is_err() {return Err(Error::Capacity);}
            Ok(page)
        }).await
    }
    /// Trusted recovery listing. Inspect/audit/resolve remain separate methods;
    /// no raw record bodies or tokens enter the channel protocol.
    pub async fn uncertain_replies(&self, after: i64) -> Result<Vec<Outgoing>, Error> {
        if after < 0 {
            return Err(Error::Invalid("reply recovery cursor"));
        }
        self.store.transaction(move |tx| {
            let mut query=tx.prepare("SELECT body FROM outbox WHERE state='uncertain' AND seq>?1 ORDER BY seq LIMIT 25")?;
            let rows=query.query_map(params![after],|r|r.get::<_,String>(0))?;
            rows.map(|r|Ok(serde_json::from_str(&r?)?)).collect()
        }).await
    }
}
