//! Local executable composition. Platform transports and Agent execution stay
//! in their owners; a phone connection never owns this supervisor's lifetime.
use crate::{
    channel_accounts::{AccountConnector, AccountManager, ChannelFailure, TelegramConnector},
    model_settings::{CredentialStore, NativeCredentialStore},
};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;
use xharness_api::ApiBackend;
use xharness_remote::Gateway;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupervisorStatus {
    Running,
    Failed,
    Stopped,
}

pub struct RemoteControl {
    gateway: Arc<Gateway>,
    accounts: Arc<AccountManager>,
    account_worker: Option<JoinHandle<Result<(), ChannelFailure>>>,
    stop: CancellationToken,
    worker: Option<JoinHandle<Result<(), xharness_remote::Error>>>,
    status: watch::Receiver<SupervisorStatus>,
    mobile: Option<Arc<xharness_mobile::MobileHost>>,
    mobile_worker: Option<JoinHandle<Result<(), xharness_mobile::protocol::ErrorCode>>>,
    mobile_public_url: Option<String>,
}
impl RemoteControl {
    /// Caller holds the product's state-directory owner lock. This service is
    /// opt-in; enabled saved accounts start their channel workers. Empty or
    /// disabled configuration performs no provider HTTP/credential reads. No
    /// controller listener, model credential or pairing credential is created.
    pub fn start(state_dir: &Path, backend: Arc<dyn ApiBackend>) -> Result<Self, String> {
        let mut service = Self::start_with_accounts(
            state_dir,
            backend,
            Arc::new(NativeCredentialStore::for_channels(state_dir)?),
            Arc::new(TelegramConnector),
        )?;
        if let Some(url) = std::env::var_os("XHARNESS_MOBILE_RELAY_URL") {
            let url = url.into_string().map_err(|_| "Invalid mobile relay URL")?;
            let key = std::env::var("XHARNESS_MOBILE_HOST_KEY")
                .map_err(|_| "Mobile relay requires a separate Host registration key")?;
            let key = xharness_mobile::protocol::Secret::try_from(key)
                .map_err(|_| "Invalid mobile Host registration key")?;
            let allow_loopback_ws = std::env::var("XHARNESS_MOBILE_ALLOW_LOOPBACK")
                .is_ok_and(|value| value == "enabled");
            let mobile = xharness_mobile::MobileHost::open(
                service.gateway(),
                &state_dir.join("mobile-devices"),
            )
            .map_err(|_| "Cannot open private mobile device journal")?;
            let config = xharness_mobile::OutboundConfig {
                url: url.clone(),
                key,
                allow_loopback_ws,
            };
            config
                .validate()
                .map_err(|_| "Invalid mobile relay transport configuration")?;
            if let Some(public) = std::env::var_os("XHARNESS_MOBILE_PUBLIC_URL") {
                let public = public
                    .into_string()
                    .map_err(|_| "Invalid mobile public URL")?;
                let parsed =
                    reqwest::Url::parse(&public).map_err(|_| "Invalid mobile public URL")?;
                if parsed.scheme() != "https"
                    || !parsed.username().is_empty()
                    || parsed.password().is_some()
                    || parsed.query().is_some()
                    || parsed.fragment().is_some()
                {
                    return Err(
                        "Mobile public URL requires HTTPS without credentials/query/fragment"
                            .into(),
                    );
                }
                service.mobile_public_url = Some(public);
            }
            let worker_host = mobile.clone();
            let worker_stop = service.stop.clone();
            service.mobile_worker = Some(tokio::spawn(xharness_mobile::run_outbound(
                worker_host,
                config,
                worker_stop,
            )));
            service.mobile = Some(mobile);
            // Public page location only, never a launch token or registration key.
        }
        Ok(service)
    }
    /// Injectable local composition, not a controller-selectable connector or
    /// credential fallback. Production start always uses native channel keys.
    pub fn start_with_accounts(
        state_dir: &Path,
        backend: Arc<dyn ApiBackend>,
        credentials: Arc<dyn CredentialStore>,
        connector: Arc<dyn AccountConnector>,
    ) -> Result<Self, String> {
        let canonical = std::fs::canonicalize(state_dir)
            .map_err(|_| "Cannot resolve remote control state directory")?;
        let host_id = format!(
            "host-{}",
            hex::encode(Sha256::digest(canonical.to_string_lossy().as_bytes()))
        );
        let gateway=Gateway::open(&canonical.join("remote-control"),host_id,backend)
            .map_err(|_|"Cannot open private remote control journal; another consumer, invalid journal or storage failure".to_owned())?;
        let stop = CancellationToken::new();
        let lifetime = stop.clone();
        let work = gateway.clone();
        let (status_tx, status) = watch::channel(SupervisorStatus::Running);
        let worker = tokio::spawn(async move {
            let result = work.run(lifetime).await;
            status_tx.send_replace(if result.is_ok() {
                SupervisorStatus::Stopped
            } else {
                SupervisorStatus::Failed
            });
            result
        });
        let accounts = AccountManager::new(gateway.clone(), credentials, connector);
        let account_worker = tokio::spawn(accounts.clone().run(stop.clone()));
        Ok(Self {
            gateway,
            accounts,
            account_worker: Some(account_worker),
            stop,
            worker: Some(worker),
            status,
            mobile: None,
            mobile_worker: None,
            mobile_public_url: None,
        })
    }
    /// Trusted composition/admin access only. No arbitrary network Gateway proxy.
    pub fn gateway(&self) -> Arc<Gateway> {
        self.gateway.clone()
    }
    pub fn accounts(&self) -> Arc<AccountManager> {
        self.accounts.clone()
    }
    pub fn mobile(&self) -> Option<Arc<xharness_mobile::MobileHost>> {
        self.mobile.clone()
    }
    pub fn mobile_public_url(&self) -> Option<String> {
        self.mobile_public_url.clone()
    }
    pub fn status(&self) -> SupervisorStatus {
        *self.status.borrow()
    }
    pub async fn stop(mut self) -> Result<(), String> {
        self.stop.cancel();
        let mobile_failure = match self.mobile_worker.take() {
            Some(worker) => worker
                .await
                .map_err(|_| "Mobile transport worker failed".to_owned())
                .and_then(|r| r.map_err(|_| "Mobile transport stopped with a failure".to_owned())),
            None => Ok(()),
        };
        let channels = self
            .account_worker
            .take()
            .expect("account supervisor handle")
            .await
            .map_err(|_| "Remote account supervisor failed".to_owned())
            .and_then(|result| {
                result.map_err(|_| "Remote account journal requires recovery".to_owned())
            });
        let drained = self
            .worker
            .take()
            .expect("supervisor handle")
            .await
            .map_err(|_| "Remote control supervisor failed".to_owned())
            .and_then(|result| {
                result.map_err(|_| {
                    "Remote control admission failed; durable journal requires recovery".to_owned()
                })
            });
        // A completed Tokio task can still retain Store captures briefly. Close
        // the transaction gate and release the consumer lock deterministically.
        self.gateway
            .close()
            .await
            .map_err(|_| "Remote control journal close failed".to_owned())?;
        mobile_failure.and(channels).and(drained)
    }
}
impl Drop for RemoteControl {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn exclusive_private_supervisor_stops_without_external_listener_or_credentials() {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "xh-remote-service-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        let backend = Arc::new(xharness_api::UnavailableBackend);
        let service = RemoteControl::start(&path, backend.clone()).unwrap();
        assert_eq!(service.status(), SupervisorStatus::Running);
        let id = service.gateway().host_id().to_owned();
        assert!(path.join("remote-control/remote.sqlite").exists());
        assert!(RemoteControl::start(&path, backend.clone()).is_err());
        service.stop().await.unwrap();
        let reopened = RemoteControl::start(&path, backend).unwrap();
        assert_eq!(id, reopened.gateway().host_id());
        reopened.stop().await.unwrap();
        std::fs::remove_dir_all(path).unwrap();
    }
    #[tokio::test]
    async fn failed_supervisor_still_closes_journal_before_error_return() {
        let path = std::env::temp_dir().join(format!(
            "xh-remote-failed-supervisor-{}",
            std::process::id()
        ));
        std::fs::create_dir(&path).unwrap();
        let backend = Arc::new(xharness_api::UnavailableBackend);
        let mut service = RemoteControl::start(&path, backend.clone()).unwrap();
        let old_gateway = service.gateway();
        service.stop.cancel();
        service.worker.take().unwrap().await.unwrap().unwrap();
        service.worker = Some(tokio::spawn(async {
            panic!("disposable supervisor failure fixture")
        }));
        assert!(service.stop().await.is_err());
        let reopened = RemoteControl::start(&path, backend).unwrap();
        assert!(old_gateway.pending().await.is_err());
        drop(old_gateway);
        reopened.stop().await.unwrap();
        std::fs::remove_dir_all(path).unwrap();
    }
}
