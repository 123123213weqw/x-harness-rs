//! Local read-only GitHub adapter. Reuses gh's existing credential store without
//! forwarding tokens to UI/model/storage. Fixed GET routes only; no shell, login, mutation or model
//! tools. The injected transport is replaceable by a GitHub App auth adapter.
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    sync::Semaphore,
};
use tokio_util::sync::CancellationToken;
use xharness_api::{RpcError, RpcErrorCode};
use xharness_host::GitHubBackend;

const PAGE_SIZE: usize = 50;
#[cfg(test)]
const MAX_BYTES: usize = 4 * 1024 * 1024;
pub(super) fn failure(kind: &str, message: &str) -> RpcError {
    RpcError {
        code: if kind == "cancelled" {
            RpcErrorCode::Cancelled
        } else {
            RpcErrorCode::Internal
        },
        message: message.into(),
        details: json!({"kind":kind}),
    }
}
pub(super) fn invalid() -> RpcError {
    failure("invalid_response", "GitHub returned an invalid response")
}
fn bad() -> RpcError {
    RpcError::bad_request("Invalid GitHub read request", json!([]))
}
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, RpcError> {
    serde_json::from_value(v).map_err(|_| invalid())
}

#[async_trait]
pub trait GitHubReader: Send + Sync {
    async fn get(&self, route: &str, cancellation: CancellationToken) -> Result<Value, RpcError>;
    /// Pin credentials once per operation. Existing injected readers keep their
    /// before/after identity checks; native HTTP sessions return a verified user.
    async fn session(
        &self,
        _account: Option<&str>,
        _cancel: CancellationToken,
    ) -> Result<Option<Arc<dyn GitHubReader>>, RpcError> {
        Ok(None)
    }
}
#[cfg(test)]
async fn bounded_read<R: AsyncRead + Unpin>(reader: R) -> Result<Vec<u8>, RpcError> {
    bounded_read_limit(reader, MAX_BYTES).await
}
pub(super) async fn bounded_read_limit<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> Result<Vec<u8>, RpcError> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = reader
            .read(&mut chunk)
            .await
            .map_err(|_| failure("transport", "GitHub response pipe failed"))?;
        if n == 0 {
            return Ok(bytes);
        }
        if bytes.len() + n > limit {
            return Err(failure(
                "response_too_large",
                "GitHub response exceeded its size limit",
            ));
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
}
pub struct NativeGitHub {
    reader: Arc<dyn GitHubReader>,
    limit: Arc<Semaphore>,
    reads: Arc<Semaphore>,
}
impl Default for NativeGitHub {
    fn default() -> Self {
        Self::new(Arc::new(crate::github_http::GhHttpReader::default()))
    }
}
impl NativeGitHub {
    pub fn new(reader: Arc<dyn GitHubReader>) -> Self {
        Self {
            reader,
            limit: Arc::new(Semaphore::new(4)),
            reads: Arc::new(Semaphore::new(4)),
        }
    }
    // Bound actual transports globally, even when multiple detail operations fan out.
    async fn get(&self, route: &str, cancel: CancellationToken) -> Result<Value, RpcError> {
        let _permit = tokio::select! {
            _ = cancel.cancelled() => return Err(failure("cancelled", "GitHub request cancelled")),
            permit = self.reads.acquire() => permit.map_err(|_| invalid())?,
        };
        self.reader.get(route, cancel).await
    }
    async fn user(&self, cancel: &CancellationToken) -> Result<User, RpcError> {
        decode(self.get("/user", cancel.clone()).await?)
    }
    async fn account(&self, expected: &str, cancel: &CancellationToken) -> Result<(), RpcError> {
        if self.user(cancel).await?.login != expected {
            return Err(failure(
                "account_changed",
                "GitHub account changed; reconnect before reading",
            ));
        }
        Ok(())
    }
    async fn page<T: serde::de::DeserializeOwned>(
        &self,
        route: &str,
        cancel: &CancellationToken,
    ) -> Result<Vec<T>, RpcError> {
        decode(self.get(route, cancel.clone()).await?)
    }
    async fn pull(
        &self,
        root: &str,
        number: u64,
        cancel: &CancellationToken,
    ) -> Result<Pull, RpcError> {
        decode(
            self.get(&format!("{root}/pulls/{number}"), cancel.clone())
                .await?,
        )
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    account: Option<String>,
    repository: Option<String>,
    number: Option<u64>,
    page: Option<u32>,
    sha: Option<String>,
}
fn repository(value: Option<&str>) -> Result<&str, RpcError> {
    let value = value.ok_or_else(bad)?;
    let parts: Vec<_> = value.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|p| {
            p.is_empty()
                || p.len() > 100
                || *p == "."
                || *p == ".."
                || !p
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err(bad());
    }
    Ok(value)
}
#[derive(Deserialize)]
struct User {
    login: String,
}
#[derive(Deserialize)]
struct Repo {
    full_name: String,
}
#[derive(Deserialize)]
struct Branch {
    #[serde(rename = "ref")]
    name: String,
    sha: String,
}
#[derive(Deserialize)]
struct Pull {
    number: u64,
    title: String,
    body: Option<String>,
    user: User,
    updated_at: String,
    state: String,
    #[serde(default)]
    merged: bool,
    draft: Option<bool>,
    head: Branch,
    base: Branch,
    additions: Option<u64>,
    deletions: Option<u64>,
    changed_files: Option<u64>,
    mergeable: Option<bool>,
    mergeable_state: Option<String>,
    comments: Option<u64>,
    review_comments: Option<u64>,
}
impl Pull {
    fn summary(&self, repo: &str) -> Value {
        json!({"id": self.number, "repository":repo, "title":self.title, "author":self.user.login, "updatedAt":self.updated_at, "state":if self.merged {"merged"} else {&self.state}, "draft":self.draft.unwrap_or(false), "headSha":self.head.sha, "branch":self.head.name})
    }
}
#[derive(Deserialize)]
struct File {
    filename: String,
    status: String,
    patch: Option<String>,
    additions: u64,
    deletions: u64,
}
fn file(v: File) -> Value {
    json!({"path":v.filename,"status":v.status,"patch":v.patch,"additions":v.additions,"deletions":v.deletions})
}
#[derive(Deserialize)]
struct Comment {
    id: u64,
    user: User,
    body: String,
    created_at: String,
}
fn comment(v: Comment) -> Value {
    json!({"id":v.id,"author":v.user.login,"body":v.body,"createdAt":v.created_at})
}
#[derive(Deserialize)]
struct Review {
    id: u64,
    user: User,
    state: String,
    body: Option<String>,
}
fn review(v: Review) -> Value {
    json!({"id":v.id,"author":v.user.login,"state":v.state,"body":v.body.unwrap_or_default()})
}
#[derive(Deserialize)]
struct CheckPage {
    total_count: usize,
    check_runs: Vec<Check>,
}
#[derive(Deserialize)]
struct Check {
    id: u64,
    name: String,
    status: String,
    conclusion: Option<String>,
    head_sha: String,
}
#[derive(Deserialize)]
struct CommitStatus {
    sha: String,
    total_count: usize,
    statuses: Vec<Status>,
}
#[derive(Deserialize)]
struct Status {
    id: u64,
    context: String,
    state: String,
    description: Option<String>,
}
fn check(v: Check) -> Value {
    json!({"id":format!("check:{}",v.id),"name":v.name,"status":v.status,"conclusion":v.conclusion,"description":""})
}
fn status(v: Status) -> Value {
    json!({"id":format!("status:{}",v.id),"name":v.context,"status":if v.state == "pending" {"in_progress"} else {"completed"},"conclusion":v.state,"description":v.description.unwrap_or_default()})
}

impl NativeGitHub {
    async fn read_inner(
        &self,
        endpoint: &str,
        payload: &Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        if !matches!(
            endpoint,
            "github/auth"
                | "github/repos"
                | "github/pulls"
                | "github/detail"
                | "github/files"
                | "github/comments"
                | "github/reviews"
        ) {
            return Err(bad());
        }
        let args: Request = decode(
            payload
                .get("args")
                .cloned()
                .unwrap_or_else(|| payload.clone()),
        )
        .map_err(|_| bad())?;
        let page = args.page.unwrap_or(1);
        if !(1..=60).contains(&page) {
            return Err(bad());
        }
        if endpoint != "github/auth" {
            args.account
                .as_deref()
                .filter(|a| !a.is_empty() && a.len() <= 100)
                .ok_or_else(bad)?;
            if endpoint != "github/repos" {
                repository(args.repository.as_deref())?;
                if endpoint != "github/pulls" {
                    args.number
                        .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                        .ok_or_else(bad)?;
                }
            }
        }
        let _permit = tokio::select! { _ = cancel.cancelled() => return Err(failure("cancelled", "GitHub request cancelled")), permit = self.limit.acquire() => permit.map_err(|_| invalid())? };
        // Credential resolution + initial identity verification also shares the
        // global transport bound. Subsequent reads use one immutable session.
        let session = {
            let _read = tokio::select! {
                _ = cancel.cancelled() => return Err(failure("cancelled", "GitHub request cancelled")),
                permit = self.reads.acquire() => permit.map_err(|_| invalid())?,
            };
            self.reader
                .session(args.account.as_deref(), cancel.clone())
                .await?
        };
        if let Some(reader) = session {
            let scoped = Self {
                reader,
                limit: Arc::clone(&self.limit),
                reads: Arc::clone(&self.reads),
            };
            scoped.read_authorized(endpoint, args, cancel).await
        } else {
            self.read_authorized(endpoint, args, cancel).await
        }
    }
    async fn read_authorized(
        &self,
        endpoint: &str,
        args: Request,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        let page = args.page.unwrap_or(1);
        if endpoint == "github/auth" {
            let user = self.user(&cancel).await?;
            return Ok(json!({"account":user.login,"source":"github-cli"}));
        }
        let account = args
            .account
            .as_deref()
            .filter(|s| !s.is_empty() && s.len() <= 100)
            .ok_or_else(bad)?;
        self.account(account, &cancel).await?;
        let value = if endpoint == "github/repos" {
            let items: Vec<Repo> = self
                .page(
                    &format!("/user/repos?sort=updated&per_page={PAGE_SIZE}&page={page}"),
                    &cancel,
                )
                .await?;
            json!({"items":items.iter().map(|r| &r.full_name).collect::<Vec<_>>(),"hasMore":items.len()==PAGE_SIZE})
        } else {
            let repo = repository(args.repository.as_deref())?;
            let root = format!("/repos/{repo}");
            if endpoint == "github/pulls" {
                let pulls: Vec<Pull> = self
                    .page(
                        &format!(
                            "{root}/pulls?state=open&sort=updated&per_page={PAGE_SIZE}&page={page}"
                        ),
                        &cancel,
                    )
                    .await?;
                json!({"items":pulls.iter().map(|p|p.summary(repo)).collect::<Vec<_>>(),"hasMore":pulls.len()==PAGE_SIZE})
            } else {
                let number = args
                    .number
                    .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)
                    .ok_or_else(bad)?;
                let pull = self.pull(&root, number, &cancel).await?;
                if let Some(sha) = args.sha.as_deref() {
                    if sha != pull.head.sha {
                        return Err(failure(
                            "head_changed",
                            "PR head changed; refresh before reading more",
                        ));
                    }
                }
                let result = match endpoint {
                    "github/files" => {
                        let items: Vec<File> = self
                            .page(
                                &format!(
                                    "{root}/pulls/{number}/files?per_page={PAGE_SIZE}&page={page}"
                                ),
                                &cancel,
                            )
                            .await?;
                        let more = items.len() == PAGE_SIZE && page < 60;
                        json!({"items":items.into_iter().map(file).collect::<Vec<_>>(),"hasMore":more})
                    }
                    "github/comments" => {
                        let items: Vec<Comment> = self.page(&format!("{root}/issues/{number}/comments?per_page={PAGE_SIZE}&page={page}"), &cancel).await?;
                        let more = items.len() == PAGE_SIZE;
                        json!({"items":items.into_iter().map(comment).collect::<Vec<_>>(),"hasMore":more})
                    }
                    "github/reviews" => {
                        let items: Vec<Review> = self.page(&format!("{root}/pulls/{number}/reviews?per_page={PAGE_SIZE}&page={page}"), &cancel).await?;
                        let more = items.len() == PAGE_SIZE;
                        json!({"items":items.into_iter().map(review).collect::<Vec<_>>(),"hasMore":more})
                    }
                    "github/detail" => {
                        // The SHA is taken only from this PR, never accepted as an
                        // arbitrary API path. GitHub SHAs are hexadecimal.
                        if pull.head.sha.len() != 40
                            || !pull.head.sha.bytes().all(|b| b.is_ascii_hexdigit())
                        {
                            return Err(invalid());
                        }
                        // Independent reads share a captured head SHA. Keep the
                        // account/head fences before and after this bounded fan-out.
                        let files_route =
                            format!("{root}/pulls/{number}/files?per_page={PAGE_SIZE}");
                        let comments_route =
                            format!("{root}/issues/{number}/comments?per_page={PAGE_SIZE}");
                        let reviews_route =
                            format!("{root}/pulls/{number}/reviews?per_page={PAGE_SIZE}");
                        let checks_route =
                            format!("{root}/commits/{}/check-runs?per_page=100", pull.head.sha);
                        let status_route =
                            format!("{root}/commits/{}/status?per_page=100", pull.head.sha);
                        let (files, comments, reviews, checks, statuses) = tokio::try_join!(
                            self.page::<File>(&files_route, &cancel),
                            self.page::<Comment>(&comments_route, &cancel),
                            self.page::<Review>(&reviews_route, &cancel),
                            async {
                                decode::<CheckPage>(self.get(&checks_route, cancel.clone()).await?)
                            },
                            async {
                                decode::<CommitStatus>(
                                    self.get(&status_route, cancel.clone()).await?,
                                )
                            },
                        )?;
                        if checks
                            .check_runs
                            .iter()
                            .any(|c| c.head_sha != pull.head.sha)
                            || statuses.sha != pull.head.sha
                        {
                            return Err(invalid());
                        }
                        let truncated = checks.total_count > checks.check_runs.len()
                            || statuses.total_count > statuses.statuses.len();
                        let mut result = pull.summary(repo);
                        result["body"] = json!(pull.body.unwrap_or_default());
                        result["baseBranch"] = json!(pull.base.name);
                        result["additions"] = json!(pull.additions.ok_or_else(invalid)?);
                        result["deletions"] = json!(pull.deletions.ok_or_else(invalid)?);
                        result["changedFiles"] = json!(pull.changed_files.ok_or_else(invalid)?);
                        result["mergeable"] = json!(pull.mergeable);
                        result["mergeableState"] = json!(pull.mergeable_state);
                        result["filesHasMore"] = json!(
                            files.len() == PAGE_SIZE
                                && pull.changed_files.unwrap_or(0) > PAGE_SIZE as u64
                        );
                        result["commentsHasMore"] = json!(comments.len() == PAGE_SIZE);
                        result["reviewsHasMore"] = json!(reviews.len() == PAGE_SIZE);
                        result["inlineCommentCount"] = json!(pull.review_comments.unwrap_or(0));
                        result["commentCount"] = json!(pull.comments.unwrap_or(0));
                        result["files"] = json!(files.into_iter().map(file).collect::<Vec<_>>());
                        result["comments"] =
                            json!(comments.into_iter().map(comment).collect::<Vec<_>>());
                        result["reviews"] =
                            json!(reviews.into_iter().map(review).collect::<Vec<_>>());
                        result["checks"] = json!(checks
                            .check_runs
                            .into_iter()
                            .map(check)
                            .chain(statuses.statuses.into_iter().map(status))
                            .collect::<Vec<_>>());
                        result["checksTruncated"] = json!(truncated);
                        result
                    }
                    _ => return Err(bad()),
                };
                if self.pull(&root, number, &cancel).await?.head.sha != pull.head.sha {
                    return Err(failure(
                        "head_changed",
                        "PR changed while loading; refresh to read current checks",
                    ));
                }
                result
            }
        };
        // Global gh account changes must never mix one user's list with another
        // user's details. No shared response cache or token copies are retained.
        self.account(account, &cancel).await?;
        Ok(value)
    }
}

