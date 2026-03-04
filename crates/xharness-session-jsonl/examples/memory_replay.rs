//! Synthetic audit-heavy histories; never reads user data. Run each replay in a
//! separate process under /usr/bin/time -v to compare peak RSS fairly.
use std::{path::PathBuf, time::Instant};
use xharness_session::{
    EventData, Message, RequestHeader, Revision, SessionHeader, Store, TurnEndReason,
};
use xharness_session_jsonl::JsonlSessionStore;
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    let mode = args.get(1).ok_or("mode required")?;
    let root = PathBuf::from(args.get(2).ok_or("new test directory required")?);
    if mode.starts_with("generate-") {
        if root.exists() {
            return Err("refusing existing fixture directory".into());
        }
        let store = JsonlSessionStore::new(&root)?;
        for id in 0..8 {
            let id = format!("fixture-{id}");
            store.create(SessionHeader::new(&id)).await?;
            let mut revision = Revision::ZERO;
            for turn in 1..=64u32 {
                let mut header = RequestHeader::new("fake", "fake");
                header.input = (0..turn)
                    .map(|n| Message::user(format!("{n}:{}", "x".repeat(4096))))
                    .collect();
                if mode == "generate-archive" {
                    header = store.archive_request(header).await?;
                }
                revision = store
                    .append(
                        &id,
                        revision,
                        vec![
                            EventData::TurnStart { turn }.into(),
                            EventData::UserMessage {
                                message: Message::user(format!("fact {turn}")),
                                surface_replace: None,
                            }
                            .into(),
                            EventData::StepStart { turn, step: 1 }.into(),
                            EventData::RequestHeader { header }.into(),
                            EventData::AssistantMessage {
                                turn,
                                step: 1,
                                message: Message::assistant(format!("answer {turn}")),
                                usage: None,
                            }
                            .into(),
                            EventData::StepEnd { turn, step: 1 }.into(),
                            EventData::TurnEnd {
                                turn,
                                reason: TurnEndReason::Completed,
                            }
                            .into(),
                        ],
                    )
                    .await?
                    .revision;
            }
            store.flush(&id).await?;
        }
    } else {
        let store = if mode == "replay-raw" {
            JsonlSessionStore::new(&root)?.with_cache_limits(usize::MAX, usize::MAX)
        } else {
            JsonlSessionStore::new(&root)?.for_runtime()
        };
        let start = Instant::now();
        let mut facts = 0;
        for h in store.list_headers().await? {
            facts += store.load(&h.id).await?.unwrap().derive_messages().len();
        }
        let audit = store
            .request_header("fixture-0", 3)
            .await?
            .ok_or("missing snapshot")?;
        assert_eq!(audit.input.len(), 1);
        assert_eq!(facts, 1024);
        let stats = store.cache_stats();
        println!(
            "{}",
            serde_json::json!({"mode":mode,"facts":facts,"elapsed_ms":start.elapsed().as_millis(),"cache_bytes":stats.accounted_bytes,"cache_entries":stats.entries,"snapshot_read":true})
        );
    }
    Ok(())
}
