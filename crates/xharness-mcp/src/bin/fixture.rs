//! Small deterministic stdio server used only by MCP integration tests.
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines().map_while(Result::ok) {
        let Ok(input) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = input.get("id") else { continue };
        let result = match input.get("method").and_then(Value::as_str).unwrap_or("") {
            "initialize" => {
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
                json!({"content":[{"type":"text","text":value}],"isError":false})
            }
            _ => json!({}),
        };
        let reply = json!({"jsonrpc":"2.0","id":id,"result":result});
        if writeln!(stdout, "{reply}").is_err() || stdout.flush().is_err() {
            break;
        }
    }
}
