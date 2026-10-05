//! Bounded, on-demand evidence. Do not add these heavyweight reads to bootstrap.
use super::*;
const THREADS: &str = r#"query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid reviewThreads(first:20,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated path line startLine diffSide comments(first:20){pageInfo{hasNextPage endCursor} nodes{id body createdAt author{login} url}}}}}}}"#;
const COMMENTS: &str = r#"query($id:ID!,$cursor:String){node(id:$id){... on PullRequestReviewThread{id pullRequest{number repository{nameWithOwner}} comments(first:20,after:$cursor){pageInfo{hasNextPage endCursor} nodes{id body createdAt author{login} url}}}}}"#;
fn connection(v: &Value) -> Result<Value, RpcError> {
    let info = &v["pageInfo"];
    let more = info["hasNextPage"].as_bool().ok_or_else(invalid)?;
    let cursor = info["endCursor"].as_str();
    if more && cursor.is_none() {
        return Err(invalid());
    }
    let nodes = v["nodes"]
        .as_array()
        .filter(|v| v.len() <= 20)
        .ok_or_else(invalid)?;
    let mut items = Vec::new();
    for node in nodes {
        items.push(json!({"id":node["id"].as_str().ok_or_else(invalid)?,"body":node["body"].as_str().ok_or_else(invalid)?,"author":node["author"]["login"].as_str().unwrap_or("[deleted]"),"createdAt":node["createdAt"].as_str().ok_or_else(invalid)?,"url":node["url"].as_str().ok_or_else(invalid)?}));
    }
    Ok(json!({"items":items,"hasMore":more,"cursor":cursor}))
}
fn permitted_sha(pull: &Pull, sha: &str) -> bool {
    sha == pull.head.sha || pull.merge_commit_sha.as_deref() == Some(sha)
}
impl NativeGitHub {
    pub(super) async fn evidence(
        &self,
        endpoint: &str,
        args: &Request,
        pull: &Pull,
        root: &str,
        cancel: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let _permit = tokio::select! {_=cancel.cancelled()=>return Err(failure("cancelled","GitHub request cancelled")), p=self.reads.acquire()=>p.map_err(|_|invalid())?};
        match endpoint {
            "github/threads" | "github/thread-comments" => {
                let repo = args.repository.as_deref().ok_or_else(bad)?;
                let (owner, name) = repo.split_once('/').ok_or_else(bad)?;
                let (query, variables) = if endpoint == "github/threads" {
                    (
                        THREADS,
                        json!({"owner":owner,"repo":name,"number":pull.number,"cursor":args.cursor}),
                    )
                } else {
                    let id = args
                        .thread
                        .as_deref()
                        .filter(|v| {
                            !v.is_empty()
                                && v.len() <= 256
                                && v.bytes().all(|b| b.is_ascii_graphic())
                        })
                        .ok_or_else(bad)?;
                    (COMMENTS, json!({"id":id,"cursor":args.cursor}))
                };
                let response = self
                    .reader
                    .graphql(query, variables, cancel.clone())
                    .await?;
                if response
                    .get("errors")
                    .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
                {
                    return Err(failure(
                        "permission",
                        "GitHub thread query unavailable or denied",
                    ));
                }
                if endpoint == "github/thread-comments" {
                    let node = &response["data"]["node"];
                    if node["pullRequest"]["number"] != pull.number
                        || !node["pullRequest"]["repository"]["nameWithOwner"]
                            .as_str()
                            .is_some_and(|v| v.eq_ignore_ascii_case(repo))
                    {
                        return Err(bad());
                    }
                    return connection(&node["comments"]);
                }
                let pr = &response["data"]["repository"]["pullRequest"];
                if pr["headRefOid"].as_str() != Some(&pull.head.sha) {
                    return Err(failure(
                        "head_changed",
                        "PR head changed; refresh discussions",
                    ));
                }
                let threads = &pr["reviewThreads"];
                let nodes = threads["nodes"]
                    .as_array()
                    .filter(|n| n.len() <= 20)
                    .ok_or_else(invalid)?;
                let mut items = Vec::new();
                for t in nodes {
                    items.push(json!({"id":t["id"].as_str().ok_or_else(invalid)?,"resolved":t["isResolved"].as_bool().ok_or_else(invalid)?,"outdated":t["isOutdated"].as_bool().ok_or_else(invalid)?,"path":t["path"].as_str().ok_or_else(invalid)?,"line":t["line"],"startLine":t["startLine"],"side":match t["diffSide"].as_str(){Some("LEFT")=>"left",Some("RIGHT")=>"right",_=>return Err(invalid())},"comments":connection(&t["comments"])?}));
                }
                let more = threads["pageInfo"]["hasNextPage"]
                    .as_bool()
                    .ok_or_else(invalid)?;
                let cursor = threads["pageInfo"]["endCursor"].as_str();
                if more && cursor.is_none() {
                    return Err(invalid());
                }
                Ok(json!({"items":items,"hasMore":more,"cursor":cursor}))
            }
            "github/runs" => {
                let page = args.page.unwrap_or(1);
                let mut items = Vec::new();
                let mut more = false;
                for sha in [
                    Some(pull.head.sha.as_str()),
                    pull.merge_commit_sha.as_deref(),
                ]
                .into_iter()
                .flatten()
                {
                    if sha.len() != 40 || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Err(invalid());
                    }
                    let value = self
                        .reader
                        .get(
                            &format!("{root}/actions/runs?head_sha={sha}&per_page=20&page={page}"),
                            cancel.clone(),
                        )
                        .await?;
                    let rows = value["workflow_runs"]
                        .as_array()
                        .filter(|v| v.len() <= 20)
                        .ok_or_else(invalid)?;
                    more |= rows.len() == 20;
                    for r in rows {
                        if r["head_sha"].as_str() != Some(sha) {
                            return Err(invalid());
                        }
                        items.push(json!({"id":r["id"],"name":r["name"].as_str().unwrap_or("Workflow"),"status":r["status"],"conclusion":r["conclusion"],"headSha":sha,"attempt":r["run_attempt"],"mergeTest":sha!=pull.head.sha}));
                    }
                }
                items.sort_by_key(|v| std::cmp::Reverse(v["id"].as_u64().unwrap_or(0)));
                items.dedup_by_key(|v| v["id"].clone());
                Ok(json!({"items":items,"hasMore":more}))
            }
            "github/jobs" | "github/logs" => {
                let run = args
                    .run
                    .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
                    .ok_or_else(bad)?;
                let value = self
                    .reader
                    .get(&format!("{root}/actions/runs/{run}"), cancel.clone())
                    .await?;
                let sha = value["head_sha"].as_str().ok_or_else(invalid)?;
                if value["id"] != run || !permitted_sha(pull, sha) {
                    return Err(failure(
                        "head_changed",
                        "Workflow is not for this PR commit",
                    ));
                }
                let attempt = value["run_attempt"]
                    .as_u64()
                    .filter(|v| *v > 0)
                    .ok_or_else(invalid)?;
                if args.attempt.is_some_and(|expected| expected != attempt) {
                    return Err(failure(
                        "head_changed",
                        "Workflow attempt changed; refresh jobs",
                    ));
                }
                if endpoint == "github/jobs" {
                    let page = args.page.unwrap_or(1);
                    let v=self.reader.get(&format!("{root}/actions/runs/{run}/attempts/{attempt}/jobs?per_page=20&page={page}"),cancel.clone()).await?;
                    let jobs = v["jobs"]
                        .as_array()
                        .filter(|v| v.len() <= 20)
                        .ok_or_else(invalid)?;
                    if jobs
                        .iter()
                        .any(|j| j["run_id"] != run || j["head_sha"].as_str() != Some(sha))
                    {
                        return Err(invalid());
                    }
                    let current = self
                        .reader
                        .get(&format!("{root}/actions/runs/{run}"), cancel.clone())
                        .await?;
                    if current["run_attempt"] != attempt {
                        return Err(failure(
                            "head_changed",
                            "Workflow rerun started; refresh jobs",
                        ));
                    }
                    let items=jobs.iter().map(|j|json!({"id":j["id"],"name":j["name"],"status":j["status"],"conclusion":j["conclusion"],"steps":j["steps"]})).collect::<Vec<_>>();
                    Ok(json!({"items":items,"hasMore":jobs.len()==20,"attempt":attempt}))
                } else {
                    let job = args
                        .job
                        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
                        .ok_or_else(bad)?;
                    let v = self
                        .reader
                        .get(&format!("{root}/actions/jobs/{job}"), cancel.clone())
                        .await?;
                    if v["run_id"] != run
                        || v["head_sha"].as_str() != Some(sha)
                        || v["run_attempt"].as_u64().is_some_and(|a| a != attempt)
                    {
                        return Err(failure(
                            "head_changed",
                            "Job is not for the selected workflow attempt",
                        ));
                    }
                    let result = self
                        .reader
                        .logs(&format!("{root}/actions/jobs/{job}/logs"), cancel.clone())
                        .await?;
                    let current = self
                        .reader
                        .get(&format!("{root}/actions/runs/{run}"), cancel.clone())
                        .await?;
                    if current["run_attempt"] != attempt {
                        return Err(failure(
                            "head_changed",
                            "Workflow rerun started; refresh logs",
                        ));
                    }
                    Ok(result)
                }
            }
            _ => Err(bad()),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    struct Fixture {
        wrong: bool,
        rerun: AtomicBool,
    }
    #[async_trait]
    impl GitHubReader for Fixture {
        async fn get(&self, route: &str, _: CancellationToken) -> Result<Value, RpcError> {
            if route == "/user" {
                return Ok(json!({"login":"alice"}));
            }
            if route == "/repos/alice/project/pulls/7" {
                return Ok(super::super::tests::pull());
            }
            if route.ends_with("/actions/runs/9") {
                return Ok(
                    json!({"id":9,"head_sha":if self.wrong{"bad"}else{super::super::tests::SHA},"run_attempt":if self.rerun.load(Ordering::SeqCst){2}else{1}}),
                );
            }
            if route.ends_with("/actions/jobs/10") {
                return Ok(json!({"run_id":9,"head_sha":super::super::tests::SHA,"run_attempt":1}));
            }
            if route.contains("/attempts/1/jobs?") {
                return Ok(
                    json!({"jobs":[{"id":10,"run_id":9,"head_sha":super::super::tests::SHA,"name":"test","status":"completed","conclusion":"failure","steps":[{"name":"tests","number":1,"status":"completed","conclusion":"failure"}]}]}),
                );
            }
            if route.contains("/actions/runs?") {
                return Ok(
                    json!({"workflow_runs":[{"id":9,"head_sha":super::super::tests::SHA,"name":"CI","status":"completed","conclusion":"failure","run_attempt":1}]}),
                );
            }
            Err(invalid())
        }
        async fn graphql(
            &self,
            query: &str,
            _: Value,
            _: CancellationToken,
        ) -> Result<Value, RpcError> {
            let comments = json!({"nodes":[{"id":"c1","author":{"login":"reviewer"},"createdAt":"2026-10-04T00:00:00Z","body":"Actual comment","url":"https://github.com/alice/project/pull/7#discussion_r1"}],"pageInfo":{"hasNextPage":true,"endCursor":"cursor2"}});
            if query.contains("node(id:") {
                return Ok(
                    json!({"data":{"node":{"id":"t1","pullRequest":{"number":if self.wrong{8}else{7},"repository":{"nameWithOwner":"alice/project"}},"comments":comments}}}),
                );
            }
            Ok(
                json!({"data":{"repository":{"pullRequest":{"headRefOid":if self.wrong{"wrong"}else{super::super::tests::SHA},"reviewThreads":{"nodes":[{"id":"t1","isResolved":false,"isOutdated":true,"path":"a.rs","line":null,"startLine":null,"diffSide":"RIGHT","comments":comments}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}),
            )
        }
        async fn logs(&self, _: &str, _: CancellationToken) -> Result<Value, RpcError> {
            self.rerun.store(true, Ordering::SeqCst);
            Ok(json!({"text":"test failed","truncated":false}))
        }
    }
    fn fixture(wrong: bool) -> NativeGitHub {
        NativeGitHub::new(Arc::new(Fixture {
            wrong,
            rerun: AtomicBool::new(false),
        }))
    }
    fn args() -> Value {
        json!({"args":{"account":"alice","repository":"alice/project","number":7,"sha":super::super::tests::SHA}})
    }
    #[tokio::test]
    async fn threads_preserve_resolution_outdated_nullable_locations_and_nested_pagination() {
        let v = fixture(false)
            .read("github/threads", &args(), CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(v["items"][0]["outdated"], true);
        assert_eq!(v["items"][0]["resolved"], false);
        assert_eq!(v["items"][0]["line"], Value::Null);
        assert_eq!(v["items"][0]["comments"]["cursor"], "cursor2");
    }
    #[tokio::test]
    async fn thread_comments_cannot_cross_pr() {
        let mut a = args();
        a["args"]["thread"] = json!("t1");
        assert!(fixture(true)
            .read("github/thread-comments", &a, CancellationToken::new())
            .await
            .is_err());
        assert_eq!(
            fixture(false)
                .read("github/thread-comments", &a, CancellationToken::new())
                .await
                .unwrap()["hasMore"],
            true
        );
    }
    #[tokio::test]
    async fn jobs_and_steps_are_bound_to_verified_commit() {
        let mut a = args();
        a["args"]["run"] = json!(9);
        assert!(fixture(true)
            .read("github/jobs", &a, CancellationToken::new())
            .await
            .is_err());
        assert_eq!(
            fixture(false)
                .read("github/jobs", &a, CancellationToken::new())
                .await
                .unwrap()["items"][0]["steps"][0]["conclusion"],
            "failure"
        );
    }
    #[tokio::test]
    async fn rerun_during_log_read_cannot_install_old_attempt() {
        let mut a = args();
        a["args"]["run"] = json!(9);
        a["args"]["job"] = json!(10);
        assert_eq!(
            fixture(false)
                .read("github/logs", &a, CancellationToken::new())
                .await
                .unwrap_err()
                .details["kind"],
            "head_changed"
        );
    }
    #[tokio::test]
    async fn evidence_requires_head_and_valid_cursor() {
        let mut a = args();
        a["args"].as_object_mut().unwrap().remove("sha");
        assert!(fixture(false)
            .read("github/threads", &a, CancellationToken::new())
            .await
            .is_err());
        let mut a = args();
        a["args"]["cursor"] = json!("\n");
        assert!(fixture(false)
            .read("github/threads", &a, CancellationToken::new())
            .await
            .is_err());
    }
    #[tokio::test]
    async fn selected_attempt_cannot_silently_load_another_rerun() {
        let mut a = args();
        a["args"]["run"] = json!(9);
        a["args"]["attempt"] = json!(2);
        assert_eq!(
            fixture(false)
                .read("github/jobs", &a, CancellationToken::new())
                .await
                .unwrap_err()
                .details["kind"],
            "head_changed"
        );
    }
}
