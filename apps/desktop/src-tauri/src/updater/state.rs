use std::sync::Arc;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    Checking,
    Available,
    UpToDate,
    Downloading,
    Downloaded,
    StoppingHost,
    HostForceStopped,
    Installing,
    RecoveringHost,
    Installed,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Check,
    Download,
    Install,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub seq: u64,
    pub phase: Phase,
    pub current_version: &'static str,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub message: Option<String>,
    pub retry_action: Action,
}

// The update descriptor and verified bytes stay paired in one session. WebView
// reloads only read this state; they never reset an in-flight/ready download.
// Bytes are intentionally process-local: after app exit re-download and verify.
pub struct UpdateSession<T> {
    pub snapshot: Snapshot,
    candidate: Option<T>,
    bytes: Option<Arc<Vec<u8>>>,
}

impl<T> Default for UpdateSession<T> {
    fn default() -> Self {
        Self {
            snapshot: Snapshot {
                seq: 0,
                phase: Phase::Idle,
                current_version: env!("CARGO_PKG_VERSION"),
                version: None,
                notes: None,
                downloaded: 0,
                total: None,
                message: None,
                retry_action: Action::Check,
            },
            candidate: None,
            bytes: None,
        }
    }
}

impl<T: Clone> UpdateSession<T> {
    pub fn transition(&mut self, phase: Phase, message: Option<String>) -> Snapshot {
        self.snapshot.seq += 1;
        self.snapshot.phase = phase;
        self.snapshot.message = message;
        self.snapshot.clone()
    }

    pub fn has_download(&self) -> bool {
        self.bytes.is_some()
    }

    pub fn begin_check(&mut self) -> bool {
        if self.has_download() {
            return false;
        }
        self.candidate = None;
        self.snapshot.version = None;
        self.snapshot.notes = None;
        self.snapshot.downloaded = 0;
        self.snapshot.total = None;
        self.snapshot.retry_action = Action::Check;
        self.transition(Phase::Checking, None);
        true
    }

    pub fn checked(
        &mut self,
        candidate: Option<T>,
        version: Option<String>,
        notes: Option<String>,
    ) {
        self.snapshot.version = version;
        self.snapshot.notes = notes;
        let phase = if candidate.is_some() {
            Phase::Available
        } else {
            Phase::UpToDate
        };
        self.candidate = candidate;
        self.transition(phase, None);
    }

    pub fn begin_download(&mut self) -> Result<T, String> {
        let candidate = self
            .candidate
            .clone()
            .ok_or_else(|| "没有待下载的更新，请先检查更新".to_owned())?;
        self.snapshot.downloaded = 0;
        self.snapshot.total = None;
        self.snapshot.retry_action = Action::Download;
        self.transition(Phase::Downloading, None);
        Ok(candidate)
    }

    pub fn progress(&mut self, chunk: usize, total: Option<u64>) -> Snapshot {
        self.snapshot.downloaded = self.snapshot.downloaded.saturating_add(chunk as u64);
        self.snapshot.total = total;
        self.transition(Phase::Downloading, None)
    }

    pub fn verified(&mut self, bytes: Vec<u8>) -> Snapshot {
        self.snapshot.downloaded = bytes.len() as u64;
        self.bytes = Some(Arc::new(bytes));
        self.snapshot.retry_action = Action::Install;
        self.transition(
            Phase::Downloaded,
            Some("下载已验证，可继续工作，稍后重启更新".to_owned()),
        )
    }

    pub fn install_payload(&self, confirm_stop: bool) -> Result<(T, Arc<Vec<u8>>), String> {
        if !confirm_stop {
            return Err("请先确认停止正在运行的 Agent、Tool 和 Job，再重启更新".to_owned());
        }
        match (&self.candidate, &self.bytes) {
            (Some(candidate), Some(bytes)) => Ok((candidate.clone(), Arc::clone(bytes))),
            _ => Err("更新尚未下载并验证，不能安装".to_owned()),
        }
    }

    pub fn fail(&mut self, action: Action, error: String) -> Snapshot {
        self.snapshot.retry_action = action;
        self.transition(Phase::Error, Some(error))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn available() -> UpdateSession<&'static str> {
        let mut state = UpdateSession::default();
        assert!(state.begin_check());
        state.checked(
            Some("v2 descriptor"),
            Some("0.2.0".into()),
            Some("notes".into()),
        );
        state
    }

    #[test]
    fn check_and_download_are_not_install() {
        let mut state = available();
        assert_eq!(state.snapshot.phase, Phase::Available);
        assert!(state.install_payload(true).is_err());
        assert_eq!(state.begin_download().unwrap(), "v2 descriptor");
        state.progress(3, Some(6));
        state.progress(3, Some(6));
        assert!(state.install_payload(true).is_err());
        state.verified(vec![1, 2, 3, 4, 5, 6]);
        assert_eq!(state.snapshot.phase, Phase::Downloaded);
        assert!(state.install_payload(false).is_err());
        assert_eq!(state.install_payload(true).unwrap().1.len(), 6);
    }

    #[test]
    fn failed_download_never_becomes_installable_and_retry_restarts_progress() {
        let mut state = available();
        state.begin_download().unwrap();
        state.progress(100, None);
        state.fail(Action::Download, "signature mismatch / offline".into());
        assert!(!state.has_download());
        assert!(state.install_payload(true).is_err());
        assert_eq!(state.snapshot.retry_action, Action::Download);
        state.begin_download().unwrap();
        assert_eq!(state.snapshot.downloaded, 0);
    }

    #[test]
    fn reload_or_check_cannot_replace_verified_candidate() {
        let mut state = available();
        state.begin_download().unwrap();
        state.verified(vec![7, 8]);
        let snapshot = state.snapshot.clone();
        assert!(!state.begin_check());
        assert_eq!(snapshot.seq, state.snapshot.seq);
        let (candidate, bytes) = state.install_payload(true).unwrap();
        assert_eq!(candidate, "v2 descriptor");
        assert_eq!(bytes.as_slice(), &[7, 8]);
    }

    #[test]
    fn failed_install_preserves_verified_package_for_explicit_retry() {
        let mut state = available();
        state.verified(vec![1]);
        state.transition(Phase::StoppingHost, None);
        state.transition(Phase::Installing, None);
        state.transition(Phase::RecoveringHost, None);
        state.fail(Action::Install, "installer failed, host restarted".into());
        assert!(state.install_payload(true).is_ok());
        assert!(state.install_payload(false).is_err());
        assert_eq!(state.snapshot.retry_action, Action::Install);
    }

    #[test]
    fn check_failure_drops_stale_candidate_and_empty_release_is_up_to_date() {
        let mut state = available();
        state.begin_check();
        state.fail(Action::Check, "offline".into());
        assert!(state.begin_download().is_err());
        state.begin_check();
        state.checked(None, None, None);
        assert_eq!(state.snapshot.phase, Phase::UpToDate);
        assert!(state.begin_download().is_err());
    }

    #[test]
    fn progress_is_monotonic_and_new_process_has_no_cached_install() {
        let mut state = available();
        let seq = state.snapshot.seq;
        state.begin_download().unwrap();
        state.progress(usize::MAX, None);
        state.progress(1, Some(1));
        assert!(state.snapshot.seq > seq);
        assert!(state.snapshot.downloaded > 0);
        let fresh = UpdateSession::<String>::default();
        assert!(fresh.install_payload(true).is_err());
    }
}
