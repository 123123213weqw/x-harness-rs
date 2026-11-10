//! Small deterministic stdio server used only by MCP integration tests.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() {
    if std::env::var_os("XH_MCP_PANEL_FIXTURE").is_some() {
        panel_fixture();
        return;
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(input) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = input.get("id") else { continue };
        let result = match input.get("method").and_then(Value::as_str).unwrap_or("") {
            "initialize" => {
                if let Ok(delay) = std::env::var("XH_MCP_FIXTURE_START_DELAY_MS") {
                    if let Ok(milliseconds) = delay.parse::<u64>() {
                        std::thread::sleep(std::time::Duration::from_millis(
                            milliseconds.min(1000),
                        ));
                    }
                }
                json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"fixture","version":"1.0"}})
            }
            "tools/list" => {
                json!({"tools":[{"name":"echo","description":"Echo text","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]})
            }
            "tools/call" => {
                let value = input["params"]["arguments"]["text"].as_str().unwrap_or("");
                if value == "sleep" {
                    std::thread::sleep(std::time::Duration::from_secs(10));
                }
                let text = if value == "__pid" {
                    std::process::id().to_string()
                } else {
                    value.to_owned()
                };
                json!({"content":[{"type":"text","text":text}],"isError":false})
            }
            _ => json!({}),
        };
        let reply = json!({"jsonrpc":"2.0","id":id,"result":result});
        if writeln!(stdout, "{reply}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}

fn panel_fixture() {
    use std::sync::{Arc, Condvar, Mutex};
    let signal = Arc::new((Mutex::new(false), Condvar::new()));
    let mut cancelled_count = 0u64;
    let mut started_count = 0u64;
    fn reply(id: Value, result: Value) {
        let mut out = io::stdout().lock();
        let _ = writeln!(out, "{}", json!({"jsonrpc":"2.0","id":id,"result":result}));
        let _ = out.flush();
    }
    let mut workers = Vec::new();
    for line in io::stdin().lock().lines().map_while(Result::ok) {
        let Ok(input) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if input["method"] == "notifications/cancelled" {
            cancelled_count += 1;
            *signal.0.lock().unwrap() = true;
            signal.1.notify_all();
            continue;
        }
        let Some(id) = input.get("id").cloned() else {
            continue;
        };
        match input["method"].as_str().unwrap_or("") {
            "initialize" => reply(
                id,
                json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"panel-fixture","version":"1"}}),
            ),
            "tools/list" => reply(
                id,
                json!({"tools":[{"name":"wait_app","description":"Wait for the app reply","inputSchema":{"type":"object"}},{"name":"_editor_reply","description":"App-only reply","inputSchema":{"type":"object"},"_meta":{"ui":{"visibility":["app"]}}}]}),
            ),
            "tools/call" if input["params"]["name"] == "wait_app" => {
                started_count += 1;
                let signal = signal.clone();
                workers.push(std::thread::spawn(move || {
                    let (lock, cv) = &*signal;
                    let flag = lock.lock().unwrap();
                    let (flag, _) = cv
                        .wait_timeout_while(flag, std::time::Duration::from_secs(5), |v| !*v)
                        .unwrap();
                    reply(
                        id,
                        json!({"content":[{"type":"text","text":if *flag{"app-replied"}else{"timed-out"}}]}),
                    );
                }));
            }
            "tools/call" if input["params"]["arguments"]["mode"] == "started-count" => {
                reply(
                    id,
                    json!({"content":[{"type":"text","text":started_count.to_string()}]}),
                );
            }
            "tools/call" if input["params"]["arguments"]["mode"] == "cancelled-count" => {
                reply(
                    id,
                    json!({"content":[{"type":"text","text":cancelled_count.to_string()}]}),
                );
            }
            "tools/call" => {
                let (lock, cv) = &*signal;
                *lock.lock().unwrap() = true;
                cv.notify_all();
                reply(id, json!({"content":[{"type":"text","text":"ok"}]}));
            }
            "resources/read" => reply(
                id,
                json!({"contents":[{"uri":input["params"]["uri"],"text":"panel resource"}]}),
            ),
            _ => reply(id, json!({})),
        }
    }
    for worker in workers {
        worker.join().expect("panel fixture worker panicked");
    }
}
