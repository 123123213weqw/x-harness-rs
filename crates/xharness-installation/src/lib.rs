//! No Host/Agent dependency. Only allowlisted installation metadata, never text/logs.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub const MAX_EVENTS: usize = 64;
pub const BATCH_SIZE: usize = 16;
pub const NOTICE_VERSION: u32 = 1;
/// Local-only acknowledgement; never serialized into a report body.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Consent {
    pub notice_version: u32,
    pub enabled: bool,
    pub decided_at_seconds: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub installation_id: Uuid,
    pub secret: String,
}
impl Identity {
    pub fn generate() -> Result<Self, String> {
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes).map_err(|_| "random source unavailable")?;
        Ok(Self {
            installation_id: Uuid::new_v4(),
            secret: URL_SAFE_NO_PAD.encode(bytes),
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Started,
    Heartbeat,
    UpdateAvailable,
    DownloadFailed,
    InstallStarted,
    InstallFailed,
    UpdateConfirmed,
    UpdateUnconfirmed,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub sequence: u64,
    pub kind: Kind,
    pub version: String,
    pub target_version: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingUpdate {
    pub from: String,
    pub target: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outbox {
    #[serde(default)]
    pub consent: Option<Consent>,
    pub enabled: bool,
    pub identity: Option<Identity>,
    pub deletion: Option<Identity>,
    pub registered: bool,
    pub next_sequence: u64,
    pub events: Vec<Event>,
    pub pending_update: Option<PendingUpdate>,
    pub dropped_events: u64,
}
fn valid_version(value: &str) -> bool {
    value.len() <= 64 && semver::Version::parse(value).is_ok()
}
fn valid_event(event: &Event) -> bool {
    valid_version(&event.version)
        && event.target_version.as_deref().is_none_or(valid_version)
        && (!matches!(
            event.kind,
            Kind::UpdateAvailable
                | Kind::InstallStarted
                | Kind::UpdateConfirmed
                | Kind::UpdateUnconfirmed
        ) || event.target_version.is_some())
        && (event.kind != Kind::UpdateConfirmed
            || event.target_version.as_deref() == Some(event.version.as_str()))
}
impl Outbox {
    pub fn validate(&self) -> Result<(), String> {
        if self
            .consent
            .as_ref()
            .is_some_and(|c| c.notice_version == 0 || c.decided_at_seconds == 0)
        {
            return Err("invalid installation consent".into());
        }
        if self.events.len() > MAX_EVENTS
            || self.next_sequence > i64::MAX as u64
            || (!self.enabled
                && (self.identity.is_some()
                    || !self.events.is_empty()
                    || self.pending_update.is_some()
                    || self.registered))
            || (self.enabled && self.identity.is_none())
            || (self.enabled && self.deletion.is_some())
        {
            return Err("invalid installation outbox".into());
        }
        for id in self.identity.iter().chain(self.deletion.iter()) {
            if id.installation_id.is_nil()
                || URL_SAFE_NO_PAD
                    .decode(&id.secret)
                    .map_or(true, |v| v.len() != 32)
            {
                return Err("invalid installation identity".into());
            }
        }
        if self
            .pending_update
            .as_ref()
            .is_some_and(|p| !valid_version(&p.from) || !valid_version(&p.target))
        {
            return Err("invalid pending update".into());
        }
        let mut previous = 0;
        for event in &self.events {
            if event.sequence <= previous
                || event.sequence > self.next_sequence
                || !valid_event(event)
            {
                return Err("invalid installation events".into());
            }
            previous = event.sequence;
        }
        Ok(())
    }
    pub fn notice_required(&self) -> bool {
        // Preserve an existing explicit opt-in from older builds. A known
        // opt-out also remains off when copy versions change.
        !self.enabled && self.consent.is_none() && self.deletion.is_none()
    }
    pub fn choose(&mut self, enabled: bool, version: &str, now: u64) -> Result<(), String> {
        if now == 0 {
            return Err("invalid consent time".into());
        }
        if enabled {
            self.enable(version)?;
        } else {
            self.disable();
        }
        self.consent = Some(Consent {
            notice_version: NOTICE_VERSION,
            enabled,
            decided_at_seconds: now,
        });
        Ok(())
    }
    pub fn enable(&mut self, version: &str) -> Result<(), String> {
        if self.deletion.is_some() {
            return Err("previous statistics deletion is pending".into());
        }
        if !self.enabled {
            if !valid_version(version) {
                return Err("invalid application version".into());
            }
            self.identity = Some(Identity::generate()?);
            self.enabled = true;
            self.registered = false;
            self.next_sequence = 0;
            self.events.clear();
            self.pending_update = None;
            self.push(Kind::Started, version, None)?;
        }
        Ok(())
    }
    pub fn disable(&mut self) {
        self.enabled = false;
        if let Some(identity) = self.identity.take() {
            self.deletion = Some(identity);
        }
        self.events.clear();
        self.pending_update = None;
        self.registered = false;
    }
    pub fn push(&mut self, kind: Kind, version: &str, target: Option<&str>) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        let candidate = Event {
            sequence: 0,
            kind: kind.clone(),
            version: version.into(),
            target_version: target.map(str::to_owned),
        };
        if !valid_event(&candidate) || self.next_sequence >= i64::MAX as u64 {
            return Err("invalid installation event".into());
        }
        // Coalesce unsent heartbeats without resequencing immutable events.
        if kind == Kind::Heartbeat {
            self.events.retain(|e| e.kind != Kind::Heartbeat);
        }
        if self.events.len() == MAX_EVENTS {
            let position = self
                .events
                .iter()
                .position(|e| matches!(e.kind, Kind::Heartbeat | Kind::Started))
                .unwrap_or(0);
            self.events.remove(position);
            self.dropped_events = self.dropped_events.saturating_add(1);
        }
        self.next_sequence += 1;
        self.events.push(Event {
            sequence: self.next_sequence,
            kind,
            version: version.into(),
            target_version: target.map(str::to_owned),
        });
        Ok(())
    }
    pub fn installing(&mut self, version: &str, target: &str) -> Result<(), String> {
        if self.enabled {
            self.push(Kind::InstallStarted, version, Some(target))?;
            self.pending_update = Some(PendingUpdate {
                from: version.into(),
                target: target.into(),
            });
        }
        Ok(())
    }
    pub fn failed(&mut self, version: &str, target: Option<&str>) -> Result<(), String> {
        let pending_target = self.pending_update.take().map(|p| p.target);
        self.push(
            Kind::InstallFailed,
            version,
            pending_target.as_deref().or(target),
        )
    }
    pub fn started(&mut self, version: &str) -> Result<(), String> {
        if let Some(pending) = self.pending_update.take() {
            let kind = if version == pending.target {
                Kind::UpdateConfirmed
            } else {
                Kind::UpdateUnconfirmed
            };
            self.push(kind, version, Some(&pending.target))?;
        }
        self.push(Kind::Started, version, None)
    }
    pub fn acknowledge(&mut self, through: u64, batch_max: u64) -> Result<(), String> {
        if through > batch_max || through > self.next_sequence {
            return Err("invalid report acknowledgement".into());
        }
        self.events.retain(|e| e.sequence > through);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_run_choice_survives_restart_and_legacy_opt_in_is_preserved() {
        let mut o = Outbox::default();
        assert!(o.notice_required());
        o.choose(false, "1.0.0", 123).unwrap();
        assert!(!o.notice_required() && o.identity.is_none() && o.events.is_empty());
        let bytes = serde_json::to_vec(&o).unwrap();
        let restored: Outbox = serde_json::from_slice(&bytes).unwrap();
        assert!(!restored.notice_required());
        assert_eq!(restored.consent.unwrap().notice_version, NOTICE_VERSION);
        let mut legacy = Outbox::default();
        legacy.enable("1.0.0").unwrap();
        assert!(!legacy.notice_required());
        let mut legacy_json = serde_json::to_value(&legacy).unwrap();
        legacy_json.as_object_mut().unwrap().remove("consent");
        let legacy_restored: Outbox = serde_json::from_value(legacy_json).unwrap();
        legacy_restored.validate().unwrap();
        assert!(!legacy_restored.notice_required());
        o.choose(true, "1.0.0", 124).unwrap();
        assert!(o.enabled && o.consent.as_ref().unwrap().enabled);
        o.choose(false, "1.0.0", 125).unwrap();
        assert!(!o.notice_required());
        assert!(o.choose(true, "1.0.0", 126).is_err());
        assert!(!o.consent.unwrap().enabled);
    }
    #[test]
    fn consent_is_required_and_revocation_purges_payloads() {
        let mut o = Outbox::default();
        o.started("1.0.0").unwrap();
        assert!(o.events.is_empty());
        o.enable("1.0.0").unwrap();
        o.disable();
        assert!(!o.enabled && o.identity.is_none() && o.events.is_empty() && o.deletion.is_some());
        assert!(o.enable("1.0.0").is_err());
        o.deletion = None;
        o.enable("1.0.0").unwrap();
        o.validate().unwrap();
    }
    #[test]
    fn only_the_restarted_target_confirms_an_update() {
        let mut o = Outbox::default();
        o.enable("1.0.0").unwrap();
        o.installing("1.0.0", "1.1.0").unwrap();
        let bytes = serde_json::to_vec(&o).unwrap();
        let mut restored: Outbox = serde_json::from_slice(&bytes).unwrap();
        restored.started("1.1.0").unwrap();
        assert_eq!(restored.events[2].kind, Kind::UpdateConfirmed);
        o.started("1.0.0").unwrap();
        assert_eq!(o.events[2].kind, Kind::UpdateUnconfirmed);
    }
    #[test]
    fn outbox_is_bounded_and_ack_does_not_discard_newer_events() {
        let mut o = Outbox::default();
        o.enable("1.0.0").unwrap();
        for _ in 0..1000 {
            o.push(Kind::UpdateAvailable, "1.0.0", Some("1.1.0"))
                .unwrap();
        }
        assert_eq!(o.events.len(), MAX_EVENTS);
        assert!(o.dropped_events > 0);
        o.validate().unwrap();
        let batch = o.events[BATCH_SIZE - 1].sequence;
        o.push(Kind::Heartbeat, "1.0.0", None).unwrap();
        o.acknowledge(batch, batch).unwrap();
        assert!(!o.events.is_empty());
        assert!(o.acknowledge(u64::MAX, batch).is_err());
    }
    #[test]
    fn unknown_fields_and_corrupt_sequences_are_rejected() {
        assert!(serde_json::from_str::<Event>(r#"{"sequence":1,"kind":"started","version":"1.0.0","targetVersion":null,"log":"secret"}"#).is_err());
        let mut o = Outbox::default();
        o.enable("1.0.0").unwrap();
        o.events[0].sequence = 0;
        assert!(o.validate().is_err());
    }
    #[test]
    fn invalid_versions_and_false_confirmations_do_not_enter_the_outbox() {
        let mut o = Outbox::default();
        assert!(o.enable("private text").is_err());
        assert!(!o.enabled && o.identity.is_none());
        o.enable("1.0.0").unwrap();
        let before = o.events.len();
        assert!(o
            .push(Kind::UpdateConfirmed, "1.0.0", Some("1.1.0"))
            .is_err());
        assert!(o.push(Kind::InstallStarted, "1.0.0", None).is_err());
        assert!(o.push(Kind::Heartbeat, "", None).is_err());
        assert_eq!(before, o.events.len());
    }
}