#[async_trait]
impl GitHubBackend for NativeGitHub {
    async fn read(
        &self,
        endpoint: &str,
        payload: &Value,
        cancel: CancellationToken,
    ) -> Result<Value, RpcError> {
        // Entire operation (including permit queue and all detail reads) is
        // bounded, not just each HTTP/CLI request individually.
        tokio::select! {
            _ = cancel.cancelled() => Err(failure("cancelled", "GitHub request cancelled")),
            result = tokio::time::timeout(Duration::from_secs(120), self.read_inner(endpoint,payload,cancel.clone())) =>
                result.unwrap_or_else(|_| Err(failure("timeout", "GitHub operation timed out"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Fixture {
        mode: &'static str,
        users: AtomicUsize,
        pulls: AtomicUsize,
    }
    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn pull() -> Value {
        json!({"number":7,"title":"Real-shaped PR","body":"Description","user":{"login":"alice"},"updated_at":"2026-10-04T00:00:00Z","state":"open","draft":false,"head":{"ref":"topic","sha":SHA},"base":{"ref":"master","sha":SHA},"additions":3,"deletions":1,"changed_files":2,"mergeable":null,"mergeable_state":"unknown","comments":0,"review_comments":1})
    }
    #[async_trait]
    impl GitHubReader for Fixture {
        async fn get(
            &self,
            route: &str,
            cancellation: CancellationToken,
        ) -> Result<Value, RpcError> {
            if self.mode == "pending" {
                cancellation.cancelled().await;
                return Err(failure("cancelled", "cancelled"));
            }
            if route == "/user" {
                let n = self.users.fetch_add(1, Ordering::SeqCst);
                return Ok(json!({"login":if self.mode=="account"&&n>0 {"bob"}else{"alice"}}));
            }
            if route.starts_with("/user/repos?") {
                return Ok(json!([{"full_name":"alice/project"}]));
            }
            if route == "/repos/alice/project/pulls/7" {
                let n = self.pulls.fetch_add(1, Ordering::SeqCst);
                let mut value = pull();
                if self.mode == "head" && n > 0 {
                    value["head"]["sha"] = json!("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
                }
                return Ok(value);
            }
            if route.contains("/files?") {
                return Ok(
                    json!([{"filename":"a.rs","status":"modified","additions":3,"deletions":1,"patch":"@@ -1 +1 @@\n-old\n+new"},{"filename":"binary.png","status":"added","additions":0,"deletions":0}]),
                );
            }
            if route.contains("/comments?") || route.contains("/reviews?") {
                return Ok(json!([]));
            }
            if route.contains("/check-runs?") {
                return Ok(
                    json!({"total_count":if self.mode=="truncated" {101}else{1},"check_runs":[{"id":1,"name":"test","status":"in_progress","conclusion":null,"head_sha":if self.mode=="wrong_sha" {"different"}else{SHA}}]}),
                );
            }
            if route.contains("/status?") {
                return Ok(
                    json!({"sha":SHA,"total_count":1,"statuses":[{"id":2,"context":"legacy CI","state":"failure","description":"failed"}]}),
                );
            }
            if route.contains("/pulls?") {
                return Ok(json!([pull()]));
            }
            Err(invalid())
        }
    }
    fn service(mode: &'static str) -> NativeGitHub {
        NativeGitHub::new(Arc::new(Fixture {
            mode,
            users: AtomicUsize::new(0),
            pulls: AtomicUsize::new(0),
        }))
    }
    fn args() -> Value {
        json!({"args":{"account":"alice","repository":"alice/project","number":7}})
    }
    struct ActiveRead(Arc<AtomicUsize>);
    impl Drop for ActiveRead {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }
    struct ConcurrentFixture {
        fixture: Fixture,
        active: Arc<AtomicUsize>,
        peak: AtomicUsize,
        entered: tokio::sync::mpsc::UnboundedSender<()>,
        release: tokio::sync::Notify,
        released: std::sync::atomic::AtomicBool,
    }
    #[async_trait]
    impl GitHubReader for ConcurrentFixture {
        async fn get(&self, route: &str, cancel: CancellationToken) -> Result<Value, RpcError> {
            if route.contains('?') {
                let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
                let _guard = ActiveRead(Arc::clone(&self.active));
                self.peak.fetch_max(active, Ordering::SeqCst);
                let notified = self.release.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let _ = self.entered.send(());
                if !self.released.load(Ordering::SeqCst) {
                    tokio::select! {
                        _ = notified => {},
                        _ = cancel.cancelled() => return Err(failure("cancelled", "cancelled")),
                    }
                }
            }
            self.fixture.get(route, cancel).await
        }
    }
    fn concurrent_reader() -> (
        Arc<ConcurrentFixture>,
        tokio::sync::mpsc::UnboundedReceiver<()>,
    ) {
        let (entered, rx) = tokio::sync::mpsc::unbounded_channel();
        (
            Arc::new(ConcurrentFixture {
                fixture: Fixture {
                    mode: "normal",
                    users: AtomicUsize::new(0),
                    pulls: AtomicUsize::new(0),
                },
                active: Arc::new(AtomicUsize::new(0)),
                peak: AtomicUsize::new(0),
                entered,
                release: tokio::sync::Notify::new(),
                released: std::sync::atomic::AtomicBool::new(false),
            }),
            rx,
        )
    }
    #[tokio::test]
    async fn detail_fanout_is_parallel_and_transport_concurrency_is_globally_bounded() {
        let (reader, mut entered) = concurrent_reader();
        let service = Arc::new(NativeGitHub::new(reader.clone()));
        let mut jobs = Vec::new();
        for _ in 0..3 {
            let service = Arc::clone(&service);
            jobs.push(tokio::spawn(async move {
                service
                    .read("github/detail", &args(), CancellationToken::new())
                    .await
            }));
        }
        for _ in 0..4 {
            tokio::time::timeout(Duration::from_secs(2), entered.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert_eq!(reader.active.load(Ordering::SeqCst), 4);
        assert!(entered.try_recv().is_err());
        reader.released.store(true, Ordering::SeqCst);
        reader.release.notify_waiters();
        for job in jobs {
            assert!(job.await.unwrap().is_ok());
        }
        assert!(reader.peak.load(Ordering::SeqCst) <= 4);
        assert_eq!(reader.active.load(Ordering::SeqCst), 0);
    }
    #[tokio::test]
    async fn cancellation_drops_parallel_reads_and_releases_all_transport_permits() {
        let (reader, mut entered) = concurrent_reader();
        let service = Arc::new(NativeGitHub::new(reader.clone()));
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let running = Arc::clone(&service);
        let job =
            tokio::spawn(async move { running.read("github/detail", &args(), task_cancel).await });
        for _ in 0..4 {
            tokio::time::timeout(Duration::from_secs(2), entered.recv())
                .await
                .unwrap()
                .unwrap();
        }
        cancel.cancel();
        assert_eq!(job.await.unwrap().unwrap_err().details["kind"], "cancelled");
        assert_eq!(reader.active.load(Ordering::SeqCst), 0);
        assert_eq!(service.reads.available_permits(), 4);
    }
    #[tokio::test]
    async fn detail_keeps_null_mergeability_and_binary_diff_and_current_sha_checks() {
        let value = service("normal")
            .read("github/detail", &args(), CancellationToken::new())
            .await
            .unwrap();
        assert!(value["mergeable"].is_null());
        assert!(value["files"][1]["patch"].is_null());
        assert_eq!(value["checks"][0]["status"], "in_progress");
        assert!(value["checks"][0]["conclusion"].is_null());
        assert_eq!(value["checks"][1]["conclusion"], "failure");
        assert_eq!(value["headSha"], SHA);
    }
    #[tokio::test]
    async fn account_and_head_changes_do_not_return_mixed_results() {
        for (mode, kind) in [
            ("account", "account_changed"),
            ("head", "head_changed"),
            ("wrong_sha", "invalid_response"),
        ] {
            let error = service(mode)
                .read("github/detail", &args(), CancellationToken::new())
                .await
                .unwrap_err();
            assert_eq!(error.details["kind"], kind);
        }
    }
    #[tokio::test]
    async fn pagination_keeps_head_fence_and_reports_incomplete_checks() {
        let value = service("truncated")
            .read("github/detail", &args(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(value["checksTruncated"], true);
        let mut request = args();
        request["args"]["sha"] = json!("old");
        assert_eq!(
            service("normal")
                .read("github/files", &request, CancellationToken::new())
                .await
                .unwrap_err()
                .details["kind"],
            "head_changed"
        );
    }
    #[tokio::test]
    async fn routes_and_page_ranges_are_read_only_and_validated() {
        for endpoint in ["github/merge", "github/login", "github/../credentials"] {
            assert_eq!(
                service("normal")
                    .read(endpoint, &args(), CancellationToken::new())
                    .await
                    .unwrap_err()
                    .code,
                RpcErrorCode::BadRequest
            );
        }
        for repo in [
            "a/../../user",
            "a/b?x=1",
            "a/b/c",
            "a/.",
            "a/..",
            "-H/--help",
        ] {
            if repo == "-H/--help" {
                continue;
            } // Allowed names are still placed only inside a /repos path, never argv.
            let mut request = args();
            request["args"]["repository"] = json!(repo);
            assert_eq!(
                service("normal")
                    .read("github/pulls", &request, CancellationToken::new())
                    .await
                    .unwrap_err()
                    .code,
                RpcErrorCode::BadRequest
            );
        }
        for page in [0, 61] {
            let mut request = args();
            request["args"]["page"] = json!(page);
            assert_eq!(
                service("normal")
                    .read("github/files", &request, CancellationToken::new())
                    .await
                    .unwrap_err()
                    .code,
                RpcErrorCode::BadRequest
            );
        }
        assert!(repository(Some("alice/repo.name-1")).is_ok());
    }
    #[tokio::test]
    async fn cancellation_drops_an_inflight_read() {
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move {
            service("pending")
                .read("github/auth", &json!({}), token)
                .await
        });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err()
                .code,
            RpcErrorCode::Cancelled
        );
    }
    #[tokio::test]
    async fn credential_collectors_are_bounded() {
        assert_eq!(
            bounded_read(&vec![0u8; MAX_BYTES + 1][..])
                .await
                .unwrap_err()
                .details["kind"],
            "response_too_large"
        );
    }
    #[tokio::test]
    async fn dynamic_rpc_uses_existing_envelope_and_accepts_no_mutation() {
        use xharness_api::{ApiBackend, RpcId, RpcResult};
        let host = xharness_host::BasicHost::new(
            xharness_host::HostConfig::new(std::env::temp_dir()),
            None,
            Arc::new(xharness_host::NoTools),
        );
        host.install_github(Arc::new(service("normal"))).unwrap();
        let reply = host
            .call_dynamic(
                RpcId::new("github-wire"),
                "github/detail",
                args(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let value = serde_json::to_value(reply).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["value"]["headSha"], SHA);
        let denied = host
            .call_dynamic(
                RpcId::new("github-write"),
                "github/merge",
                args(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(matches!(denied, RpcResult::Failure { .. }));
        if let Some(path) = std::env::var_os("XHARNESS_GITHUB_WIRE_FIXTURE") {
            std::fs::write(path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        }
    }
}
