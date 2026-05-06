//! Pure session catalogue, search, and local history pagination policy.

use serde_json::{json, Value};

pub(crate) const MAX_SEARCH_RESULTS: usize = 20;

#[derive(Clone, Debug)]
pub(crate) struct SessionSearchRecord {
    pub(crate) id: String,
    pub(crate) event_texts: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HistoryWindow {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) has_more: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SearchQueryError {
    Invalid,
}

pub(crate) struct SessionProcessor;

impl SessionProcessor {
    pub(crate) fn list(mut summaries: Vec<Value>) -> Value {
        summaries
            .sort_by_key(|item| std::cmp::Reverse(item["updatedAt"].as_u64().unwrap_or_default()));
        json!({"items": summaries})
    }

    pub(crate) fn normalize_query(query: &str) -> Result<String, SearchQueryError> {
        let query = query.trim();
        if query.is_empty() || query.chars().count() > 500 || query.contains('\0') {
            return Err(SearchQueryError::Invalid);
        }
        Ok(query.to_lowercase())
    }

    pub(crate) fn search(
        query: &str,
        records: impl IntoIterator<Item = SessionSearchRecord>,
    ) -> Value {
        let mut matches = Vec::new();
        for record in records {
            let Some(text) = record
                .event_texts
                .into_iter()
                .find(|text| text.to_lowercase().contains(query))
            else {
                continue;
            };
            matches.push(json!({
                "sessionId": record.id,
                "snippet": truncate_chars(&text, 240),
            }));
            if matches.len() > MAX_SEARCH_RESULTS {
                break;
            }
        }
        let has_more = matches.len() > MAX_SEARCH_RESULTS;
        matches.truncate(MAX_SEARCH_RESULTS);
        json!({"items": matches, "hasMore": has_more})
    }

    pub(crate) fn history_window(
        event_types: &[Option<&str>],
        event_base_seq: u64,
        next_event_seq: u64,
        before_seq: Option<u64>,
        max_messages: usize,
    ) -> HistoryWindow {
        let end_seq = before_seq.unwrap_or(next_event_seq).min(next_event_seq);
        let end = usize::try_from(end_seq.saturating_sub(event_base_seq))
            .unwrap_or(usize::MAX)
            .min(event_types.len());
        let mut start = end;
        let mut messages = 0usize;
        while start > 0 && messages < max_messages {
            start -= 1;
            if matches!(
                event_types[start],
                Some("user/message" | "assistant/message" | "tool/result")
            ) {
                messages += 1;
            }
        }
        HistoryWindow {
            start,
            end,
            has_more: start > 0 || event_base_seq > 0,
        }
    }
}

fn truncate_chars(input: &str, max: usize) -> String {
    let mut chars = input.chars();
    let output = chars.by_ref().take(max).collect::<String>();
    if chars.next().is_some() {
        format!("{output}…")
    } else {
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_is_newest_first_and_missing_time_is_oldest() {
        let value = SessionProcessor::list(vec![
            json!({"sessionId": "old", "updatedAt": 1}),
            json!({"sessionId": "missing"}),
            json!({"sessionId": "new", "updatedAt": 9}),
        ]);
        assert_eq!(value["items"][0]["sessionId"], "new");
        assert_eq!(value["items"][2]["sessionId"], "missing");
    }

    #[test]
    fn search_is_bounded_case_insensitive_and_unicode_safe() {
        let records = (0..22).map(|index| SessionSearchRecord {
            id: format!("s{index}"),
            event_texts: vec![format!("PREFIX {}", "界".repeat(300))],
        });
        let value = SessionProcessor::search("prefix", records);
        assert_eq!(value["items"].as_array().unwrap().len(), MAX_SEARCH_RESULTS);
        assert_eq!(value["hasMore"], true);
        assert!(value["items"][0]["snippet"]
            .as_str()
            .unwrap()
            .ends_with('…'));
        assert_eq!(
            SessionProcessor::normalize_query(" \0 "),
            Err(SearchQueryError::Invalid)
        );
    }

    #[test]
    fn history_window_counts_only_visible_message_events() {
        let types = [
            Some("session/started"),
            Some("user/message"),
            Some("tool/call"),
            Some("tool/result"),
            Some("assistant/message"),
        ];
        let window = SessionProcessor::history_window(&types, 4, 9, None, 2);
        assert_eq!(window.start, 3);
        assert_eq!(window.end, 5);
        assert!(window.has_more);

        let first = SessionProcessor::history_window(&types, 0, 5, Some(2), 50);
        assert_eq!(first.start, 0);
        assert_eq!(first.end, 2);
        assert!(!first.has_more);
    }
}
