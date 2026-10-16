//! Read-only catalogue cut. No cwd, global RPC, recovery, Agent or model effect.
use crate::BasicHost;
use xharness_api::{
    CatalogueSession, CatalogueWorkspace, RpcError, ScopedCataloguePage, ScopedCatalogueQuery,
    SCOPED_CATALOGUE_PAGE_SIZE,
};

pub(super) async fn read(
    host: &BasicHost,
    query: ScopedCatalogueQuery,
) -> Result<ScopedCataloguePage, RpcError> {
    if !query.is_bounded() {
        return Err(RpcError::internal("invalid scoped catalogue query"));
    }
    // Same lock order as session_in_workspace. Cold headers are metadata, not
    // an invitation to hydrate every candidate or start background title work.
    let default_cwd = host.config.cwd.to_string_lossy();
    let state = host.state.read().await;
    let headers = host.lazy_headers.read().await;
    let mut workspaces = Vec::new();
    let mut sessions = Vec::new();
    for workspace_id in &query.workspaces {
        let Some(workspace) = state.workspaces.get(workspace_id) else {
            continue;
        };
        workspaces.push(CatalogueWorkspace {
            id: workspace_id.clone(),
            title: workspace.title.clone(),
        });
        if sessions.len() > SCOPED_CATALOGUE_PAGE_SIZE {
            continue;
        }
        for session_id in &query.sessions {
            if state.deleted_sessions.contains(session_id)
                || state.archived_sessions.contains(session_id)
            {
                continue;
            }
            let cursor = xharness_api::CatalogueCursor {
                workspace: workspace_id.clone(),
                session: session_id.clone(),
            };
            if query.after.as_ref().is_some_and(|after| cursor <= *after) {
                continue;
            }
            let session = state.sessions.get(session_id);
            let cwd = session.map(|s| s.cwd.as_str()).or_else(|| {
                headers
                    .get(session_id)
                    .map(|h| h.cwd.as_deref().unwrap_or_else(|| default_cwd.as_ref()))
            });
            if cwd != Some(workspace.path.as_str()) {
                continue;
            }
            sessions.push(CatalogueSession {
                workspace: workspace_id.clone(),
                id: session_id.clone(),
                title: session.and_then(|s| s.title.clone()),
                running: session.is_some_and(|s| s.running),
                restoring: session.is_none_or(|s| s.restoring),
            });
            if sessions.len() > SCOPED_CATALOGUE_PAGE_SIZE {
                break;
            }
        }
    }
    let next = if sessions.len() > SCOPED_CATALOGUE_PAGE_SIZE {
        sessions.pop();
        sessions.last().map(CatalogueSession::cursor)
    } else {
        None
    };
    let page = ScopedCataloguePage {
        workspaces,
        sessions,
        next,
    };
    if !query.admits(&page) {
        return Err(RpcError::internal("invalid scoped catalogue metadata"));
    }
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{HostConfig, NoTools};
    use serde_json::json;
    use std::{collections::BTreeSet, sync::Arc};
    use tokio_util::sync::CancellationToken;
    use xharness_api::{ApiBackend, RpcId, RpcMethod, RpcResult};

    #[tokio::test]
    async fn scoped_catalogue_is_path_free_exact_registered_paginated_and_never_hydrates_cold_headers(
    ) {
        let root = std::env::temp_dir().join(format!("xh-scoped-catalogue-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let host = BasicHost::new(HostConfig::new(&root), None, Arc::new(NoTools));
        let ids: BTreeSet<String> = (0..30).map(|i| format!("s-{i:02}")).collect();
        for id in &ids {
            let result = host
                .call(
                    RpcId::new(id),
                    RpcMethod::SessionCreate,
                    json!({"workspaceId":"workspace-default","sessionId":id}),
                    CancellationToken::new(),
                )
                .await;
            assert!(matches!(result, RpcResult::Success { .. }), "{result:?}");
        }
        {
            let mut state = host.state.write().await;
            state.sessions.get_mut("s-00").unwrap().title = Some("Native title".into());
            state.sessions.get_mut("s-00").unwrap().running = true;
        }
        let mut query = ScopedCatalogueQuery {
            workspaces: ["workspace-default".into(), "unregistered".into()].into(),
            sessions: ids,
            after: None,
        };
        let first = host.scoped_catalogue(query.clone()).await.unwrap();
        assert_eq!(first.workspaces.len(), 1);
        assert_eq!(first.sessions.len(), 25);
        assert_eq!(first.sessions[0].title.as_deref(), Some("Native title"));
        assert!(first.sessions[0].running);
        query.after = first.next;
        let second = host.scoped_catalogue(query.clone()).await.unwrap();
        assert_eq!(second.sessions.len(), 5);
        assert!(second.next.is_none());
        assert!(serde_json::to_string(&second)
            .unwrap()
            .find(root.to_str().unwrap())
            .is_none());
        {
            let mut state = host.state.write().await;
            state.archived_sessions.insert("s-25".into());
            state.deleted_sessions.insert("s-26".into());
        }
        let second = host.scoped_catalogue(query).await.unwrap();
        assert_eq!(second.sessions.len(), 3);
        let mut header = xharness_session::SessionHeader::new("cold");
        // Match the native registered metadata, including Windows' verbatim
        // canonical path prefix; do not loosen production scope comparison.
        header.cwd = Some(
            host.state.read().await.workspaces["workspace-default"]
                .path
                .clone(),
        );
        host.lazy_headers
            .write()
            .await
            .insert("cold".into(), header);
        let mut wrong = xharness_session::SessionHeader::new("foreign");
        wrong.cwd = Some("/not-authorized".into());
        host.lazy_headers
            .write()
            .await
            .insert("foreign".into(), wrong);
        let page = host
            .scoped_catalogue(ScopedCatalogueQuery {
                workspaces: ["workspace-default".into()].into(),
                sessions: ["cold".into(), "foreign".into(), "missing".into()].into(),
                after: None,
            })
            .await
            .unwrap();
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].id, "cold");
        assert!(page.sessions[0].restoring);
        assert!(page.sessions[0].title.is_none());
        assert!(!host.state.read().await.sessions.contains_key("cold"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
