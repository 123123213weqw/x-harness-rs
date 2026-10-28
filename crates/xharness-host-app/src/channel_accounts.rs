//! Native account lifecycle/credential composition, not Agent or platform logic.
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

use crate::model_settings::CredentialStore;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::Duration,
};
use tokio::{
    sync::{Mutex, Notify},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
use xharness_channel_telegram::{run_interactions, BotToken, Client, Intake, IntakeError, Replies};
use xharness_remote::{Account, AccountSettings, Channel, Gateway, ReplyTransport};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelFailure {
    InvalidConfiguration,
    SettingConflict,
    Journal,
    JournalCleanupRequired,
    NativeCredentialUnavailable,
    MissingCredential,
    InvalidCredentials,
    ProviderConflict,
    Transport,
    Unsupported,
    WorkerFailed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ConnectionState {
    Disabled,
    Starting,
    Online,
    Stopped,
    Failed { reason: ChannelFailure },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountStatus {
    pub account: Account,
    pub revision: u64,
    pub connection: ConnectionState,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfiguredAccount {
    pub settings: AccountSettings,
    pub credential_cleanup_pending: bool,
}

#[async_trait]
pub trait AccountConnection: Send + 'static {
    /// Must drain interrupted outgoing effects before returning; stopping a
    /// connection never cancels a Host-owned Agent/admission supervisor.
    async fn run(self: Box<Self>, stop: CancellationToken) -> Result<(), ChannelFailure>;
}
#[async_trait]
pub trait AccountConnector: Send + Sync + 'static {
    async fn connect(
        &self,
        settings: AccountSettings,
        gateway: Arc<Gateway>,
        secret: String,
    ) -> Result<Box<dyn AccountConnection>, ChannelFailure>;
}
pub struct TelegramConnector;
#[async_trait]
impl AccountConnector for TelegramConnector {
    async fn connect(
        &self,
        settings: AccountSettings,
        gateway: Arc<Gateway>,
        secret: String,
    ) -> Result<Box<dyn AccountConnection>, ChannelFailure> {
        telegram_id(&settings.account)?;
        let token = BotToken::new(secret).map_err(|_| ChannelFailure::InvalidCredentials)?;
        let client =
            Arc::new(Client::new(token).map_err(|_| ChannelFailure::InvalidConfiguration)?);
        Self::connect_client(settings, gateway, client).await
    }
}
impl TelegramConnector {
    async fn connect_client(
        settings: AccountSettings,
        gateway: Arc<Gateway>,
        client: Arc<Client>,
    ) -> Result<Box<dyn AccountConnection>, ChannelFailure> {
        let bot = telegram_id(&settings.account)?;
        let replies = Replies::connect(client.clone(), bot)
            .await
            .map_err(provider_failure)?;
        let intake = Intake::connect_configured(client, gateway.clone(), bot, settings.revision)
            .await
            .map_err(intake_failure)?;
        Ok(Box::new(TelegramConnection {
            lease: intake.lease(),
            intake,
            gateway,
            transport: Arc::new(replies),
        }))
    }
}
struct TelegramConnection {
    intake: Intake,
    gateway: Arc<Gateway>,
    transport: Arc<dyn ReplyTransport>,
    lease: xharness_remote::AccountLease,
}
#[async_trait]
impl AccountConnection for TelegramConnection {
    async fn run(self: Box<Self>, stop: CancellationToken) -> Result<(), ChannelFailure> {
        let Self {
            intake,
            gateway,
            transport,
            lease,
        } = *self;
        let lifetime = stop.child_token();
        let mut workers = JoinSet::new();
        let inbound_stop = lifetime.clone();
        workers.spawn(async move { intake.run(inbound_stop).await.map_err(intake_failure) });
        let outgoing_stop = lifetime.clone();
        let outgoing_gateway = gateway.clone();
        let outgoing_lease = lease.clone();
        workers.spawn(async move {
            outgoing_gateway
                .run_replies(outgoing_lease, transport, outgoing_stop)
                .await
                .map_err(|_| ChannelFailure::Journal)
        });
        let interaction_stop = lifetime.clone();
        workers.spawn(async move {
            run_interactions(gateway, lease, interaction_stop)
                .await
                .map_err(|_| ChannelFailure::Journal)
        });
        // Do not drop a sending future on sibling failure: cancellation makes
        // the outbox durable-uncertain, then ALL three workers are awaited.
        let mut result = workers
            .join_next()
            .await
            .ok_or(ChannelFailure::WorkerFailed)
            .and_then(|joined| joined.map_err(|_| ChannelFailure::WorkerFailed))
            .and_then(|result| result);
        lifetime.cancel();
        while let Some(joined) = workers.join_next().await {
            let next = joined
                .map_err(|_| ChannelFailure::WorkerFailed)
                .and_then(|result| result);
            if result.is_ok() {
                result = next;
            }
        }
        result
    }
}
fn provider_failure(error: xharness_channel_telegram::Error) -> ChannelFailure {
    use xharness_channel_telegram::Error;
    match error {
        Error::Unauthorized => ChannelFailure::InvalidCredentials,
        Error::Conflict => ChannelFailure::ProviderConflict,
        Error::Configuration => ChannelFailure::InvalidConfiguration,
        _ => ChannelFailure::Transport,
    }
}
fn intake_failure(error: IntakeError) -> ChannelFailure {
    match error {
        IntakeError::Journal => ChannelFailure::Journal,
        IntakeError::Transport(e) => provider_failure(e),
    }
}
fn telegram_id(account: &Account) -> Result<u64, ChannelFailure> {
    if account.channel != Channel::Telegram {
        return Err(ChannelFailure::Unsupported);
    }
    account
        .id
        .parse::<u64>()
        .ok()
        .filter(|id| *id > 0 && *id <= i64::MAX as u64 && id.to_string() == account.id)
        .ok_or(ChannelFailure::InvalidConfiguration)
}
fn identity(account: &Account) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::json!({"channel":account.channel,"id":account.id})
                .to_string()
                .as_bytes()
        )
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ManagerHealth {
    Dormant,
    Running,
    Stopped,
    Failed { reason: ChannelFailure },
}

pub struct AccountManager {
    gateway: Arc<Gateway>,
    credentials: Arc<dyn CredentialStore>,
    connector: Arc<dyn AccountConnector>,
    health: Mutex<ManagerHealth>,
    mutations: Mutex<()>,
    status: Mutex<BTreeMap<String, AccountStatus>>,
    changed: Notify,
}
impl AccountManager {
    pub fn new(
        gateway: Arc<Gateway>,
        credentials: Arc<dyn CredentialStore>,
        connector: Arc<dyn AccountConnector>,
    ) -> Arc<Self> {
        Arc::new(Self {
            gateway,
            credentials,
            connector,
            health: Mutex::new(ManagerHealth::Dormant),
            mutations: Mutex::new(()),
            status: Mutex::new(BTreeMap::new()),
            changed: Notify::new(),
        })
    }
    pub async fn health(&self) -> ManagerHealth {
        self.health.lock().await.clone()
    }
    pub async fn status(&self) -> Vec<AccountStatus> {
        self.status.lock().await.values().cloned().collect()
    }
    /// Trusted local setup only, not a Bot/mobile command. Secret is never
    /// serialized to the journal, returned, logged, or accepted as an env/file
    /// fallback. A fresh reference preserves the previous key on CAS failure.
    pub async fn configure_telegram(
        &self,
        bot: u64,
        expected_revision: u64,
        enabled: bool,
        secret: String,
    ) -> Result<ConfiguredAccount, ChannelFailure> {
        let _mutation = self.mutations.lock().await;
        let account = Account {
            channel: Channel::Telegram,
            id: bot.to_string(),
        };
        telegram_id(&account)?;
        BotToken::new(secret.clone()).map_err(|_| ChannelFailure::InvalidCredentials)?;
        let old = self
            .gateway
            .account_settings()
            .await
            .map_err(|_| ChannelFailure::Journal)?
            .into_iter()
            .find(|s| s.account == account);
        if old.as_ref().map_or(0, |s| s.revision) != expected_revision {
            return Err(ChannelFailure::SettingConflict);
        }
        let revision = expected_revision
            .checked_add(1)
            .ok_or(ChannelFailure::SettingConflict)?;
        let mut nonce = [0u8; 24];
        getrandom::fill(&mut nonce).map_err(|_| ChannelFailure::NativeCredentialUnavailable)?;
        let reference = format!("REMOTE_TELEGRAM_{:X}", Sha256::digest(nonce));
        self.gateway
            .stage_credential_reference(&reference)
            .await
            .map_err(|_| ChannelFailure::Journal)?;
        tokio::time::timeout(
            Duration::from_secs(5),
            self.credentials.set(&reference, &secret),
        )
        .await
        .map_err(|_| ChannelFailure::NativeCredentialUnavailable)?
        .map_err(|_| ChannelFailure::NativeCredentialUnavailable)?;
        let settings = AccountSettings {
            account,
            revision,
            enabled,
            credentials: BTreeMap::from([("bot_token".into(), reference.clone())]),
        };
        if self
            .gateway
            .set_account_settings(settings.clone())
            .await
            .is_err()
        {
            return Err(
                if self.delete_retired(&reference).await
                    && self
                        .gateway
                        .finish_credential_cleanup(&reference)
                        .await
                        .is_ok()
                {
                    ChannelFailure::Journal
                } else {
                    ChannelFailure::JournalCleanupRequired
                },
            );
        }
        self.publish_settings(&settings).await;
        self.changed.notify_one();
        let cleanup = self.cleanup_credentials_locked().await;
        Ok(ConfiguredAccount {
            settings,
            credential_cleanup_pending: cleanup,
        })
    }
    /// Retry native deletion from the durable retired-reference queue. Active
    /// references are never deleted; failure stays observable and retryable.
    pub async fn cleanup_credentials(&self) -> bool {
        let _mutation = self.mutations.lock().await;
        self.cleanup_credentials_locked().await
    }
    async fn delete_retired(&self, reference: &str) -> bool {
        if self
            .gateway
            .claim_credential_cleanup(reference)
            .await
            .is_err()
        {
            return false;
        }
        matches!(
            tokio::time::timeout(Duration::from_secs(5), self.credentials.delete(reference)).await,
            Ok(Ok(()))
        )
    }
    async fn cleanup_credentials_locked(&self) -> bool {
        let pending = match self.gateway.pending_credential_cleanup().await {
            Ok(p) => p,
            Err(_) => return true,
        };
        let mut failed = false;
        for reference in pending {
            if !self.delete_retired(&reference).await
                || self
                    .gateway
                    .finish_credential_cleanup(&reference)
                    .await
                    .is_err()
            {
                failed = true;
                break;
            }
        }
        failed
            || self
                .gateway
                .pending_credential_cleanup()
                .await
                .map_or(true, |p| !p.is_empty())
    }
    pub async fn set_enabled(
        &self,
        account: Account,
        expected_revision: u64,
        enabled: bool,
    ) -> Result<AccountSettings, ChannelFailure> {
        let _mutation = self.mutations.lock().await;
        let mut settings = self
            .gateway
            .account_settings()
            .await
            .map_err(|_| ChannelFailure::Journal)?
            .into_iter()
            .find(|s| s.account == account)
            .ok_or(ChannelFailure::InvalidConfiguration)?;
        if settings.revision != expected_revision {
            return Err(ChannelFailure::SettingConflict);
        }
        settings.revision = settings
            .revision
            .checked_add(1)
            .ok_or(ChannelFailure::SettingConflict)?;
        settings.enabled = enabled;
        self.gateway
            .set_account_settings(settings.clone())
            .await
            .map_err(|_| ChannelFailure::Journal)?;
        self.publish_settings(&settings).await;
        self.changed.notify_one();
        Ok(settings)
    }
    async fn publish_settings(&self, settings: &AccountSettings) {
        self.status.lock().await.insert(
            identity(&settings.account),
            AccountStatus {
                account: settings.account.clone(),
                revision: settings.revision,
                connection: if settings.enabled {
                    ConnectionState::Starting
                } else {
                    ConnectionState::Disabled
                },
            },
        );
    }
    async fn publish_connection(&self, settings: &AccountSettings, connection: ConnectionState) {
        let mut statuses = self.status.lock().await;
        if let Some(current) = statuses.get_mut(&identity(&settings.account)) {
            if current.revision == settings.revision {
                current.connection = connection;
            }
        }
    }
    async fn worker(self: Arc<Self>, settings: AccountSettings, stop: CancellationToken) {
        let connection = tokio::select! {biased;_=stop.cancelled()=>Ok(None),result=self.connect_worker(settings.clone())=>result.map(Some)};
        let result = match connection {
            Ok(Some(connection)) => connection.run(stop).await,
            Ok(None) => Ok(()),
            Err(error) => Err(error),
        };
        self.publish_connection(
            &settings,
            match result {
                Ok(()) => ConnectionState::Stopped,
                Err(reason) => ConnectionState::Failed { reason },
            },
        )
        .await;
    }
    async fn connect_worker(
        &self,
        settings: AccountSettings,
    ) -> Result<Box<dyn AccountConnection>, ChannelFailure> {
        telegram_id(&settings.account)?;
        if settings.credentials.len() != 1 {
            return Err(ChannelFailure::InvalidConfiguration);
        }
        let reference = settings
            .credentials
            .get("bot_token")
            .ok_or(ChannelFailure::InvalidConfiguration)?;
        let secret = tokio::time::timeout(Duration::from_secs(5), self.credentials.get(reference))
            .await
            .map_err(|_| ChannelFailure::NativeCredentialUnavailable)?
            .map_err(|_| ChannelFailure::NativeCredentialUnavailable)?
            .ok_or(ChannelFailure::MissingCredential)?;
        let connection = self
            .connector
            .connect(settings.clone(), self.gateway.clone(), secret)
            .await?;
        self.publish_connection(&settings, ConnectionState::Online)
            .await;
        // Only connect is cancellable by dropping its future. Once it owns
        // outgoing effects, the connection must receive cancellation and drain.
        Ok(connection)
    }
    pub async fn run(self: Arc<Self>, shutdown: CancellationToken) -> Result<(), ChannelFailure> {
        *self.health.lock().await = ManagerHealth::Running;
        let mut accounts: HashMap<String, (u64, CancellationToken, Option<JoinHandle<()>>)> =
            HashMap::new();
        let mut tick = tokio::time::interval(Duration::from_millis(200));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let result = 'manager: loop {
            tokio::select! {biased;_=shutdown.cancelled()=>break Ok(()),_=self.changed.notified()=>{},_=tick.tick()=>{}}
            for (key, (revision, _, task)) in &mut accounts {
                if !task.as_ref().is_some_and(JoinHandle::is_finished) {
                    continue;
                }
                let Some(completed) = task.take() else {
                    continue;
                };
                if completed.await.is_err() {
                    if let Some(status) = self.status.lock().await.get_mut(key) {
                        if status.revision == *revision {
                            status.connection = ConnectionState::Failed {
                                reason: ChannelFailure::WorkerFailed,
                            };
                        }
                    }
                }
            }
            let settings = match self.gateway.account_settings().await {
                Ok(s) => s,
                Err(_) => break Err(ChannelFailure::Journal),
            };
            for setting in settings {
                let key = identity(&setting.account);
                if accounts
                    .get(&key)
                    .is_some_and(|(r, _, _)| *r == setting.revision)
                {
                    continue;
                }
                if let Some((_, stop, task)) = accounts.remove(&key) {
                    stop.cancel();
                    if let Some(task) = task {
                        if task.await.is_err() {
                            break 'manager Err(ChannelFailure::WorkerFailed);
                        }
                    }
                }
                self.publish_settings(&setting).await;
                let stop = shutdown.child_token();
                let task = if setting.enabled {
                    tokio::spawn(self.clone().worker(setting.clone(), stop.clone()))
                } else {
                    tokio::spawn(async {})
                };
                accounts.insert(key, (setting.revision, stop, Some(task)));
            }
        };
        // Cancel everyone before waiting, so one slow account cannot postpone
        // shutdown of other accounts. Reap all tasks even after a worker failure.
        let mut drains = JoinSet::new();
        for (_, (_, stop, task)) in accounts {
            stop.cancel();
            if let Some(task) = task {
                drains.spawn(task);
            }
        }
        let mut failed = false;
        while let Some(task) = drains.join_next().await {
            if !matches!(task, Ok(Ok(()))) {
                failed = true;
            }
        }
        let result = if failed {
            Err(ChannelFailure::WorkerFailed)
        } else {
            result
        };
        *self.health.lock().await = match result {
            Ok(()) => ManagerHealth::Stopped,
            Err(reason) => ManagerHealth::Failed { reason },
        };
        if let Err(reason) = result {
            for status in self.status.lock().await.values_mut() {
                if !matches!(status.connection, ConnectionState::Disabled) {
                    status.connection = ConnectionState::Failed { reason };
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod tests;
