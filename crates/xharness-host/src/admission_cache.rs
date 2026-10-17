//! Small prompt receipts; the durable inbox remains the source on cache miss.
#![forbid(unsafe_code)]

use std::collections::{BTreeMap, VecDeque};

use serde::{de::MapAccess, Deserialize, Deserializer, Serialize, Serializer};

const MAX_ENTRIES: usize = 256;
const MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct AdmissionReceipt {
    // Unknown legacy QueuedPrompt fields are intentionally ignored. Recovery
    // may read v3 checkpoints without retaining their text/content/source.
    pub fingerprint: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AdmissionCache {
    entries: BTreeMap<String, AdmissionReceipt>,
    order: VecDeque<String>,
    bytes: usize,
    bounded: bool,
}

impl AdmissionCache {
    pub(crate) fn new(durable: bool) -> Self {
        Self {
            bounded: durable,
            ..Self::default()
        }
    }

    fn weight(id: &str, receipt: &AdmissionReceipt) -> usize {
        // Two owned identity strings, one fingerprint and conservative node
        // overhead. This is an accounting bound, not an allocator RSS claim.
        id.len()
            .saturating_mul(2)
            .saturating_add(receipt.fingerprint.as_ref().map_or(0, String::len))
            .saturating_add(192)
    }

    pub(crate) fn insert(&mut self, id: String, mut receipt: AdmissionReceipt) {
        let id = id.into_boxed_str().into_string();
        receipt.fingerprint = receipt
            .fingerprint
            .map(|s| s.into_boxed_str().into_string());
        if let Some(old) = self.entries.remove(&id) {
            self.bytes = self.bytes.saturating_sub(Self::weight(&id, &old));
            self.order.retain(|key| key != &id);
        }
        let bytes = Self::weight(&id, &receipt);
        if self.bounded && bytes > MAX_BYTES {
            return;
        }
        self.bytes = self.bytes.saturating_add(bytes);
        self.order.push_back(id.clone());
        self.entries.insert(id, receipt);
        if self.bounded {
            while self.entries.len() > MAX_ENTRIES || self.bytes > MAX_BYTES {
                let Some(oldest) = self.order.pop_front() else {
                    break;
                };
                if let Some(old) = self.entries.remove(&oldest) {
                    self.bytes = self.bytes.saturating_sub(Self::weight(&oldest, &old));
                }
            }
        }
    }

    pub(crate) fn get(&self, id: &str) -> Option<&AdmissionReceipt> {
        self.entries.get(id)
    }
}

impl Serialize for AdmissionCache {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.entries.serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for AdmissionCache {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = AdmissionCache;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a map of prompt admission receipts")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut cache = AdmissionCache::new(true);
                while let Some((id, receipt)) = map.next_entry()? {
                    cache.insert(id, receipt);
                }
                Ok(cache)
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn durable_receipts_are_bounded_and_legacy_prompt_bodies_are_not_retained() {
        let mut cache = AdmissionCache::new(true);
        for n in 0..1000 {
            cache.insert(
                n.to_string(),
                AdmissionReceipt {
                    fingerprint: Some("f".repeat(64)),
                },
            );
        }
        assert!(cache.entries.len() <= MAX_ENTRIES);
        assert!(cache.bytes <= MAX_BYTES);
        assert!(cache.get("0").is_none());
        assert!(cache.get("999").is_some());
        cache.insert(
            "x".repeat(MAX_BYTES),
            AdmissionReceipt {
                fingerprint: Some("f".into()),
            },
        );
        assert!(cache.bytes <= MAX_BYTES);
        let old = json!({"old": {"id":"old","fingerprint":"same","text":"large".repeat(10000),"content":[{"text":"payload"}],"source":{},"placement":"Queued"}});
        let restored: AdmissionCache = serde_json::from_value(old).unwrap();
        assert_eq!(
            restored.get("old").unwrap().fingerprint.as_deref(),
            Some("same")
        );
        assert_eq!(
            serde_json::to_value(restored).unwrap(),
            json!({"old":{"fingerprint":"same"}})
        );
    }

    #[test]
    fn non_durable_embeddings_keep_exact_receipts_without_a_durable_fallback() {
        let mut cache = AdmissionCache::new(false);
        for n in 0..1000 {
            cache.insert(
                n.to_string(),
                AdmissionReceipt {
                    fingerprint: Some(n.to_string()),
                },
            );
        }
        assert_eq!(cache.get("0").unwrap().fingerprint.as_deref(), Some("0"));
    }
}
