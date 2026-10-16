//! Host-initiated bounded relay connection. Disconnect never owns an Agent task.
use crate::{
    pairing::valid_id,
    protocol::{
        ErrorCode, HostFrame, MobileResponse, RelayFrame, Secret, MAX_FRAME_BYTES,
        MAX_PENDING_REQUESTS,
    },
    MobileHost,
};
use futures::{SinkExt, StreamExt};
use std::{collections::BTreeSet, sync::Arc, time::Duration};
use tokio::task::JoinSet;
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
};
use tokio_util::sync::CancellationToken;
use url::Url;

#[derive(Clone)]
pub struct OutboundConfig {
    pub url: String,
    pub key: Secret,
    /// Explicit disposable experiment exception; never enables cleartext LAN/public WS.
    pub allow_loopback_ws: bool,
}
impl OutboundConfig {
    pub fn validate(&self) -> Result<(), ErrorCode> {
        let url = Url::parse(&self.url).map_err(|_| ErrorCode::InvalidRequest)?;
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(ErrorCode::InvalidRequest);
        }
        let tls = url.scheme() == "wss";
        let loopback = self.allow_loopback_ws
            && url.scheme() == "ws"
            && matches!(
                url.host_str(),
                Some("127.0.0.1" | "localhost" | "[::1]" | "::1")
            );
        if !tls && !loopback {
            return Err(ErrorCode::InvalidRequest);
        }
        if url.host_str().is_none() {
            return Err(ErrorCode::InvalidRequest);
        }
        Ok(())
    }
}
/// One owned supervisor per Host. Safe reads may be re-requested by clients;
/// this worker never replays relay commands on reconnect, even on a lost ACK.
pub async fn run_outbound(
    host: Arc<MobileHost>,
    config: OutboundConfig,
    stop: CancellationToken,
) -> Result<(), ErrorCode> {
    config.validate()?;
    let mut delay = Duration::from_secs(1);
    loop {
        if stop.is_cancelled() {
            return Ok(());
        }
        let mut limits = WebSocketConfig::default();
        limits.max_message_size = Some(MAX_FRAME_BYTES);
        limits.max_frame_size = Some(MAX_FRAME_BYTES);
        let connected = tokio::select! {
            biased;
            _ = stop.cancelled() => return Ok(()),
            result = tokio::time::timeout(Duration::from_secs(20),connect_async_with_config(config.url.as_str(),Some(limits),false)) => result,
        };
        if let Ok(Ok((socket, _))) = connected {
            delay = Duration::from_secs(1);
            let (mut sink, mut source) = socket.split();
            let hello = serde_json::to_string(&HostFrame::Hello {
                host: host.gateway.host_id().into(),
                key: config.key.clone(),
            })
            .map_err(|_| ErrorCode::InvalidRequest)?;
            let sent = tokio::time::timeout(
                Duration::from_secs(5),
                sink.send(Message::Text(hello.into())),
            )
            .await;
            let ready = if matches!(sent, Ok(Ok(()))) {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => None,
                    result = tokio::time::timeout(Duration::from_secs(8),source.next()) => match result {
                        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<RelayFrame>(text.as_ref()).ok(),
                        _ => None,
                    }
                }
            } else {
                None
            };
            if matches!(ready, Some(RelayFrame::Ready)) {
                let mut tasks = JoinSet::new();
                let mut ids = BTreeSet::new();
                let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
                heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                let mut received = tokio::time::Instant::now();
                loop {
                    let outgoing = tokio::select! {
                        biased;
                        _ = stop.cancelled() => break,
                        completed = tasks.join_next(), if !tasks.is_empty() => {
                            match completed {
                                Some(Ok((id,response))) => { ids.remove(&id); Some(HostFrame::Response {id,response}) },
                                _ => break,
                            }
                        },
                        frame = source.next() => {
                            received = tokio::time::Instant::now();
                            match frame {
                                Some(Ok(Message::Text(text))) => {
                                    let request = serde_json::from_str::<RelayFrame>(text.as_ref());
                                    match request {
                                        Ok(RelayFrame::Request {id,request}) if valid_id(&id) => {
                                            // Duplicate transport IDs are not mutation IDs and must not
                                            // ambiguously associate a response with another HTTP waiter.
                                            if ids.contains(&id) { break; }
                                            if tasks.len() >= MAX_PENDING_REQUESTS {
                                                Some(HostFrame::Response {id,response:MobileResponse::failure(ErrorCode::Capacity)})
                                            } else {
                                                ids.insert(id.clone());
                                                let host=host.clone();
                                                tasks.spawn(async move {
                                                    let response=tokio::time::timeout(Duration::from_secs(15),host.handle(request)).await.unwrap_or_else(|_|MobileResponse::failure(ErrorCode::Timeout));
                                                    (id,response)
                                                });
                                                None
                                            }
                                        },
                                        _ => break,
                                    }
                                },
                                Some(Ok(Message::Ping(payload))) => {
                                    if !matches!(tokio::time::timeout(Duration::from_secs(5),sink.send(Message::Pong(payload))).await,Ok(Ok(()))) { break; }
                                    None
                                },
                                Some(Ok(Message::Pong(_))) => None,
                                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                                _ => break,
                            }
                        },
                        _ = heartbeat.tick() => {
                            if received.elapsed()>Duration::from_secs(60) { break; }
                            if !matches!(tokio::time::timeout(Duration::from_secs(5),sink.send(Message::Ping(Vec::new().into()))).await,Ok(Ok(()))) { break; }
                            None
                        },
                    };
                    if let Some(frame) = outgoing {
                        let text =
                            serde_json::to_string(&frame).map_err(|_| ErrorCode::InvalidRequest)?;
                        if text.len() > MAX_FRAME_BYTES
                            || !matches!(
                                tokio::time::timeout(
                                    Duration::from_secs(5),
                                    sink.send(Message::Text(text.into()))
                                )
                                .await,
                                Ok(Ok(()))
                            )
                        {
                            break;
                        }
                    }
                }
                // Bound and drain native intake/pairing waiters before dropping the
                // transport. Already admitted Host work remains in Gateway's supervisor.
                let drained = tokio::time::timeout(Duration::from_secs(16), async {
                    while tasks.join_next().await.is_some() {}
                })
                .await;
                if drained.is_err() {
                    tasks.abort_all();
                    while tasks.join_next().await.is_some() {}
                }
            }
            let _ =
                tokio::time::timeout(Duration::from_secs(2), sink.send(Message::Close(None))).await;
        }
        tokio::select! { biased; _=stop.cancelled()=>return Ok(()), _=tokio::time::sleep(delay)=>{} }
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(url: &str, allow: bool) -> OutboundConfig {
        OutboundConfig {
            url: url.into(),
            key: "a".repeat(64).try_into().unwrap(),
            allow_loopback_ws: allow,
        }
    }
    #[test]
    fn transport_requires_tls_and_never_puts_credentials_in_urls() {
        assert!(config("wss://relay.example/api/mobile/host", false)
            .validate()
            .is_ok());
        for url in [
            "http://relay.example/",
            "https://relay.example/",
            "ws://relay.example/",
            "ws://192.168.2.1/",
            "wss://u:password@relay.example/",
            "wss://relay.example/?key=secret",
            "wss://relay.example/#secret",
        ] {
            assert!(config(url, true).validate().is_err(), "{url}");
        }
        assert!(config("ws://127.0.0.1:9000/api/mobile/host", false)
            .validate()
            .is_err());
        assert!(config("ws://127.0.0.1:9000/api/mobile/host", true)
            .validate()
            .is_ok());
        assert!(config("ws://[::1]:9000/api/mobile/host", true)
            .validate()
            .is_ok());
    }
}
