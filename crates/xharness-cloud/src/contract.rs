use crate::{CloudError, CloudResult, ErrorCode};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub const PROTOCOL: &str = "xharness-cloud/v1";
pub const FINGERPRINT_VERSION: &str = "xharness-cloud-fingerprint/v1";

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct Id(String);

impl Id {
    pub fn new(value: impl Into<String>) -> CloudResult<Self> {
        let value = value.into();
        if value.is_empty()
            || value.len() > 128
            || value.starts_with('.')
            || !value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-.".contains(&b))
        {
            return Err(invalid("invalid opaque identifier"));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Id {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

/// Canonical decimal string on the wire; no lossy JSON numbers or leading zeroes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct Counter(pub u64);

impl Counter {
    pub fn next(self) -> CloudResult<Self> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or_else(|| invalid("counter overflow"))
    }
}

impl Serialize for Counter {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}

impl<'de> Deserialize<'de> for Counter {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty()
            || (text.len() > 1 && text.starts_with('0'))
            || !text.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(D::Error::custom("expected canonical decimal string"));
        }
        text.parse()
            .map(Self)
            .map_err(|_| D::Error::custom("counter overflow"))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn new(value: impl Into<String>) -> CloudResult<Self> {
        let value = value.into();
        if value.len() != 64
            || !value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("expected lowercase SHA-256 digest"));
        }
        Ok(Self(value))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersionedRef {
    pub id: Id,
    pub version: Id,
}

impl CloudTaskSpec {
    /// Canonical materialized task identity shared by controller/native bootstrap.
    /// Secrets are never fields of this document; it contains versioned refs.
    pub fn fingerprint(&self) -> CloudResult<Sha256Digest> {
        let value = serde_json::to_value(self).map_err(|_| invalid("task cannot be normalized"))?;
        let mut canonical = Vec::new();
        canonical_json(&value, &mut canonical)?;
        let mut hash = Sha256::new();
        hash.update(b"xharness-cloud-task-spec/v1\n");
        hash.update(canonical);
        Sha256Digest::new(format!("{:x}", hash.finalize()))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum WorkspaceSource {
    GitRevision {
        repository_ref: VersionedRef,
        /// Full SHA-1 or SHA-256 object ID, never a moving branch/tag.
        commit: String,
        #[serde(default)]
        patch_bundle_ref: Option<VersionedRef>,
    },
    UploadedBundle {
        object_ref: VersionedRef,
        manifest_sha256: Sha256Digest,
        unpack_policy_ref: VersionedRef,
    },
    ExistingWorkspace {
        workspace_ref: VersionedRef,
        expected_fingerprint: Sha256Digest,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Permission {
    #[serde(rename = "full-access")]
    FullAccess,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SystemPrivilege {
    #[default]
    StandardUser,
    Sudo,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudTaskSpec {
    pub environment_ref: VersionedRef,
    pub objective: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    pub workspace_source: WorkspaceSource,
    #[serde(default)]
    pub selected_material_refs: Vec<VersionedRef>,
    pub model_config_ref: VersionedRef,
    pub credential_ref: VersionedRef,
    pub permission: Permission,
    #[serde(default)]
    pub system_privilege: SystemPrivilege,
    pub resource_policy_ref: VersionedRef,
    pub stop_policy_ref: VersionedRef,
    #[serde(default)]
    pub usage_policy_ref: Option<VersionedRef>,
    pub retention_policy_ref: VersionedRef,
    #[serde(default)]
    pub notification_policy_ref: Option<VersionedRef>,
}

/// Admission limits, not model context limits. Texts are rejected, never truncated.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdmissionLimits {
    pub request_bytes: usize,
    pub objective_bytes: usize,
    pub criterion_bytes: usize,
    pub criteria_count: usize,
    pub materials_count: usize,
}

impl Default for AdmissionLimits {
    fn default() -> Self {
        Self {
            request_bytes: 256 * 1024,
            objective_bytes: 64 * 1024,
            criterion_bytes: 8 * 1024,
            criteria_count: 64,
            materials_count: 64,
        }
    }
}

impl CloudTaskSpec {
    pub fn validate(&self, limits: &AdmissionLimits) -> CloudResult<()> {
        if self.objective.trim().is_empty() || self.objective.len() > limits.objective_bytes {
            return Err(invalid("objective is blank or exceeds admission limit"));
        }
        if self.acceptance_criteria.len() > limits.criteria_count
            || self.selected_material_refs.len() > limits.materials_count
            || self
                .acceptance_criteria
                .iter()
                .any(|s| s.trim().is_empty() || s.len() > limits.criterion_bytes)
        {
            return Err(invalid("criteria or materials exceed admission limits"));
        }
        if let WorkspaceSource::GitRevision { commit, .. } = &self.workspace_source {
            if ![40, 64].contains(&commit.len())
                || !commit
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(invalid(
                    "git source requires a fixed lowercase commit object ID",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmitTask {
    pub spec: CloudTaskSpec,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CancelTask {
    pub task_id: Id,
    pub expected_revision: Counter,
}

/// This slice exposes submission/cancellation only; Describe must not advertise
/// unimplemented Gateway, collection or deployment operations.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "method", content = "payload")]
pub enum Command {
    #[serde(rename = "task.submit")]
    Submit(Box<SubmitTask>),
    #[serde(rename = "task.cancel")]
    Cancel(CancelTask),
}

impl Command {
    pub fn method(&self) -> &'static str {
        match self {
            Self::Submit(_) => "task.submit",
            Self::Cancel(_) => "task.cancel",
        }
    }

    pub fn fingerprint(&self) -> CloudResult<PayloadFingerprint> {
        // Sort explicitly, independent of serde_json's preserve_order feature.
        // Typed decoding materializes defaults; list and text order stay exact.
        let value =
            serde_json::to_value(self).map_err(|_| invalid("command cannot be normalized"))?;
        let mut canonical = Vec::new();
        canonical_json(&value, &mut canonical)?;
        let mut hash = Sha256::new();
        hash.update(FINGERPRINT_VERSION.as_bytes());
        hash.update(b"\n");
        hash.update(canonical);
        Ok(PayloadFingerprint {
            version: FINGERPRINT_VERSION.into(),
            sha256: Sha256Digest::new(format!("{:x}", hash.finalize()))?,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PayloadFingerprint {
    pub version: String,
    pub sha256: Sha256Digest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CommandEnvelope {
    pub protocol: String,
    pub request_id: Id,
    #[serde(flatten)]
    pub command: Command,
}

impl CommandEnvelope {
    pub fn new(request_id: Id, command: Command) -> Self {
        Self {
            protocol: PROTOCOL.into(),
            request_id,
            command,
        }
    }

    pub fn decode(bytes: &[u8], limits: &AdmissionLimits) -> CloudResult<Self> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            protocol: String,
            request_id: Id,
            method: String,
            payload: Box<serde_json::value::RawValue>,
        }
        if bytes.len() > limits.request_bytes {
            return Err(invalid("request exceeds admission limit"));
        }
        let wire: Wire =
            serde_json::from_slice(bytes).map_err(|_| invalid("malformed command envelope"))?;
        if wire.protocol != PROTOCOL {
            return Err(CloudError::new(
                ErrorCode::VersionUnsupported,
                "unsupported cloud protocol",
            ));
        }
        // Keep original JSON so duplicate fields cannot disappear in a Value map.
        // Raw JSON is private to this adapter and never forwarded to Host.
        let command = match wire.method.as_str() {
            "task.submit" => Command::Submit(
                serde_json::from_str(wire.payload.get())
                    .map_err(|_| invalid("invalid submit payload"))?,
            ),
            "task.cancel" => Command::Cancel(
                serde_json::from_str(wire.payload.get())
                    .map_err(|_| invalid("invalid cancel payload"))?,
            ),
            _ => return Err(invalid("unsupported cloud command")),
        };
        let envelope = Self {
            protocol: wire.protocol,
            request_id: wire.request_id,
            command,
        };
        envelope.validate(limits)?;
        Ok(envelope)
    }

    pub fn validate(&self, limits: &AdmissionLimits) -> CloudResult<()> {
        if self.protocol != PROTOCOL {
            return Err(CloudError::new(
                ErrorCode::VersionUnsupported,
                "unsupported cloud protocol",
            ));
        }
        if serde_json::to_vec(self)
            .map_err(|_| invalid("invalid command"))?
            .len()
            > limits.request_bytes
        {
            return Err(invalid("request exceeds admission limit"));
        }
        if let Command::Submit(request) = &self.command {
            request.spec.validate(limits)?;
        }
        Ok(())
    }
}

pub(crate) fn invalid(message: &'static str) -> CloudError {
    CloudError::new(ErrorCode::InvalidRequest, message)
}

fn canonical_json(value: &serde_json::Value, out: &mut Vec<u8>) -> CloudResult<()> {
    match value {
        serde_json::Value::Object(map) => {
            out.push(b'{');
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                out.extend(serde_json::to_vec(key).map_err(|_| invalid("invalid key"))?);
                out.push(b':');
                canonical_json(value, out)?;
            }
            out.push(b'}');
        }
        serde_json::Value::Array(items) => {
            out.push(b'[');
            for (index, value) in items.iter().enumerate() {
                if index > 0 {
                    out.push(b',');
                }
                canonical_json(value, out)?;
            }
            out.push(b']');
        }
        _ => out.extend(serde_json::to_vec(value).map_err(|_| invalid("invalid value"))?),
    }
    Ok(())
}
