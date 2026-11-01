//! Controller metadata reads through an exact current authenticated binding.
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
    subscription::scope_in_transaction,
    *,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use xharness_api::ScopedCatalogueQuery;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControllerCatalogue {
    pub principal_revision: u64,
    pub binding_generation: u64,
    pub catalogue: ScopedCataloguePage,
}
impl ControllerCatalogue {
    /// Structural validation for trusted reply formatters, not a new authority
    /// grant. Dispatch must validate the native cut against the actual principal.
    pub fn is_bounded_after(&self, after: Option<&CatalogueCursor>) -> bool {
        let mut workspaces: std::collections::BTreeSet<_> = self
            .catalogue
            .workspaces
            .iter()
            .map(|w| w.id.clone())
            .collect();
        let mut sessions: std::collections::BTreeSet<_> = self
            .catalogue
            .sessions
            .iter()
            .map(|s| s.id.clone())
            .collect();
        if let Some(cursor) = after {
            workspaces.insert(cursor.workspace.clone());
            sessions.insert(cursor.session.clone());
        }
        self.principal_revision > 0
            && self.binding_generation > 0
            && ScopedCatalogueQuery {
                workspaces,
                sessions,
                after: after.cloned(),
            }
            .admits(&self.catalogue)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionSelection {
    pub workspace: String,
    pub session: String,
}
impl Gateway {
    /// Internal dispatch continuation. Its caller owns the exact principal
    /// read fence and session FIFO through completion, including native reads.
    pub(crate) async fn dispatch_catalogue(&self, mut d: Delivery) -> Result<Delivery, Error> {
        let Command::Catalogue { after } = &d.inbound.command else {
            return Err(Error::Invalid("catalogue command"));
        };
        let after = after.clone();
        let expected = d.clone();
        let host = self.host_id.clone();
        let principal = self
            .store
            .transaction(move |tx| {
                let p: Principal = store::entity(tx, "principal", &expected.principal)?
                    .ok_or(Error::Unauthorized)?;
                let b: Binding = store::entity(tx, "binding", &expected.binding.id)?
                    .ok_or(Error::Unauthorized)?;
                if p.host != host
                    || p.revision != expected.principal_revision
                    || b != expected.binding
                {
                    return Err(Error::Unauthorized);
                }
                crate::gateway::authorize(&p, &b)?;
                Ok(p)
            })
            .await?;
        let query = ScopedCatalogueQuery {
            workspaces: principal.workspaces,
            sessions: principal.sessions,
            after,
        };
        if !query.is_bounded() {
            d.state = DeliveryState::Rejected;
            d.reason = Some("catalogue-cursor-outside-grant".into());
            return self.persist(d).await;
        }
        let owned = tokio::time::timeout(
            Duration::from_secs(2),
            self.host
                .session_in_workspace(&d.binding.workspace, &d.binding.session),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if !owned {
            d.state = if d.state == DeliveryState::Dispatching {
                DeliveryState::Uncertain
            } else {
                DeliveryState::Rejected
            };
            d.reason = Some("host-scope-changed".into());
            return self.persist(d).await;
        }
        d.state = DeliveryState::Dispatching;
        d = self.persist(d).await?;
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.scoped_catalogue(query.clone()),
        )
        .await;
        let page = match result {
            Ok(Ok(page)) if query.admits(&page) => Some(page),
            _ => None,
        };
        d.state = DeliveryState::Completed;
        d.result = Some(match page {
            Some(page) => {
                NativeCommandResult::success(serde_json::to_value(ControllerCatalogue {
                    principal_revision: d.principal_revision,
                    binding_generation: d.binding.generation,
                    catalogue: page,
                })?)
            }
            None => {
                d.reason = Some("catalogue-read-unavailable".into());
                NativeCommandResult::failure(xharness_api::RpcError::internal(
                    "scoped catalogue unavailable",
                ))
            }
        });
        self.persist(d).await
    }

    /// Select only an already granted, registered, unarchived session. This is
    /// not a session-create capability or a way to expand a principal grant.
    /// The binding CAS is the receipt; an unknown outcome requires re-reading
    /// the route, not repeating a mutation with guessed generations.
    pub async fn controller_select(
        &self,
        scope: Subscription,
        target: SessionSelection,
    ) -> Result<Binding, Error> {
        for id in [
            &scope.principal,
            &scope.sender.account,
            &scope.sender.user,
            &scope.conversation,
            &scope.binding,
            &target.workspace,
            &target.session,
        ] {
            valid_id(id)?;
        }
        let gate = self.principal_gate(&scope.principal).await;
        let guard = gate.write().await;
        let host = self.host_id.clone();
        let check = scope.clone();
        let (principal, binding) = self
            .store
            .transaction(move |tx| scope_in_transaction(tx, &host, &check))
            .await?;
        if !principal.workspaces.contains(&target.workspace)
            || !principal.sessions.contains(&target.session)
        {
            return Err(Error::Unauthorized);
        }
        let query = ScopedCatalogueQuery {
            workspaces: [target.workspace.clone()].into(),
            sessions: [target.session.clone()].into(),
            after: None,
        };
        let page = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.scoped_catalogue(query.clone()),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if !query.admits(&page) {
            return Err(Error::Invalid("unscoped catalogue response"));
        }
        if page.sessions.len() != 1 {
            return Err(Error::Unauthorized);
        }
        if binding.workspace == target.workspace && binding.session == target.session {
            return Ok(binding);
        }
        let mut selected = binding.clone();
        selected.workspace = target.workspace;
        selected.session = target.session;
        selected.generation = selected
            .generation
            .checked_add(1)
            .ok_or(Error::IdentityConflict)?;
        let host = self.host_id.clone();
        // The owned write guard follows a queued blocking commit even if the
        // controller disconnects or the caller drops this future.
        self.store
            .transaction_fenced(guard, move |tx| {
                let (current, current_binding) = scope_in_transaction(tx, &host, &scope)?;
                if current != principal || current_binding != binding {
                    return Err(Error::Unauthorized);
                }
                crate::store::put_entity(tx, "binding", &selected.id, &selected)?;
                Ok(selected)
            })
            .await
    }

    /// Authenticated transport supplies the identity; cursors grant no scope.
    /// No generic Host directory/session-list or filesystem path is exposed.
    pub async fn controller_catalogue(
        &self,
        scope: Subscription,
        after: Option<CatalogueCursor>,
    ) -> Result<ControllerCatalogue, Error> {
        for id in [
            &scope.principal,
            &scope.sender.account,
            &scope.sender.user,
            &scope.conversation,
            &scope.binding,
        ] {
            valid_id(id)?;
        }
        let gate = self.principal_gate(&scope.principal).await;
        // This bounded ordinary read is not a paused pull-stream generator.
        // Each native read has a 2s deadline; storage uses the journal queue.
        let _guard = gate.read().await;
        let host = self.host_id.clone();
        let s = scope.clone();
        let (principal, binding) = self
            .store
            .transaction(move |tx| scope_in_transaction(tx, &host, &s))
            .await?;
        let query = ScopedCatalogueQuery {
            workspaces: principal.workspaces.clone(),
            sessions: principal.sessions.clone(),
            after,
        };
        if !query.is_bounded() {
            return Err(Error::Invalid("catalogue cursor or scope"));
        }
        let native_scope = tokio::time::timeout(
            Duration::from_secs(2),
            self.host
                .session_in_workspace(&binding.workspace, &binding.session),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if !native_scope {
            return Err(Error::Unauthorized);
        }
        let page = tokio::time::timeout(
            Duration::from_secs(2),
            self.host.scoped_catalogue(query.clone()),
        )
        .await
        .map_err(|_| Error::HostUnavailable)?
        .map_err(|_| Error::HostUnavailable)?;
        if !query.admits(&page) {
            return Err(Error::Invalid("unscoped catalogue response"));
        }
        let result = ControllerCatalogue {
            principal_revision: principal.revision,
            binding_generation: binding.generation,
            catalogue: page,
        };
        if serde_json::to_writer(&mut ResultBudget(MAX_RESULT_BYTES), &result).is_err() {
            return Err(Error::Capacity);
        }
        Ok(result)
    }
}
