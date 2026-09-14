use crate::{
    store::{self, Store},
    *,
};
use rusqlite::params;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Weak},
};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use xharness_api::{ApiBackend, RpcId, RpcMethod};

type SessionGates = Mutex<HashMap<String, Weak<Mutex<()>>>>;
type PolicyGates = Mutex<HashMap<String, Weak<PolicyGate>>>;

#[derive(Default)]
pub(crate) struct PolicyGate {
    lock: Arc<RwLock<()>>,
    epoch: std::sync::atomic::AtomicU64,
}
pub(crate) struct PolicyWriteGuard {
    _guard: tokio::sync::OwnedRwLockWriteGuard<()>,
    owner: Arc<PolicyGate>,
}
impl Drop for PolicyWriteGuard {
    fn drop(&mut self) {
        // Increment before releasing the exclusive guard, including failed or
        // cancelled writes. A paused read cannot reuse a pre-write snapshot.
        self.owner
            .epoch
            .fetch_add(1, std::sync::atomic::Ordering::Release);
    }
}
impl PolicyGate {
    pub(crate) async fn read_owned(&self) -> tokio::sync::OwnedRwLockReadGuard<()> {
        self.lock.clone().read_owned().await
    }
    pub(crate) async fn read(&self) -> tokio::sync::RwLockReadGuard<'_, ()> {
        self.lock.read().await
    }
    pub(crate) async fn write(self: &Arc<Self>) -> PolicyWriteGuard {
        PolicyWriteGuard {
            _guard: self.lock.clone().write_owned().await,
            owner: self.clone(),
        }
    }
    pub(crate) fn epoch(&self) -> u64 {
        self.epoch.load(std::sync::atomic::Ordering::Acquire)
    }
    pub(crate) fn try_read(&self) -> Result<tokio::sync::RwLockReadGuard<'_, ()>, Error> {
        self.lock.try_read().map_err(|_| Error::StreamGap)
    }
}

pub struct Gateway {
    pub(crate) host_id: String,
    pub(crate) host: Arc<dyn ApiBackend>,
    pub(crate) store: Arc<Store>,
    sessions: SessionGates,
    principals: PolicyGates,
    accounts: PolicyGates,
    replies: SessionGates,
    pub(crate) subscriptions: Arc<tokio::sync::Semaphore>,
    pub(crate) creations: Arc<tokio::sync::Semaphore>,
    pub(crate) creation_idle: Arc<tokio::sync::Notify>,
}

impl Gateway {
    /// Stable public metadata, not a credential.
    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    /// Trusted executable shutdown only: stop channel workers and await the
    /// admission supervisor first. Old administrative handles become closed;
    /// accepted work remains durable. This does not cancel any Host task.
    pub async fn close(&self) -> Result<(), Error> {
        // Detached creation/control waiters are not channel connection lifetimes.
        // Stop new attempts and drain every acquired slot before closing WAL.
        self.creations.close();
        loop {
            let idle = self.creation_idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            if self.creations.available_permits() == crate::creation::CREATION_WORKERS {
                break;
            }
            idle.await;
        }
        self.store.close().await
    }

    /// Exclusive consumer ownership lasts until this Gateway and its workers drop.
    pub fn open(
        root: &Path,
        host_id: String,
        host: Arc<dyn ApiBackend>,
    ) -> Result<Arc<Self>, Error> {
        valid_id(&host_id)?;
        Ok(Arc::new(Self {
            host_id: host_id.clone(),
            host,
            store: Store::open(root, &host_id)?,
            sessions: Mutex::new(HashMap::new()),
            principals: Mutex::new(HashMap::new()),
            accounts: Mutex::new(HashMap::new()),
            replies: Mutex::new(HashMap::new()),
            subscriptions: Arc::new(tokio::sync::Semaphore::new(32)),
            creations: Arc::new(tokio::sync::Semaphore::new(
                crate::creation::CREATION_WORKERS,
            )),
            creation_idle: Arc::new(tokio::sync::Notify::new()),
        }))
    }

    pub(crate) async fn principal_gate(&self, id: &str) -> Arc<PolicyGate> {
        let mut gates = self.principals.lock().await;
        gates.retain(|_, v| v.strong_count() > 0);
        if let Some(gate) = gates.get(id).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(PolicyGate::default());
        gates.insert(id.to_owned(), Arc::downgrade(&gate));
        gate
    }
    pub(crate) async fn session_gate(&self, id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.sessions.lock().await;
        gates.retain(|_, v| v.strong_count() > 0);
        if let Some(gate) = gates.get(id).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(id.to_owned(), Arc::downgrade(&gate));
        gate
    }

