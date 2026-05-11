//! Bounded startup telemetry shared by the bootstrap page and the final Host UI.
//!
//! Only four closed phase names and monotonic elapsed times are retained.  No
//! URL, user content, filesystem path, provider data or arbitrary log string is
//! accepted from JavaScript.
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::State;
use xharness_diagnostics::{Phase, Record};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupPhase {
    WindowMapped,
    FrontendHydrated,
    FirstFrame,
}

impl StartupPhase {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "window_mapped" => Some(Self::WindowMapped),
            "frontend_hydrated" => Some(Self::FrontendHydrated),
            "first_frame" => Some(Self::FirstFrame),
            _ => None,
        }
    }

    fn diagnostic(self) -> Phase {
        match self {
            Self::WindowMapped => Phase::WindowMapped,
            Self::FrontendHydrated => Phase::FrontendHydrated,
            Self::FirstFrame => Phase::FirstFrame,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
struct Milestones {
    window_mapped: Option<Duration>,
    host_ready: Option<Duration>,
    frontend_hydrated: Option<Duration>,
    first_frame: Option<Duration>,
}

#[derive(Debug)]
pub struct StartupTimeline {
    started: Instant,
    milestones: Mutex<Milestones>,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSnapshot {
    pub window_mapped_ms: Option<u64>,
    pub host_ready_ms: Option<u64>,
    pub frontend_hydrated_ms: Option<u64>,
    pub first_frame_ms: Option<u64>,
}

impl StartupTimeline {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            milestones: Mutex::new(Milestones::default()),
        }
    }

    pub fn host_ready(&self, diagnostics: &crate::diagnostics::Diagnostics) {
        let mut milestones = self.milestones.lock().expect("startup mutex poisoned");
        if milestones.host_ready.is_some() {
            return;
        }
        milestones.host_ready = Some(self.started.elapsed());
        drop(milestones);
        diagnostics.record(Record::new(Phase::HostReady));
    }

    pub fn window_mapped(&self, diagnostics: &crate::diagnostics::Diagnostics) {
        self.report(StartupPhase::WindowMapped, diagnostics);
    }

    fn report(&self, phase: StartupPhase, diagnostics: &crate::diagnostics::Diagnostics) -> bool {
        let elapsed = self.started.elapsed();
        let mut milestones = self.milestones.lock().expect("startup mutex poisoned");
        let target = match phase {
            StartupPhase::WindowMapped => &mut milestones.window_mapped,
            StartupPhase::FrontendHydrated => &mut milestones.frontend_hydrated,
            StartupPhase::FirstFrame => &mut milestones.first_frame,
        };
        if target.is_some() {
            return false;
        }
        *target = Some(elapsed);
        drop(milestones);
        diagnostics.record(Record::new(phase.diagnostic()));
        true
    }

    pub fn snapshot(&self) -> StartupSnapshot {
        let milestones = *self.milestones.lock().expect("startup mutex poisoned");
        StartupSnapshot {
            window_mapped_ms: milliseconds(milestones.window_mapped),
            host_ready_ms: milliseconds(milestones.host_ready),
            frontend_hydrated_ms: milliseconds(milestones.frontend_hydrated),
            first_frame_ms: milliseconds(milestones.first_frame),
        }
    }
}

fn milliseconds(value: Option<Duration>) -> Option<u64> {
    value.map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
}

/// Browser-originated reporting is deliberately a closed, idempotent command.
#[tauri::command]
pub fn desktop_report_startup_phase(
    state: State<'_, crate::DesktopState>,
    phase: String,
) -> Result<StartupSnapshot, String> {
    let phase = StartupPhase::parse(&phase).ok_or_else(|| "未知桌面启动阶段".to_owned())?;
    state.startup.report(phase, &state.diagnostics);
    Ok(state.startup.snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_protocol_is_closed() {
        assert_eq!(
            StartupPhase::parse("frontend_hydrated"),
            Some(StartupPhase::FrontendHydrated)
        );
        assert_eq!(StartupPhase::parse("host_ready"), None);
        assert_eq!(StartupPhase::parse("arbitrary user text"), None);
    }
}
