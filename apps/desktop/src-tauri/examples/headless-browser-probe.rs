//! Isolated engine acceptance transport. No installed Host, profile or model.
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use xharness_desktop::headless_browser::Browsers;
fn main() {
    if xharness_desktop::headless_browser::run_helper() {
        return;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let browsers = Browsers::default();
        println!(
            "BENCH_REPLY {}",
            json!({"seq":0,"ok":true,"result":{"ready":true,"test_only":true}})
        );
        for line in std::io::stdin().lock().lines() {
            let line = line.unwrap();
            if line.len() > 32768 {
                break;
            }
            let request: Value = serde_json::from_str(&line).unwrap();
            let owner = request["owner"].as_str().unwrap_or("acceptance-owner");
            let op = request["op"].as_str().unwrap_or("");
            let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
            // Acceptance-only cancellation: drop the real manager future while
            // a loopback page is handling a native press. No product RPC added.
            let result = if op == "cancel_input" {
                match tokio::time::timeout(
                    std::time::Duration::from_millis(200),
                    browsers.dispatch(owner, "input", args),
                )
                .await
                {
                    Err(_) => Ok(json!({"cancelled":true})),
                    Ok(_) => Err("fixture action finished before cancellation".to_owned()),
                }
            } else if op == "preview" {
                browsers
                    .preview(owner, args["tab_id"].as_str().unwrap_or(""))
                    .await
            } else if op == "close" {
                browsers.close(owner).await
            } else {
                browsers.dispatch(owner, op, args).await
            };
            let packet = match result {
                Ok(value) => json!({"seq":request["seq"],"ok":true,"result":value}),
                Err(error) => json!({"seq":request["seq"],"ok":false,"result":{"error":error}}),
            };
            println!("BENCH_REPLY {packet}");
            let _ = std::io::stdout().flush();
            if op == "close" {
                break;
            }
        }
        browsers.shutdown().await;
    });
}
