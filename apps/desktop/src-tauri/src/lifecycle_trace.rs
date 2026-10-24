//! Closed, bounded metadata. Probe collectors need no DesktopState or Host.
#![forbid(unsafe_code)]

use std::sync::Arc;
use tauri::{AppHandle, Manager};
use xharness_diagnostics::{BrowserEvent, Phase, Record};

pub struct LifecycleTrace(pub Arc<dyn Fn(Record) + Send + Sync>);

pub fn browser(app: &AppHandle, event: BrowserEvent, label: Option<&str>) {
    let Some(trace) = app.try_state::<LifecycleTrace>() else {
        return;
    };
    let mut record = Record::new(Phase::BrowserLifecycle);
    record.pid = Some(std::process::id());
    record.browser_event = Some(event);
    // Only our numeric native view ID; never persist a session/tab label.
    record.view_id = label.and_then(|label| label.strip_prefix("browser-")?.parse().ok());
    (trace.0)(record);
}
