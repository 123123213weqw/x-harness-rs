//! Trusted transport routing. A platform sender never chooses its principal or
//! session by putting an identifier in message text. This is not a network API.
use crate::{
    gateway::{authorize, valid_id},
    store, *,
};
use rusqlite::params;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedRoute {
    pub principal: String,
    pub binding: Binding,
}

impl Gateway {
    /// Trusted account observer catalog, not controller workspace discovery.
    /// A live account lease and a current private binding are required. The
    /// bounded result must fit the existing global subscription budget.
    pub async fn account_subscriptions(
        &self,
        lease: &AccountLease,
    ) -> Result<Vec<Subscription>, Error> {
        let lease = lease.clone();
        let host = self.host_id.clone();
        self.store.transaction(move |tx| {
            crate::receive::current_lease(tx, &lease)?;
            let mut query = tx.prepare(
                "SELECT binding.body,principal.body FROM entities AS binding JOIN entities AS principal
                 ON principal.kind='principal' AND principal.id=json_extract(binding.body,'$.principal')
                 WHERE binding.kind='binding' AND json_extract(principal.body,'$.sender.channel')=?1
                 AND json_extract(principal.body,'$.sender.account')=?2 ORDER BY binding.id LIMIT 4097",
            )?;
            let rows = query.query_map(params![serde_json::to_value(&lease.account.channel)?.as_str(), lease.account.id],
                |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?;
            let mut result = Vec::new();
            let mut conversations = std::collections::HashSet::new();
            for (index,row) in rows.enumerate() {
                if index == 4096 {return Err(Error::Capacity);}
                let (binding,principal)=row?;
                let b:Binding=serde_json::from_str(&binding)?;
                let p:Principal=serde_json::from_str(&principal)?;
                if p.host != host || authorize(&p,&b).is_err() {continue;}
                if !conversations.insert((p.sender.user.clone(),b.conversation.clone())) {return Err(Error::IdentityConflict);}
                if result.len() == 32 {return Err(Error::Capacity);}
                result.push(Subscription {principal:p.id,sender:p.sender,conversation:b.conversation,binding:b.id,generation:b.generation});
            }
            Ok(result)
        }).await
    }

    /// Resolve exactly one current authorized binding before downloading media.
    /// Ambiguous desktop configuration fails closed. Admission revalidates the
    /// returned generation after any network I/O; this snapshot is not a grant.
    pub async fn resolve_sender(
        &self,
        sender: Sender,
        conversation: String,
    ) -> Result<Option<ResolvedRoute>, Error> {
        valid_id(&sender.account)?;
        valid_id(&sender.user)?;
        valid_id(&conversation)?;
        let host = self.host_id.clone();
        let route = self
            .store
            .transaction(move |tx| {
                let mut query = tx.prepare(
                    "SELECT body FROM entities WHERE kind='binding'
                AND json_extract(body,'$.conversation')=?1 LIMIT 4097",
                )?;
                let rows = query.query_map(params![conversation], |r| r.get::<_, String>(0))?;
                let mut result = None;
                for (index, row) in rows.enumerate() {
                    if index == 4096 {
                        return Err(Error::Capacity);
                    }
                    let binding: Binding = serde_json::from_str(&row?)?;
                    let Some(principal) =
                        store::entity::<Principal>(tx, "principal", &binding.principal)?
                    else {
                        continue;
                    };
                    if principal.host != host
                        || principal.sender != sender
                        || authorize(&principal, &binding).is_err()
                    {
                        continue;
                    }
                    if result.is_some() {
                        return Err(Error::IdentityConflict);
                    }
                    result = Some(ResolvedRoute {
                        principal: principal.id,
                        binding,
                    });
                }
                Ok(result)
            })
            .await?;
        if let Some(route) = route.as_ref() {
            if !self
                .host
                .session_in_workspace(&route.binding.workspace, &route.binding.session)
                .await
                .map_err(|_| Error::HostUnavailable)?
            {
                return Ok(None);
            }
        }
        Ok(route)
    }
}