    pub(crate) async fn account_gate(&self, account: &Account) -> Arc<PolicyGate> {
        let key = crate::receive::account_key(account);
        let mut gates = self.accounts.lock().await;
        gates.retain(|_, v| v.strong_count() > 0);
        if let Some(gate) = gates.get(&key).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(PolicyGate::default());
        gates.insert(key, Arc::downgrade(&gate));
        gate
    }

    pub(crate) async fn reply_gate(&self, id: &str) -> Arc<Mutex<()>> {
        let mut gates = self.replies.lock().await;
        gates.retain(|_, v| v.strong_count() > 0);
        if let Some(gate) = gates.get(id).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(id.to_owned(), Arc::downgrade(&gate));
        gate
    }

    /// Trusted desktop-only grant/update, with monotonic fencing. A revoked id
    /// cannot be resurrected: pairing again must mint a new principal id.
    pub async fn set_principal(&self, p: Principal) -> Result<(), Error> {
        valid_id(&p.id)?;
        valid_id(&p.sender.account)?;
        valid_id(&p.sender.user)?;
        for id in p.workspaces.iter().chain(&p.sessions) {
            valid_id(id)?;
        }
        if p.workspaces.len() > 256 || p.sessions.len() > 4096 {
            return Err(Error::Capacity);
        }
        if p.host != self.host_id || p.revision == 0 {
            return Err(Error::Unauthorized);
        }
        let gate = self.principal_gate(&p.id).await;
        let _guard = gate.write().await;
        self.store
            .transaction_fenced(_guard, move |tx| {
                if let Some(old) = store::entity::<Principal>(tx, "principal", &p.id)? {
                    if old.revoked
                        || old.sender != p.sender
                        || old.host != p.host
                        || Some(p.revision) != old.revision.checked_add(1)
                    {
                        return Err(Error::IdentityConflict);
                    }
                } else if p.revision != 1 {
                    return Err(Error::IdentityConflict);
                }
                store::put_entity(tx, "principal", &p.id, &p)
            })
            .await
    }

    pub async fn revoke(&self, id: &str) -> Result<(), Error> {
        let gate = self.principal_gate(id).await;
        let _guard = gate.write().await;
        let id = id.to_owned();
        self.store
            .transaction_fenced(_guard, move |tx| {
                let mut p: Principal =
                    store::entity(tx, "principal", &id)?.ok_or(Error::Unauthorized)?;
                if !p.revoked {
                    p.revoked = true;
                    // Irreversible revocation must remain possible at counter
                    // exhaustion. Never wrap; the sealed bit and policy epoch
                    // fence every scope, and this id can never be re-granted.
                    p.revision = p.revision.saturating_add(1);
                }
                store::put_entity(tx, "principal", &id, &p)
            })
            .await
    }

    /// Trusted binding, after selecting a registered workspace and authorized
    /// session in desktop settings. No controller-provided cwd is accepted.
    pub async fn bind(&self, b: Binding) -> Result<(), Error> {
        for id in [
            &b.id,
            &b.principal,
            &b.conversation,
            &b.workspace,
            &b.session,
        ] {
            valid_id(id)?;
        }
        let gate = self.principal_gate(&b.principal).await;
        let _guard = gate.write().await;
        if !self
            .host
            .session_in_workspace(&b.workspace, &b.session)
            .await
            .map_err(|_| Error::HostUnavailable)?
        {
            return Err(Error::Unauthorized);
        }
        self.store
            .transaction_fenced(_guard, move |tx| {
                let p: Principal =
                    store::entity(tx, "principal", &b.principal)?.ok_or(Error::Unauthorized)?;
                authorize(&p, &b)?;
                if let Some(old) = store::entity::<Binding>(tx, "binding", &b.id)? {
                    if old.principal != b.principal
                        || Some(b.generation) != old.generation.checked_add(1)
                    {
                        return Err(Error::IdentityConflict);
                    }
                } else if b.generation != 1 {
                    return Err(Error::IdentityConflict);
                }
                store::put_entity(tx, "binding", &b.id, &b)
            })
            .await
    }

