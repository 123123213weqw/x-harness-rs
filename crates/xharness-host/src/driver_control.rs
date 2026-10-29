//! Ordered control acknowledgements must not own the event pump.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use crate::{
    runtime::{RunningTurn, TurnControlFuture},
    state::DriverCommand,
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};
use xharness_core::{LoopControlError, LoopEvent};

pub(crate) const ACK_TIMEOUT: Duration = Duration::from_secs(10);
type Ack = oneshot::Sender<Result<(), LoopControlError>>;
#[derive(Default)]
pub(crate) struct ControlPump {
    pending: Option<(TurnControlFuture, Ack)>,
    closed: bool,
}
impl ControlPump {
    pub(crate) async fn next(
        &mut self,
        run: &mut dyn RunningTurn,
        rx: &mut mpsc::Receiver<DriverCommand>,
    ) -> Option<LoopEvent> {
        loop {
            tokio::select! {
                event=run.next_event()=> {
                    if event.is_none() {
                        if let Some((_,ack))=self.pending.take() { acknowledge(ack,Err(LoopControlError::Closed)); }
                    }
                    return event;
                }
                command=rx.recv(), if !self.closed && self.pending.is_none()=> {
                    match command {
                        Some(command)=> {
                            if let Some(future)=run.detached_control(command.command.clone(),command.input_metadata.clone()) {
                                let future=Box::pin(async move {
                                    tokio::time::timeout(ACK_TIMEOUT,future).await.unwrap_or_else(|_| Err(LoopControlError::Rejected("control acknowledgement timed out; outcome unknown; not retried".into())))
                                });
                                self.pending=Some((future,command.acknowledgement));
                            } else {
                                // Compatibility for external runtimes without a
                                // detachable command face: still bounded, never
                                // an unbounded event-consumption deadlock.
                                let result=tokio::time::timeout(ACK_TIMEOUT,run.send_with_metadata(command.command,command.input_metadata)).await
                                    .unwrap_or_else(|_| Err(LoopControlError::Rejected("control acknowledgement timed out; outcome unknown; not retried".into())));
                                acknowledge(command.acknowledgement,result);
                            }
                        }
                        None=>self.closed=true,
                    }
                }
                result=async { match self.pending.as_mut() { Some((future,_))=>future.await, None=>std::future::pending().await } }=> {
                    if let Some((_,ack))=self.pending.take() { acknowledge(ack,result); }
                }
            }
        }
    }
}

fn acknowledge(ack: Ack, result: Result<(), LoopControlError>) {
    if ack.send(result).is_err() {
        // Caller disconnected. Do not retry an accepted control or claim the
        // lost reply as evidence that the operation failed to execute.
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use xharness_core::{LoopCommand, LoopEventKind, LoopResult};
    struct HeldControl {
        events: mpsc::Receiver<LoopEvent>,
        entered: Arc<tokio::sync::Notify>,
    }
    #[async_trait::async_trait]
    impl RunningTurn for HeldControl {
        fn detached_control(
            &self,
            _: LoopCommand,
            _: Option<serde_json::Value>,
        ) -> Option<TurnControlFuture> {
            let entered = self.entered.clone();
            Some(Box::pin(async move {
                entered.notify_one();
                std::future::pending().await
            }))
        }
        async fn next_event(&mut self) -> Option<LoopEvent> {
            self.events.recv().await
        }
        async fn send(&mut self, _: LoopCommand) -> Result<(), LoopControlError> {
            panic!("must use independent control")
        }
        async fn result(&mut self) -> LoopResult {
            panic!("not a result test")
        }
    }
    #[tokio::test]
    async fn pending_ack_does_not_block_checkpoint_or_terminal_and_is_not_retried() {
        let entered = Arc::new(tokio::sync::Notify::new());
        let (events, receiver) = mpsc::channel(4);
        let mut run = HeldControl {
            events: receiver,
            entered: entered.clone(),
        };
        let (controls, mut rx) = mpsc::channel(4);
        let (ack, accepted) = oneshot::channel();
        controls
            .send(DriverCommand {
                command: LoopCommand::InterruptByUser,
                input_metadata: None,
                acknowledgement: ack,
            })
            .await
            .unwrap();
        let mut pump = ControlPump::default();
        {
            let next = pump.next(&mut run, &mut rx);
            tokio::pin!(next);
            tokio::select! { _=&mut next=>panic!("no event yet"), _=entered.notified()=>{} }
            events
                .send(LoopEvent {
                    seq: 1,
                    run_id: "synthetic".into(),
                    step: 1,
                    kind: LoopEventKind::StreamCheckpoint,
                })
                .await
                .unwrap();
            assert!(tokio::time::timeout(Duration::from_secs(1), next)
                .await
                .unwrap()
                .is_some());
        }
        drop(events);
        assert!(
            tokio::time::timeout(Duration::from_secs(1), pump.next(&mut run, &mut rx))
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(accepted.await.unwrap(), Err(LoopControlError::Closed));
    }
}
