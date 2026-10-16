//! Path-free registered workspace/session metadata for trusted scoped callers.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const SCOPED_CATALOGUE_PAGE_SIZE: usize = 25;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogueCursor {
    pub workspace: String,
    pub session: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedCatalogueQuery {
    pub workspaces: BTreeSet<String>,
    pub sessions: BTreeSet<String>,
    pub after: Option<CatalogueCursor>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogueWorkspace {
    pub id: String,
    pub title: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogueSession {
    pub workspace: String,
    pub id: String,
    /// None for a cold header without a projected title; never generated here.
    pub title: Option<String>,
    pub running: bool,
    pub restoring: bool,
}
impl CatalogueSession {
    pub fn cursor(&self) -> CatalogueCursor {
        CatalogueCursor {
            workspace: self.workspace.clone(),
            session: self.id.clone(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScopedCataloguePage {
    pub workspaces: Vec<CatalogueWorkspace>,
    pub sessions: Vec<CatalogueSession>,
    pub next: Option<CatalogueCursor>,
}

fn identity(id: &str) -> bool {
    !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)
}
fn title(value: &str) -> bool {
    value.len() <= 4096 && !value.contains('\0')
}
impl ScopedCatalogueQuery {
    pub fn is_bounded(&self) -> bool {
        self.workspaces.len() <= 256
            && self.sessions.len() <= 4096
            && self
                .workspaces
                .iter()
                .chain(&self.sessions)
                .all(|id| identity(id))
            && self.after.as_ref().is_none_or(|cursor| {
                identity(&cursor.workspace)
                    && identity(&cursor.session)
                    && self.workspaces.contains(&cursor.workspace)
                    && self.sessions.contains(&cursor.session)
            })
    }
    /// Do not trust a native/backend response merely because it deserializes.
    /// Both dimensions, order, page size, metadata and cursor must match scope.
    pub fn admits(&self, page: &ScopedCataloguePage) -> bool {
        self.is_bounded()
            && page.workspaces.len() <= self.workspaces.len()
            && page.sessions.len() <= SCOPED_CATALOGUE_PAGE_SIZE
            && page
                .workspaces
                .iter()
                .all(|w| self.workspaces.contains(&w.id) && title(&w.title))
            && page.workspaces.windows(2).all(|p| p[0].id < p[1].id)
            && page.sessions.iter().all(|s| {
                self.workspaces.contains(&s.workspace)
                    && self.sessions.contains(&s.id)
                    && page.workspaces.iter().any(|w| w.id == s.workspace)
                    && s.title.as_deref().is_none_or(title)
                    && self.after.as_ref().is_none_or(|after| s.cursor() > *after)
            })
            && page
                .sessions
                .windows(2)
                .all(|p| p[0].cursor() < p[1].cursor())
            && page.next.as_ref().is_none_or(|next| {
                page.sessions.len() == SCOPED_CATALOGUE_PAGE_SIZE
                    && page.sessions.last().is_some_and(|s| s.cursor() == *next)
            })
    }
}
