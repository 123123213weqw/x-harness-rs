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

use crate::{browser::BrowserState, browser_inspect, browser_perform};

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
                    let slots = Arc::new(Semaphore::new(2));
                    while let Ok((stream, _)) = listener.accept().await {
                        let Ok(permit) = Arc::clone(&slots).try_acquire_owned() else {
                            continue;
                        };
                        let app = app.clone();
                        let secret = secret.clone();
                        tauri::async_runtime::spawn(async move {
                            let _permit = permit;
                            let _ = tokio::time::timeout(
                                Duration::from_secs(15),
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
    let result = dispatch(&app, request).await;
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
        return Ok(json!({"available":state.delegated_tab(&request.owner).is_ok()}));
    }
    let tab = state.delegated_tab(&request.owner)?;
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
        Operation::Perform => serde_json::to_value(
            browser_perform::perform(
                &state,
                &tab,
                serde_json::from_value(request.arguments)
                    .map_err(|_| "invalid native action arguments")?,
                Some(&request.owner),
            )
            .await?,
        )
        .map_err(|_| "invalid native receipt".into()),
        Operation::List => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
