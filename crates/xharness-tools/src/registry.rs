use std::{collections::BTreeMap, sync::Arc};

use tokio::sync::RwLock;

use crate::{validate_tool_schema, SchemaViolation, ToolDefinition, ToolSpec};

const MAX_TOOL_NAME_BYTES: usize = 64;

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum RegistryError {
    #[error("tool name must not be empty")]
    EmptyName,
    #[error("invalid tool name {name:?}: use 1-64 ASCII letters, digits, '_' or '-'")]
    InvalidName { name: String },
    #[error("tool {name:?} is already registered")]
    DuplicateName { name: String },
    #[error("tool {name:?} has an invalid parameter schema: {violation}")]
    InvalidSchema {
        name: String,
        violation: SchemaViolation,
    },
    #[error("tool {name:?} timeout must be greater than zero")]
    ZeroTimeout { name: String },
}

/// Concurrent registry with deterministic definition enumeration and atomic
/// duplicate detection.
#[derive(Clone, Default)]
pub struct ToolRegistry {
    tools: Arc<RwLock<BTreeMap<String, Arc<ToolSpec>>>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn register(&self, spec: ToolSpec) -> Result<Arc<ToolSpec>, RegistryError> {
        validate_spec(&spec)?;
        let name = spec.definition.name.clone();
        let mut tools = self.tools.write().await;
        if tools.contains_key(&name) {
            return Err(RegistryError::DuplicateName { name });
        }
        let spec = Arc::new(spec);
        tools.insert(name, Arc::clone(&spec));
        Ok(spec)
    }

    pub async fn get(&self, name: &str) -> Option<Arc<ToolSpec>> {
        self.tools.read().await.get(name).cloned()
    }

    pub async fn definitions(&self) -> Vec<ToolDefinition> {
        self.tools
            .read()
            .await
            .values()
            .map(|spec| spec.definition.clone())
            .collect()
    }

    pub async fn len(&self) -> usize {
        self.tools.read().await.len()
    }

    pub async fn is_empty(&self) -> bool {
        self.tools.read().await.is_empty()
    }
}

fn validate_spec(spec: &ToolSpec) -> Result<(), RegistryError> {
    let name = &spec.definition.name;
    if name.is_empty() {
        return Err(RegistryError::EmptyName);
    }
    if name.len() > MAX_TOOL_NAME_BYTES
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(RegistryError::InvalidName { name: name.clone() });
    }
    if spec.timeout.is_zero() {
        return Err(RegistryError::ZeroTimeout { name: name.clone() });
    }
    validate_tool_schema(&spec.definition.parameters).map_err(|violation| {
        RegistryError::InvalidSchema {
            name: name.clone(),
            violation,
        }
    })
}
