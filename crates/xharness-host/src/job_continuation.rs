//! Durable terminal-Job outbox. Producers never own model execution.
use crate::{driver::PromptAdmission, BasicHost};
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex as StdMutex, Weak,
    },
};
use tokio::{sync::Mutex, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use xharness_jobs::{
    continuation::JobContinuationPort, JobError, JobEventKind, JobOutputCursor, JobRegistry,
};
use xharness_session::{
    EventData, JobContinuationRecord as Record, JobContinuationState as State, Session, Store,
    StoreError,
};

pub fn records(session: &Session) -> BTreeMap<String, Record> {
    let mut rows = BTreeMap::new();
    for event in session.events() {
        match event.data() {
            EventData::JobContinuation { record } => {
                rows.insert(record.job_id.clone(), (**record).clone());
            }
            // A conversation fork inherits transcript, not producer ownership.
            EventData::SessionForkOrigin { .. } => rows.clear(),
            _ => {}
        }
    }
    rows
}
pub fn has_pending(session: &Session) -> bool {
    records(session)
        .values()
        .any(|r| matches!(r.state, State::Registered | State::Settled))
}
fn tail(s: &str, limit: usize) -> String {
    let mut start = s.len().saturating_sub(limit);
    while !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_owned()
}

pub struct JobContinuationController {
    jobs: Arc<JobRegistry>,
    store: Arc<dyn Store>,
    host: Weak<BasicHost>,
    owners: StdMutex<BTreeSet<String>>,
    gates: StdMutex<BTreeMap<String, Weak<Mutex<()>>>>,
    stop: CancellationToken,
    delivery: AtomicBool,
    worker: StdMutex<Option<JoinHandle<()>>>,
}
impl JobContinuationController {
    pub fn new(jobs: Arc<JobRegistry>, store: Arc<dyn Store>, host: &Arc<BasicHost>) -> Arc<Self> {
        Arc::new(Self {
            jobs,
            store,
            host: Arc::downgrade(host),
            owners: StdMutex::new(BTreeSet::new()),
            gates: StdMutex::new(BTreeMap::new()),
            stop: CancellationToken::new(),
            delivery: AtomicBool::new(true),
            worker: StdMutex::new(None),
        })
    }
    fn gate(&self, owner: &str) -> Arc<Mutex<()>> {
        let mut gates = self.gates.lock().unwrap();
        gates.retain(|_, g| g.strong_count() > 0);
        if let Some(g) = gates.get(owner).and_then(Weak::upgrade) {
            return g;
        }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(owner.into(), Arc::downgrade(&gate));
        gate
    }
    async fn load(&self, owner: &str) -> Result<Session, String> {
        self.store
            .load(owner)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Job continuation session not found".into())
    }
    // Compare the prior logical state on EVERY CAS retry. Never overwrite a
    // concurrent cancellation or a terminal acknowledgement with a stale row.
    async fn transition(
        &self,
        owner: &str,
        prior: Option<&Record>,
        row: &Record,
    ) -> Result<bool, String> {
        row.validate().map_err(str::to_owned)?;
        for _ in 0..16 {
            let cut = self.load(owner).await?;
            if records(&cut).get(&row.job_id) != prior {
                return Ok(false);
            }
            match self
                .store
                .append(
                    owner,
                    cut.revision(),
                    vec![EventData::JobContinuation {
                        record: Box::new(row.clone()),
                    }
                    .into()],
                )
                .await
            {
                Ok(_) => {
                    self.store.flush(owner).await.map_err(|e| e.to_string())?;
                    return Ok(true);
                }
                Err(StoreError::RevisionConflict { .. }) => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("Job continuation journal remained busy".into())
    }
    fn completion(&self, owner: &str, id: &str) -> Result<Option<Value>, String> {
        match self.jobs.get(owner, id) {
            Ok(snapshot) if !snapshot.status.is_terminal() => Ok(None),
            Ok(snapshot) => {
                let read = self
                    .jobs
                    .read_since(owner, id, &JobOutputCursor::start(id))
                    .map_err(|e| e.to_string())?;
                Ok(Some(
                    json!({"snapshot": {"id":id,"kind":snapshot.kind,"status":snapshot.status,
                    "detail":snapshot.detail.as_deref().map(|s|tail(s,512)), "started_at_ms":snapshot.started_at_ms,
                    "finished_at_ms":snapshot.finished_at_ms}, "stdout":tail(&read.stdout,8192),"stderr":tail(&read.stderr,8192),
                    "stdout_truncated":read.stdout_truncated || read.stdout.len()>8192,
                    "stderr_truncated":read.stderr_truncated || read.stderr.len()>8192,
                    "archived":true,"cursor_supported":false,"next_cursor":null}),
                ))
            }
            Err(JobError::NotFound { .. }) => {
                Ok(Some(json!({"snapshot":{"id":id,"status":"interrupted",
                "detail":"Original Job Registry generation unavailable. Side effects are unknown; do not automatically replay the script."},
                "stdout":"","stderr":"","archived":true,"cursor_supported":false,"next_cursor":null})))
            }
            Err(e) => Err(e.to_string()),
        }
    }
    pub async fn reconcile_owner(&self, owner: &str) -> Result<(), String> {
        let gate = self.gate(owner);
        let _guard = gate.lock().await;
        let cut = match self.store.load(owner).await.map_err(|e| e.to_string())? {
            Some(s) => s,
            None => {
                self.owners.lock().unwrap().remove(owner);
                return Ok(());
            }
        };
        for mut row in records(&cut).into_values() {
            if row.state == State::Registered {
                let Some(completion) = self.completion(owner, &row.job_id)? else {
                    continue;
                };
                let prior = row.clone();
                row.state = State::Settled;
                row.completion = Some(completion);
                if !self.transition(owner, Some(&prior), &row).await? {
                    continue;
                }
            }
            if row.state == State::Settled
                && self.delivery.load(Ordering::Acquire)
                && !self.stop.is_cancelled()
            {
                let host = self
                    .host
                    .upgrade()
                    .ok_or("Job continuation Host unavailable")?;
                let completion = row
                    .completion
                    .as_ref()
                    .ok_or("missing terminal Job snapshot")?;
                let status = completion["snapshot"]["status"]
                    .as_str()
                    .unwrap_or("interrupted");
                let text = format!("Background Job {} settled with status={status}.\nContinuation: {}\nRead job_output(job_id=\"{}\") for the retained terminal result, then continue the dependent work. Failed/killed/interrupted is not success. Unknown side effects must not be automatically replayed.", row.job_id, row.continuation, row.job_id);
                let admitted = host
                    .enqueue_internal_once(
                        self.store.as_ref(),
                        owner,
                        &row.id,
                        &text,
                        json!({"kind":"job-settlement","jobId":row.job_id,"status":status}),
                    )
                    .await?;
                if !admitted {
                    continue;
                }
                let prior = row.clone();
                row.state = State::Delivered;
                self.transition(owner, Some(&prior), &row).await?;
            }
        }
        if !has_pending(&self.load(owner).await?) {
            self.owners.lock().unwrap().remove(owner);
        }
        Ok(())
    }
    pub async fn reconcile(&self) -> Result<(), String> {
        let owners: Vec<_> = self.owners.lock().unwrap().iter().cloned().collect();
        let mut errors = Vec::new();
        for owner in owners {
            if let Err(error) = self.reconcile_owner(&owner).await {
                errors.push(error);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    /// Call after Host catalogue/configuration readiness. Idempotent; no producer replay.
    pub async fn recover(&self) -> Result<(), String> {
        let (headers, unreadable) = self
            .store
            // Full enumeration validates every transcript before the idle
            // check below, defeating the catalogue and blocking cold readers.
            // Candidates are only headers; unknown/pending sources still load.
            .scan_startup_candidates()
            .await
            .map_err(|e| e.to_string())?;
        let mut errors: Vec<_> = unreadable.into_iter().map(|u| u.reason).collect();
        for header in headers {
            // A source-verified idle catalogue avoids replaying every old chat
            // a second time. A missing/stale/unknown catalogue is NEVER idle.
            if self
                .store
                .catalog_entry(&header.id)
                .await
                .ok()
                .flatten()
                .is_some_and(|c| !c.needs_recovery)
            {
                continue;
            }
            match self.store.load(&header.id).await {
                Ok(Some(session)) if has_pending(&session) => {
                    self.owners.lock().unwrap().insert(header.id);
                }
                Ok(_) => {}
                Err(error) => {
                    self.owners.lock().unwrap().insert(header.id);
                    errors.push(error.to_string());
                }
            }
        }
        if let Err(error) = self.reconcile().await {
            errors.push(error);
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
    pub fn start(self: &Arc<Self>) {
        let mut worker = self.worker.lock().unwrap();
        if worker.is_some() || self.stop.is_cancelled() {
            return;
        }
        let weak = Arc::downgrade(self);
        let stop = self.stop.clone();
        let mut events = self.jobs.subscribe();
        *worker = Some(tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_secs(30));
            loop {
                let owner = tokio::select! { biased;
                    _ = stop.cancelled() => break,
                    event = events.recv() => { match event {
                        Ok(event) if event.kind == JobEventKind::Finished => Some(event.job.owner),
                        Ok(_) => continue,
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => None,
                    } },
                    _ = timer.tick() => None,
                };
                let Some(controller) = weak.upgrade() else {
                    break;
                };
                // Retry outbox state only, never retry an Agent turn here.
                let result = if let Some(owner) = owner {
                    if !controller.owners.lock().unwrap().contains(&owner) {
                        continue;
                    }
                    controller.reconcile_owner(&owner).await
                } else {
                    controller.reconcile().await
                };
                if let Err(error) = result {
                    eprintln!("Job continuation reconciliation failed: {error}");
                }
            }
        }));
    }
    pub fn pause_delivery(&self) {
        self.delivery.store(false, Ordering::Release);
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        self.pause_delivery();
        self.stop.cancel();
        let worker = self.worker.lock().unwrap().take();
        let mut errors = Vec::new();
        if let Some(mut worker) = worker {
            match tokio::time::timeout(std::time::Duration::from_secs(2), &mut worker).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => errors.push(e.to_string()),
                Err(_) => {
                    worker.abort();
                    let _ = worker.await;
                    errors.push("Job continuation listener shutdown timed out".into());
                }
            }
        }
        // A stuck Store must not prevent the deployment from stopping producers.
        match tokio::time::timeout(std::time::Duration::from_secs(2), self.reconcile()).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => errors.push(e),
            Err(_) => errors.push("Job continuation checkpoint shutdown timed out".into()),
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

#[async_trait]
impl JobContinuationPort for JobContinuationController {
    async fn defer(&self, owner: &str, job_id: &str, continuation: &str) -> Result<Value, String> {
        if self.stop.is_cancelled() {
            return Err("Job continuation Host is shutting down".into());
        }
        let gate = self.gate(owner);
        let guard = gate.lock().await;
        let cut = self.load(owner).await?;
        let existing = records(&cut);
        let row = if let Some(row) = existing.get(job_id) {
            row.clone()
        } else {
            self.jobs.get(owner, job_id).map_err(|e| e.to_string())?;
            if existing
                .values()
                .filter(|r| matches!(r.state, State::Registered | State::Settled))
                .count()
                >= 64
            {
                return Err("Job continuation limit reached (64 pending per session)".into());
            }
            let digest =
                Sha256::digest(serde_json::to_vec(&(owner, job_id)).map_err(|e| e.to_string())?);
            let row = Record {
                version: 1,
                id: format!("job-settlement:{digest:x}"),
                job_id: job_id.into(),
                continuation: continuation.into(),
                state: State::Registered,
                completion: None,
            };
            if !self.transition(owner, None, &row).await? {
                return Err("Job continuation registration changed concurrently; retry".into());
            }
            row
        };
        if row.continuation != continuation {
            return Err("Job already registered with a different continuation".into());
        }
        self.store.flush(owner).await.map_err(|e| e.to_string())?;
        if matches!(row.state, State::Registered | State::Settled) {
            self.owners.lock().unwrap().insert(owner.into());
        }
        drop(guard);
        self.reconcile_owner(owner).await?;
        let row = records(&self.load(owner).await?)
            .remove(job_id)
            .ok_or("Job continuation disappeared")?;
        Ok(
            json!({"kind":"deferred","job_id":job_id,"registration_id":row.id,"state":row.state,
            "pending":matches!(row.state,State::Registered|State::Settled),
            "message":"Registration does not wait for the producer. End the current turn when no independent work remains; the terminal receipt resumes it through the durable inbox."}),
        )
    }
    async fn cancel_defer(&self, owner: &str, job_id: &str) -> Result<Value, String> {
        let gate = self.gate(owner);
        let _guard = gate.lock().await;
        let host = self
            .host
            .upgrade()
            .ok_or("Job continuation Host unavailable")?;
        let _admission = host.lock_admission(owner).await;
        let cut = self.load(owner).await?;
        let Some(mut row) = records(&cut).remove(job_id) else {
            return Err("Job continuation not registered".into());
        };
        if row.state == State::Delivered || cut.events().iter().any(|e|matches!(e.data(),EventData::AgentInboxSpliced{inserted,..} if inserted.iter().any(|m|m.id==row.id))) {
            return Ok(json!({"cancelled":false,"state":"already_delivered","job_id":job_id}));
        }
        let prior = row.clone();
        row.state = State::Cancelled;
        if prior.state != State::Cancelled && !self.transition(owner, Some(&prior), &row).await? {
            return Err("Job continuation cancellation changed concurrently; retry".into());
        }
        Ok(json!({"cancelled":true,"state":"cancelled","job_id":job_id,"producer_cancelled":false}))
    }
    async fn archived_output(&self, owner: &str, job_id: &str) -> Result<Option<Value>, String> {
        Ok(records(&self.load(owner).await?)
            .remove(job_id)
            .and_then(|r| r.completion))
    }
}

impl BasicHost {
    async fn enqueue_internal_once(
        &self,
        store: &dyn Store,
        owner: &str,
        id: &str,
        text: &str,
        source: Value,
    ) -> Result<bool, String> {
        self.hydrate_session(owner)
            .await
            .map_err(|e| e.to_string())?;
        let _guard = self.lock_admission(owner).await;
        let cut = store
            .load(owner)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("continuation session not found")?;
        if records(&cut)
            .values()
            .any(|r| r.id == id && r.state == State::Cancelled)
        {
            return Ok(false);
        }
        // Durable provenance survives queue claims, compaction and acknowledgement loss.
        if cut.events().iter().any(|e| matches!(e.data(),EventData::AgentInboxSpliced{inserted,..} if inserted.iter().any(|m|m.id==id))) { store.flush(owner).await.map_err(|e|e.to_string())?; return Ok(true); }
        self.enqueue_prompt(PromptAdmission {
            rpc_id: xharness_api::RpcId::new(id),
            session_id: owner.into(),
            mode: "queue".into(),
            text: text.into(),
            content: vec![json!({"type":"text","text":text})],
            source,
            fingerprint: None,
        })
        .await
        .map_err(|e| e.message)?;
        Ok(true)
    }
}
