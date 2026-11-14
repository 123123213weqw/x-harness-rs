//! Real WebView execution through the authenticated production bridge.
use crate::{bridge_call, browser_bridge};
use serde_json::json;

pub async fn run(connection: &browser_bridge::Connection) -> Result<(), String> {
    let before = bridge_call(connection, "parent", "observe", json!({})).await?;
    let executed = bridge_call(connection,"parent","evaluate",json!({
        "code":"window.aiConsoleProbe=args.value;document.querySelector('#answer').value=args.value;localStorage.setItem('ai-eval',args.value);console.log('console-proof',args.value);const response=await fetch(location.href);return {answer:document.querySelector('#answer').value,stored:localStorage.getItem('ai-eval'),fetched:(await response.text()).includes('Native observation probe'),big:42n,hostAccess:await window.__TAURI__.core.invoke('desktop_browser_access',{tabId:'probe',owner:'parent'}).then(()=> 'allowed',()=> 'denied')};",
        "args":{"value":"native-script-value"}
    })).await?;
    let result = &executed["result"];
    if executed["ok"] != true
        || result["ok"] != true
        || result["value"]["answer"] != "native-script-value"
        || result["value"]["stored"] != "native-script-value"
        || result["value"]["fetched"] != true
        || result["console"][0]["level"] != "log"
        || result["value"]["big"]["value"] != "42"
        || result["value"]["hostAccess"] != "denied"
    {
        return Err(format!(
            "native JavaScript DOM/fetch/console result mismatch: {executed}"
        ));
    }
    let stale = bridge_call(
        connection,
        "parent",
        "perform",
        json!({"action":"scroll","delta_y":1,"frame_id":before["result"]["frame_id"]}),
    )
    .await?;
    if stale["result"]["effect"] != "not_started" {
        return Err("JavaScript did not invalidate old DOM refs".into());
    }
    let failed = bridge_call(
        connection,
        "parent",
        "evaluate",
        json!({"code":"window.aiPartialEffect=true;throw new Error('native-script-error');"}),
    )
    .await?;
    if failed["result"]["status"] != "exception"
        || failed["result"]["effect"] != "unknown"
        || failed["result"]["error"]["message"] != "native-script-error"
    {
        return Err("native script exception was hidden or claimed no effect".into());
    }
    let timed = bridge_call(
        connection,
        "parent",
        "evaluate",
        json!({"code":"await new Promise(()=>{});","timeout_ms":20}),
    )
    .await?;
    if timed["result"]["status"] != "timeout" || timed["result"]["effect"] != "unknown" {
        return Err("native script timeout claimed a known effect".into());
    }
    let large = bridge_call(
        connection,
        "parent",
        "evaluate",
        json!({"code":"return Array(10000).fill('🧪'.repeat(100));"}),
    )
    .await?;
    if large["result"]["ok"] != true
        || large["result"]["truncated"] != true
        || large.to_string().len() > 12 * 1024
    {
        return Err("native JavaScript output is not bounded".into());
    }
    let malformed =
        bridge_call(connection, "parent", "evaluate", json!({"code":"return ("})).await?;
    if malformed["result"]["ok"] != false {
        return Err("native JavaScript syntax failure reported success".into());
    }
    let spoof = bridge_call(
        connection,
        "parent",
        "evaluate",
        json!({"code":"return 1","tab_id":"main"}),
    )
    .await?;
    if spoof["result"]["effect"] != "not_started" {
        return Err("JavaScript accepted a caller-controlled target".into());
    }
    let other = bridge_call(
        connection,
        "child",
        "evaluate",
        json!({"code":"window.foreignOwner=true"}),
    )
    .await?;
    if other["result"]["effect"] != "not_started" {
        return Err("JavaScript crossed chat ownership".into());
    }
    let restored = bridge_call(connection,"parent","evaluate",json!({"code":"document.querySelector('#answer').value='unchanged';console.warn('after-error');return window.aiPartialEffect;"})).await?;
    if restored["result"]["value"] != true || restored["result"]["console"][0]["level"] != "warn" {
        return Err("native JavaScript failed to recover after exception/timeout".into());
    }
    println!("Native arbitrary JavaScript passed: async DOM write, fetch, storage, args, BigInt, console capture, exception/partial effects, timeout, output budget, stale refs, syntax failure, exact owner and no Host IPC");
    Ok(())
}
