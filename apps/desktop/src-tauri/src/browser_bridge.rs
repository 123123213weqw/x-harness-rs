//! Private length-framed loopback bridge. Credentials go only to the Host
//! sidecar, never to a guest page, tool schema, persisted tab or renderer event.
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{OnceCell, Semaphore};

use crate::{browser::BrowserState, browser_inspect, browser_lifecycle, browser_perform};

const MAX_REQUEST: usize = 32 * 1024;
const MAX_REPLY: usize = 64 * 1024;

#[derive(Default)]
pub struct BrowserBridge(OnceCell<Connection>);
pub struct Connection {
    pub address: String,
    pub token: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    token: String,
    owner: String,
    op: Operation,
    arguments: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Operation {
    List,
    Control,
    Observe,
    Perform,
}

fn matches_token(provided: &str, expected: &str) -> bool {
    provided.len() == 64
        && expected.len() == 64
        && provided
            .as_bytes()
            .iter()
            .zip(expected.as_bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

impl BrowserBridge {
    pub async fn start(&self, app: &AppHandle) -> Result<&Connection, String> {
        self.0
            .get_or_try_init(|| async {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .map_err(|_| "native browser bridge unavailable")?;
                let address = listener
                    .local_addr()
                    .map_err(|_| "native browser address unavailable")?
                    .to_string();
                let mut bytes = [0u8; 32];
                getrandom::fill(&mut bytes).map_err(|_| "native browser entropy unavailable")?;
                let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
                let secret = token.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let slots = Arc::new(Semaphore::new(8));
                    while let Ok((stream, _)) = listener.accept().await {
                        let Ok(permit) = Arc::clone(&slots).try_acquire_owned() else {
                            continue;
                        };
                        let app = app.clone();
                        let secret = secret.clone();
                        tauri::async_runtime::spawn(async move {
                            let _permit = permit;
                            let _ = tokio::time::timeout(
                                Duration::from_secs(36),
                                serve(stream, app, &secret),
                            )
                            .await;
                        });
                    }
                });
                Ok(Connection { address, token })
            })
            .await
    }
}

async fn serve(mut stream: TcpStream, app: AppHandle, secret: &str) -> Result<(), ()> {
    let request = tokio::time::timeout(Duration::from_secs(3), async {
        let length = stream.read_u32().await.map_err(|_| ())? as usize;
        if length == 0 || length > MAX_REQUEST {
            return Err(());
        }
        let mut bytes = vec![0; length];
        stream.read_exact(&mut bytes).await.map_err(|_| ())?;
        let request: Request = serde_json::from_slice(&bytes).map_err(|_| ())?;
        if !matches_token(&request.token, secret)
            || request.owner.is_empty()
            || request.owner.len() > 128
        {
            return Err(());
        }
        Ok(request)
    })
    .await
    .map_err(|_| ())??;
    // Closing the Host socket cancels open's UI rendezvous too. No detached
    // navigation continues after a caller has abandoned the request.
    let result = tokio::select! {
        result = dispatch(&app, request) => result,
        _ = stream.read_u8() => return Err(()),
    };
    let reply = match result {
        Ok(result) => json!({"ok":true,"result":result}),
        Err(error) => json!({"ok":false,"error":error}),
    };
    let bytes = serde_json::to_vec(&reply).map_err(|_| ())?;
    if bytes.len() > MAX_REPLY {
        return Err(());
    }
    stream.write_u32(bytes.len() as u32).await.map_err(|_| ())?;
    stream.write_all(&bytes).await.map_err(|_| ())?;
    Ok(())
}

async fn dispatch(app: &AppHandle, request: Request) -> Result<Value, String> {
    let state = app.state::<BrowserState>();
    if matches!(request.op, Operation::List) {
        if request.arguments != json!({}) {
            return Err("list takes no arguments".into());
        }
        return Ok(browser_lifecycle::descriptor(&state, &request.owner));
    }
    if matches!(request.op, Operation::Control) {
        let action = match parse_control(request.arguments) {
            Ok(action) => action,
            Err(receipt) => return Ok(receipt),
        };
        return match action {
            browser_lifecycle::ControlRequest::Status {} => {
                Ok(browser_lifecycle::descriptor(&state, &request.owner))
            }
            browser_lifecycle::ControlRequest::Open { url } => {
                if let Err(error) = crate::browser::web_url(&url) {
                    return Ok(rejected_action(&error));
                }
                app.state::<browser_lifecycle::BrowserLifecycle>()
                    .open(app, &request.owner, url)
                    .await
            }
        };
    }
    let tab = match state.delegated_tab(&request.owner) {
        Ok(tab) => tab,
        Err(error) if matches!(request.op, Operation::Perform) => {
            return Ok(rejected_action(&error))
        }
        Err(error) => return Err(error),
    };
    match request.op {
        Operation::Observe => {
            browser_inspect::inspect(
                &state,
                &tab,
                serde_json::from_value(request.arguments)
                    .map_err(|_| "invalid native observation arguments")?,
                Some(&request.owner),
            )
            .await
        }
        Operation::Perform => {
            let arguments = match parse_action(request.arguments) {
                Ok(arguments) => arguments,
                Err(receipt) => return Ok(receipt),
            };
            // perform() returns Err only BEFORE scheduling JS. After scheduling,
            // callback loss/navigation/malformed receipts are Ok(effect=unknown).
            match browser_perform::perform(&state, &tab, arguments, Some(&request.owner)).await {
                Ok(receipt) => {
                    serde_json::to_value(receipt).map_err(|_| "invalid native receipt".into())
                }
                Err(error) => Ok(rejected_action(&error)),
            }
        }
        Operation::List | Operation::Control => unreachable!(),
    }
}

fn rejected_action(message: &str) -> Value {
    json!({"ok":false,"effect":"not_started","message":message.chars().take(500).collect::<String>()})
}

fn parse_action(arguments: Value) -> Result<browser_perform::PerformRequest, Value> {
    serde_json::from_value(arguments).map_err(|_| rejected_action("invalid native action arguments; describe perform for the action-specific schema; no action was scheduled"))
}

fn parse_control(arguments: Value) -> Result<browser_lifecycle::ControlRequest, Value> {
    serde_json::from_value(arguments).map_err(|_| rejected_action("invalid native control arguments; describe control for status/open; no navigation was scheduled"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_control_is_unstarted_and_does_not_echo_private_input() {
        for arguments in [
            json!({"action":"eval","script":"private-input"}),
            json!({"action":"status","owner":"private-input"}),
            json!({"action":"open","url":123}),
        ] {
            let receipt = parse_control(arguments).err().unwrap();
            assert_eq!(receipt["ok"], false);
            assert_eq!(receipt["effect"], "not_started");
            assert!(!receipt.to_string().contains("private-input"));
        }
        assert!(parse_control(json!({"action":"status"})).is_ok());
    }
    #[test]
    fn malformed_action_is_not_started_not_unknown_and_never_echoes_input() {
        let receipt = parse_action(json!({"action":"eval","script":"private-input"})).unwrap_err();
        assert_eq!(receipt["ok"], false);
        assert_eq!(receipt["effect"], "not_started");
        assert!(!receipt.to_string().contains("private-input"));
        assert!(
            parse_action(json!({"action":"click","frame_id":"a".repeat(32),"ref":"n0"})).is_ok()
        );
    }
    #[test]
    fn private_protocol_has_no_tab_override_eval_or_guest_control() {
        let token = "a".repeat(64);
        assert!(matches_token(&token, &token));
        assert!(!matches_token(&"b".repeat(64), &token));
        assert!(!matches_token(&"a".repeat(63), &token));
        let mut request = json!({"token":token,"owner":"session","op":"observe","arguments":{}});
        assert!(serde_json::from_value::<Request>(request.clone()).is_ok());
        request["tab_id"] = json!("another-session");
        assert!(serde_json::from_value::<Request>(request.clone()).is_err());
        request.as_object_mut().unwrap().remove("tab_id");
        request["op"] = json!("eval");
        assert!(serde_json::from_value::<Request>(request).is_err());
    }
}