    /// Durable acknowledgement only. Provider offsets may advance after this
    /// returns, not before. Dropping the connection cannot cancel accepted work.
    /// Sender and conversation must come from verified transport metadata.
    pub async fn accept(
        &self,
        principal: &str,
        sender: Sender,
        conversation: String,
        inbound: Inbound,
    ) -> Result<Delivery, Error> {
        validate_inbound(&conversation, &inbound)?;
        let gate = self.principal_gate(principal).await;
        let _guard = gate.read().await;
        let principal = principal.to_owned();
        let host = self.host_id.clone();
        self.store
            .transaction(move |tx| admit(tx, &host, &principal, sender, conversation, inbound))
            .await
    }

    /// Internal worker API; not an authenticated read endpoint.
    pub async fn inspect(&self, key: &str) -> Result<Option<Delivery>, Error> {
        let key = key.to_owned();
        self.store
            .transaction(move |tx| store::delivery(tx, &key))
            .await
    }

    pub async fn pending(&self) -> Result<Vec<Delivery>, Error> {
        self.store.transaction(|tx| {
            let mut q = tx.prepare("SELECT body FROM inbox AS current WHERE state IN ('queued','dispatching')
                AND NOT EXISTS (SELECT 1 FROM inbox AS earlier WHERE earlier.session=current.session AND earlier.seq<current.seq
                    AND earlier.state IN ('queued','dispatching','uncertain')) ORDER BY seq LIMIT 32")?;
            let rows = q.query_map([], |r| r.get::<_,String>(0))?;
            rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
        }).await
    }

    /// Durable-before-effect. A crashed cancellation is UNCERTAIN, never replayed
    /// against a possibly newer turn. Prompts use Host's durable receipt seam.
    pub async fn dispatch(self: &Arc<Self>, key: &str) -> Result<Delivery, Error> {
        let initial = self
            .inspect(key)
            .await?
            .ok_or(Error::Invalid("unknown request"))?;
        if matches!(initial.inbound.command, Command::CreateSession { .. }) {
            return self.dispatch_create_command(initial).await;
        }
        if matches!(initial.inbound.command, Command::AutomationControl { .. }) {
            return self.dispatch_automation_control(initial).await;
        }
        let session_gate = self.session_gate(&initial.binding.session).await;
        let _session_guard = session_gate.lock().await;
        let gate = self.principal_gate(&initial.principal).await;
        if matches!(initial.inbound.command, Command::Select { .. }) {
            return self.dispatch_selection(initial, gate.write().await).await;
        }
        let _policy_guard = gate.read().await;
        let key = key.to_owned();
        let mut d = self.store.transaction(move |tx| {
            let mut d = store::delivery(tx,&key)?.ok_or(Error::Invalid("unknown request"))?;
            if !matches!(d.state,DeliveryState::Queued | DeliveryState::Dispatching) { return Ok(d); }
            let earlier: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM inbox WHERE session=?1 AND seq<?2 AND state IN ('queued','dispatching','uncertain'))",
                params![d.binding.session,d.sequence],|r| r.get(0))?;
            if earlier { return Err(Error::SessionBlocked); }
            let p = store::entity::<Principal>(tx,"principal",&d.principal)?;
            let b = store::entity::<Binding>(tx,"binding",&d.binding.id)?;
            let valid = p.as_ref().zip(b.as_ref()).is_some_and(|(p,b)|
                p.revision == d.principal_revision && b == &d.binding && authorize(p,b).is_ok());
            if !valid {
                // Dispatch may have reached Host before a crash. Do not label it
                // definitively rejected merely because authorization now changed.
                if d.state == DeliveryState::Dispatching {
                    d.state = DeliveryState::Uncertain; d.reason = Some("authorization-changed-after-dispatch".into());
                } else { d.state = DeliveryState::Rejected; d.reason = Some("authorization-changed".into()); }
                store::save(tx,&d)?;
            }
            Ok(d)
        }).await?;
        if !matches!(d.state, DeliveryState::Queued | DeliveryState::Dispatching) {
            return Ok(d);
        }
        if matches!(d.inbound.command, Command::AutomationRead { .. }) {
            return self.dispatch_automation_read(d).await;
        }
        if matches!(d.inbound.command, Command::Catalogue { .. }) {
            // The existing outer principal read fence remains the owner. Never
            // recursively acquire its fair lock while a writer is queued.
            return self.dispatch_catalogue(d).await;
        }
        if !self
            .host
            .session_in_workspace(&d.binding.workspace, &d.binding.session)
            .await
            .map_err(|_| Error::HostUnavailable)?
        {
            d.state = if d.state == DeliveryState::Dispatching {
                DeliveryState::Uncertain
            } else {
                DeliveryState::Rejected
            };
            d.reason = Some("host-scope-changed".into());
            return self.persist(d).await;
        }
        if matches!(d.inbound.command, Command::AnswerInteraction { .. }) {
            return self.dispatch_interaction(d).await;
        }
        let (method, payload) = rpc(&d)?;
        if matches!(d.inbound.command, Command::Prompt { .. }) && d.state == DeliveryState::Queued {
            // Preflight capability: remote admission is forbidden for an ephemeral
            // backend that cannot reconcile an accepted prompt after a crash.
            match self
                .host
                .prompt_receipt(&d.binding.session, &RpcId::new(&d.key), &payload)
                .await
            {
                Ok(None) => {}
                Ok(Some(result)) => {
                    d.result = Some(result);
                    d.state = DeliveryState::Completed;
                    return self.persist(d).await;
                }
                Err(_) => return Err(Error::HostUnavailable),
            }
        }
        if d.state == DeliveryState::Dispatching {
            match &d.inbound.command {
                Command::Prompt { .. } => match self
                    .host
                    .prompt_receipt(&d.binding.session, &RpcId::new(&d.key), &payload)
                    .await
                {
                    Ok(Some(result)) => {
                        d.result = Some(result);
                        d.state = DeliveryState::Completed;
                        return self.persist(d).await;
                    }
                    Ok(None) => {} // Stable id + Host's fingerprint fence makes replay safe.
                    Err(_) => {
                        d.state = DeliveryState::Uncertain;
                        d.reason = Some("host-receipt-unavailable".into());
                        return self.persist(d).await;
                    }
                },
                Command::History { .. }
                | Command::Catalogue { .. }
                | Command::Select { .. }
                | Command::CreateSession { .. }
                | Command::AutomationRead { .. }
                | Command::AutomationControl { .. } => {} // Side-effect-free retry.
                Command::Cancel | Command::AnswerInteraction { .. } => {
                    d.state = DeliveryState::Uncertain;
                    d.reason = Some("cancel-dispatch-ambiguous".into());
                    return self.persist(d).await;
                }
            }
        }
        d.state = DeliveryState::Dispatching;
        d = self.persist(d).await?;
        // This token belongs to the operation, not a controller connection.
        let result = self
            .host
            .call(
                RpcId::new(&d.key),
                method,
                payload,
                CancellationToken::new(),
            )
            .await;
        d.state = DeliveryState::Completed;
        d.result = Some(result);
        self.persist(d).await
    }

    pub(crate) async fn persist(&self, mut d: Delivery) -> Result<Delivery, Error> {
        if let Some(result) = d.result.as_ref() {
            // Count without making another unbounded byte buffer. Oversized
            // history is a terminal bounded response, never Agent replay.
            let mut budget = ResultBudget(MAX_RESULT_BYTES);
            if serde_json::to_writer(&mut budget, result).is_err() {
                d.result = Some(xharness_api::RpcResult::failure(
                    xharness_api::RpcError::internal(
                        "remote result exceeds response budget; request a smaller history window",
                    ),
                ));
                d.reason = Some("result-budget-exceeded".into());
            }
        }
        self.store
            .transaction(move |tx| {
                store::save(tx, &d)?;
                Ok(d)
            })
            .await
    }

    /// Composition owns this supervisor. Shutdown stops intake polling, waits for
    /// in-flight admissions, and leaves queued work durable for the next process.
    pub async fn run(self: Arc<Self>, shutdown: CancellationToken) -> Result<(), Error> {
        let mut workers = tokio::task::JoinSet::new();
        let mut active = std::collections::HashSet::new();
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(200));
        let mut failure = None;
        let mut recovery_tick = tokio::time::interval(std::time::Duration::from_secs(1));
        recovery_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut recovery_cursor = None;
        loop {
            tokio::select! {
                _ = shutdown.cancelled() => break,
                _ = interval.tick(), if workers.len() < 32 => {
                    let pending = match self.pending().await {
                        Ok(pending) => pending,
                        Err(error) => { failure = Some(error); break; }
                    };
                    for d in pending {
                        if workers.len() >= 32 { break; }
                        if active.insert(d.key.clone()) {
                            let gateway = self.clone(); let key = d.key;
                            let creation=matches!(d.inbound.command,Command::CreateSession{..}|Command::AutomationControl{..});
                            workers.spawn(async move { let result = gateway.dispatch(&key).await; (key,result,creation) });
                        }
                    }
                },
                _ = recovery_tick.tick(), if workers.len()<32 => {
                    let pending=match self.native_effect_recovery_candidates(recovery_cursor).await {Ok(pending)=>pending,Err(e)=>{failure=Some(e);break;}};
                    recovery_cursor=pending.last().map(|d|d.sequence);
                    for d in pending {
                        if workers.len()>=32 {break;}
                        if active.insert(d.key.clone()) {let gateway=self.clone();let key=d.key;workers.spawn(async move {let result=gateway.dispatch(&key).await;(key,result,true)});}
                    }
                },
                Some(completion) = workers.join_next(), if !workers.is_empty() => {
                    match completion {
                        Ok((key, result, creation)) => {
                            active.remove(&key);
                            if let Err(error) = result {
                                if !matches!(error, Error::SessionBlocked) && !(creation && matches!(error,Error::Capacity)) { failure = Some(error); break; }
                            }
                        }
                        Err(_) => { failure = Some(Error::WorkerFailed); break; }
                    }
                }
            }
        }
        // Even a worker/storage error must not abort other accepted admissions.
        while let Some(completion) = workers.join_next().await {
            match completion {
                Ok((_, Err(error), creation))
                    if !matches!(error, Error::SessionBlocked)
                        && !(creation && matches!(error, Error::Capacity)) =>
                {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                }
                Err(_) if failure.is_none() => failure = Some(Error::WorkerFailed),
                _ => {}
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

pub(crate) fn authorize(p: &Principal, b: &Binding) -> Result<(), Error> {
    if p.revoked
        || b.principal != p.id
        || !p.workspaces.contains(&b.workspace)
        || !p.sessions.contains(&b.session)
    {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
pub(crate) fn valid_id(id: &str) -> Result<(), Error> {
    if id.is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        return Err(Error::Invalid("identity length or characters"));
    }
    Ok(())
}
fn validate_command(command: &Command) -> Result<(), Error> {
    match command {
        Command::Prompt {
            content,
            client_time_zone,
            ..
        } => {
            if content.is_empty() || content.len() > 128 {
                return Err(Error::Invalid("content count"));
            }
            if let Some(zone) = client_time_zone {
                valid_id(zone)?;
            }
            for part in content {
                match part {
                    Content::Text { text } => {
                        if text.len() > 128 * 1024 || text.contains('\0') {
                            return Err(Error::Invalid("text bounds"));
                        }
                    }
                    Content::Image {
                        media_type,
                        data,
                        name,
                    }
                    | Content::File {
                        media_type,
                        data,
                        name,
                    } => {
                        if data.is_empty()
                            || !data.bytes().all(|c| {
                                c.is_ascii_alphanumeric() || matches!(c, b'+' | b'/' | b'=')
                            })
                        {
                            return Err(Error::Invalid("base64 attachment"));
                        }
                        if data.len() > 6 * 1024 * 1024 {
                            return Err(Error::Capacity);
                        }
                        valid_id(media_type)?;
                        if matches!(part, Content::Image { .. })
                            && !matches!(
                                media_type.as_str(),
                                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
                            )
                        {
                            return Err(Error::Invalid("image media type"));
                        }
                        if let Some(name) = name {
                            valid_id(name)?;
                            if name.contains('/') || name.contains('\\') {
                                return Err(Error::Invalid("attachment basename"));
                            }
                        }
                    }
                }
            }
        }
        Command::AutomationControl { control } => valid_id(control.id())?,
        Command::AutomationRead {
            read: AutomationRead::List { after: Some(id) } | AutomationRead::View { id },
        } => valid_id(id)?,
        Command::CreateSession { workspace } => valid_id(workspace)?,
        Command::Select { target } => {
            valid_id(&target.workspace)?;
            valid_id(&target.session)?;
        }
        Command::Catalogue {
            after: Some(cursor),
        } => {
            valid_id(&cursor.workspace)?;
            valid_id(&cursor.session)?;
        }
        Command::AnswerInteraction { answer, .. } if !answer.is_bounded() => {
            return Err(Error::Invalid("interaction answer size"));
        }
        Command::History { max_messages, .. } if *max_messages == 0 || *max_messages > 500 => {
            return Err(Error::Invalid("history bound"))
        }
        _ => {}
    }
    Ok(())
}
pub(crate) fn digest(value: &Value) -> String {
    let bytes = serde_json::to_vec(value).expect("JSON serialization");
    format!("remote-v1-{:x}", Sha256::digest(bytes))
}
fn rpc(d: &Delivery) -> Result<(RpcMethod, Value), Error> {
    Ok(match &d.inbound.command {
        Command::Prompt {
            mode,
            content,
            client_time_zone,
        } => {
            let content: Vec<Value> = content
                .iter()
                .map(|p| {
                    let (mut block, name) = match p {
                        Content::Text { text } => return json!({"type":"text","text":text}),
                        Content::Image {
                            media_type,
                            data,
                            name,
                        } => (
                            json!({"type":"image","mediaType":media_type,"data":data}),
                            name,
                        ),
                        Content::File {
                            media_type,
                            data,
                            name,
                        } => (
                            json!({"type":"file","mediaType":media_type,"data":data}),
                            name,
                        ),
                    };
                    if let Some(name) = name {
                        block["name"] = json!(name);
                    }
                    block
                })
                .collect();
            let mut payload =
                json!({"sessionId":d.binding.session,"mode":mode.wire(),"content":content});
            if let Some(zone) = client_time_zone {
                payload["clientTimeZone"] = json!(zone);
            }
            (RpcMethod::SessionPrompt, payload)
        }
        Command::AnswerInteraction { .. }
        | Command::Catalogue { .. }
        | Command::Select { .. }
        | Command::CreateSession { .. }
        | Command::AutomationRead { .. }
        | Command::AutomationControl { .. } => {
            return Err(Error::Invalid("scoped operation is not a generic RPC"))
        }
        Command::Cancel => (
            RpcMethod::SessionCancel,
            json!({"sessionId":d.binding.session}),
        ),
        Command::History {
            before_seq,
            max_messages,
        } => {
            let mut payload = json!({"sessionId":d.binding.session,"maxMessages":max_messages});
            if let Some(before) = before_seq {
                payload["beforeSeq"] = json!(before);
            }
            (RpcMethod::SessionHistory, payload)
        }
    })
}

pub(crate) struct ResultBudget(pub(crate) usize);
impl std::io::Write for ResultBudget {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.0 {
            return Err(std::io::Error::other("result budget exceeded"));
        }
        self.0 -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(crate) fn validate_inbound(conversation: &str, inbound: &Inbound) -> Result<(), Error> {
    valid_id(&inbound.request_id)?;
    valid_id(&inbound.binding)?;
    valid_id(conversation)?;
    validate_command(&inbound.command)?;
    let mut budget = ResultBudget(MAX_INBOUND_BYTES);
    if serde_json::to_writer(&mut budget, inbound).is_err() {
        return Err(Error::Capacity);
    }
    Ok(())
}

pub(crate) fn admit(
    tx: &rusqlite::Transaction<'_>,
    host: &str,
    principal: &str,
    sender: Sender,
    conversation: String,
    inbound: Inbound,
) -> Result<Delivery, Error> {
    let p: Principal = store::entity(tx, "principal", principal)?.ok_or(Error::Unauthorized)?;
    let b: Binding = store::entity(tx, "binding", &inbound.binding)?.ok_or(Error::Unauthorized)?;
    authorize(&p, &b)?;
    if p.host != host
        || p.sender != sender
        || b.conversation != conversation
        || b.generation != inbound.generation
    {
        return Err(Error::Unauthorized);
    }
    let key = digest(&json!([1, host, sender, conversation, inbound.request_id]));
    if let Some(previous) = store::delivery(tx, &key)? {
        if previous.principal != principal || previous.inbound != inbound {
            return Err(Error::IdentityConflict);
        }
        return Ok(previous);
    }
    let pending: usize = tx.query_row(
        "SELECT COUNT(*) FROM inbox WHERE state IN ('queued','dispatching','uncertain')",
        [],
        |r| r.get(0),
    )?;
    let records: usize = tx.query_row("SELECT COUNT(*) FROM inbox", [], |r| r.get(0))?;
    if pending >= MAX_PENDING || records >= MAX_RECORDS {
        return Err(Error::Capacity);
    }
    let mut d = Delivery {
        sequence: 0,
        key,
        principal: principal.to_owned(),
        principal_revision: p.revision,
        binding: b,
        inbound,
        state: DeliveryState::Queued,
        result: None,
        reason: None,
    };
    tx.execute(
        "INSERT INTO inbox(key,session,state,body) VALUES (?1,?2,'queued','{}')",
        params![d.key, d.binding.session],
    )?;
    d.sequence = tx.last_insert_rowid();
    store::save(tx, &d)?;
    Ok(d)
}
