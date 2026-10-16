use crate::{
    pairing::valid_id,
    protocol::{ErrorCode, MobileAction, MobileRequest, MobileResponse, MAX_FRAME_BYTES},
    MobileHost,
};
use futures::StreamExt;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio_util::sync::CancellationToken;
use xharness_remote::{
    Account, Channel, Command, ControllerCreated, Delivery, Inbound, NativeCommandResult,
    Subscription,
};

pub(crate) fn remote_error(error: xharness_remote::Error) -> ErrorCode {
    use xharness_remote::Error as E;
    match error {
        E::Unauthorized | E::StaleLease => ErrorCode::Unauthorized,
        E::IdentityConflict | E::CursorConflict => ErrorCode::Conflict,
        E::Capacity => ErrorCode::Capacity,
        E::Invalid(_) | E::Json(_) => ErrorCode::InvalidRequest,
        E::HostUnavailable => ErrorCode::HostUnavailable,
        E::StreamGap => ErrorCode::StreamGap,
        E::SessionBlocked | E::ReplyBlocked | E::ReplyBusy | E::ReplyDeferred => {
            ErrorCode::Conflict
        }
        _ => ErrorCode::StorageUnavailable,
    }
}
fn receipt(delivery: &Delivery, expose_result: bool) -> Value {
    let result = if expose_result {
        match delivery.result.as_ref() {
            Some(NativeCommandResult::Success { value }) => Some(json!({"ok":true,"value":value})),
            Some(NativeCommandResult::Failure { .. }) => {
                Some(json!({"ok":false,"error":{"code":"operation_failed"}}))
            }
            None => None,
        }
    } else {
        None
    };
    // Never return raw input, caller-provided secret strings, or native diagnostics.
    json!({"key":delivery.key,"state":delivery.state,"generation":delivery.binding.generation,"principal_revision":delivery.principal_revision,"result":result,"result_withheld":!expose_result})
}
impl MobileHost {
    pub async fn handle(self: &Arc<Self>, request: MobileRequest) -> MobileResponse {
        // In-process callers follow the same bounds as the outbound wire worker.
        if serde_json::to_vec(&request).map_or(true, |bytes| bytes.len() > MAX_FRAME_BYTES) {
            return MobileResponse::failure(ErrorCode::Capacity);
        }
        let result = self.handle_inner(request).await;
        let response = match result {
            Ok(result) => MobileResponse::success(result),
            Err(error) => MobileResponse::failure(error),
        };
        if serde_json::to_vec(&response).map_or(true, |bytes| bytes.len() > MAX_FRAME_BYTES - 1024)
        {
            return MobileResponse::failure(ErrorCode::Capacity);
        }
        response
    }
    async fn handle_inner(self: &Arc<Self>, request: MobileRequest) -> Result<Value, ErrorCode> {
        let MobileRequest::Authenticated {
            device,
            secret,
            action,
        } = request
        else {
            if let MobileRequest::Pair { code, name } = request {
                return serde_json::to_value(self.redeem(code, name).await?)
                    .map_err(|_| ErrorCode::StorageUnavailable);
            }
            return Err(ErrorCode::InvalidRequest);
        };
        let scope = self.authenticate(device.clone(), secret.clone()).await?;
        let result = match action {
            MobileAction::Status => {
                let route = self
                    .gateway
                    .resolve_sender(scope.sender.clone(), scope.conversation.clone())
                    .await
                    .map_err(remote_error)?
                    .ok_or(ErrorCode::Unauthorized)?;
                let catalogue = self
                    .gateway
                    .controller_catalogue(scope.clone(), None)
                    .await
                    .map_err(remote_error)?;
                json!({"host":self.gateway.host_id(),"device":device,"binding":{"workspace":route.binding.workspace,"session":route.binding.session,"generation":route.binding.generation},"generation":scope.generation,"principal_revision":catalogue.principal_revision})
            }
            MobileAction::Catalogue { after } => serde_json::to_value(
                self.gateway
                    .controller_catalogue(scope.clone(), after)
                    .await
                    .map_err(remote_error)?,
            )
            .map_err(|_| ErrorCode::StorageUnavailable)?,
            MobileAction::Command {
                request_id,
                generation,
                command,
            } => {
                if !valid_id(&request_id) {
                    return Err(ErrorCode::InvalidRequest);
                }
                if generation != scope.generation {
                    return Err(ErrorCode::Conflict);
                }
                let inbound = Inbound {
                    request_id,
                    binding: scope.binding.clone(),
                    generation,
                    command,
                };
                let delivery = self
                    .gateway
                    .accept(
                        &scope.principal,
                        scope.sender.clone(),
                        scope.conversation.clone(),
                        inbound,
                    )
                    .await
                    .map_err(remote_error)?;
                // The existing Gateway supervisor, never the network waiter, owns execution.
                // Deduplication may return a result from an older permission revision.
                // Apply the same disclosure check as explicit receipt queries.
                let expose_result = delivery.result.is_none()
                    || self.may_disclose_result(&scope, &delivery).await?;
                receipt(&delivery, expose_result)
            }
            MobileAction::Delivery { key } => {
                // Lost admission acknowledgement: query the original stable request identity,
                // even after a selection changed its old binding generation. No replay occurs.
                let delivery = if let Some(request_id) = key.strip_prefix("request:") {
                    if !valid_id(request_id) {
                        return Err(ErrorCode::InvalidRequest);
                    }
                    self.gateway
                        .inspect_request(
                            scope.sender.clone(),
                            scope.conversation.clone(),
                            request_id.into(),
                        )
                        .await
                } else {
                    if !valid_id(&key) {
                        return Err(ErrorCode::InvalidRequest);
                    }
                    self.gateway.inspect(&key).await
                }
                .map_err(remote_error)?
                .ok_or(ErrorCode::InvalidRequest)?;
                if delivery.principal != scope.principal
                    || delivery.binding.principal != scope.principal
                    || delivery.binding.conversation != scope.conversation
                    || delivery.binding.id != scope.binding
                {
                    return Err(ErrorCode::Unauthorized);
                }
                let expose_result = self.may_disclose_result(&scope, &delivery).await?;
                receipt(&delivery, expose_result)
            }
            MobileAction::Snapshot => self.snapshot(scope.clone()).await?,
            MobileAction::Events { after } => {
                let lease = {
                    let mut slot = self.event_lease.lock().await;
                    match slot.as_ref() {
                        Some(lease) => lease.clone(),
                        None => {
                            let lease = self
                                .gateway
                                .acquire_account(Account {
                                    channel: Channel::MobileWeb,
                                    id: "mobile".into(),
                                })
                                .await
                                .map_err(remote_error)?;
                            *slot = Some(lease.clone());
                            lease
                        }
                    }
                };
                let page = self
                    .gateway
                    .read_event_page(&lease, scope.clone(), after)
                    .await
                    .map_err(remote_error)?;
                json!({"generation":scope.generation,"page":page})
            }
        };
        // Close the authentication/read race: no result is returned to a sealed device,
        // and reads from a superseded route must be retried from authoritative state.
        let current = self.authenticate(device, secret).await?;
        if current != scope {
            // Mutation receipts retain original identity across an intentional Select.
            // They contain no new task execution or Agent-completion claim.
            if result.get("key").is_none() {
                return Err(ErrorCode::Conflict);
            }
        }
        Ok(result)
    }
    async fn may_disclose_result(
        &self,
        scope: &Subscription,
        delivery: &Delivery,
    ) -> Result<bool, ErrorCode> {
        let catalogue = self
            .gateway
            .controller_catalogue(scope.clone(), None)
            .await
            .map_err(remote_error)?;
        if catalogue.principal_revision == delivery.principal_revision {
            return Ok(true);
        }
        // Creation is the only original receipt that can legitimately advance
        // its own grant revision without invalidating its binding generation.
        Ok(match (&delivery.inbound.command, &delivery.result) {
            (
                Command::CreateSession { .. },
                Some(NativeCommandResult::Success { value: Some(value) }),
            ) => serde_json::from_value::<ControllerCreated>(value.clone())
                .ok()
                .is_some_and(|r| {
                    r.is_for_delivery(delivery)
                        && r.principal_revision == catalogue.principal_revision
                }),
            _ => false,
        })
    }
    async fn snapshot(&self, scope: Subscription) -> Result<Value, ErrorCode> {
        let stop = CancellationToken::new();
        let mut stream = tokio::time::timeout(
            Duration::from_secs(3),
            self.gateway.subscribe(scope.clone(), stop.clone()),
        )
        .await
        .map_err(|_| ErrorCode::Timeout)?
        .map_err(remote_error)?;
        let mut frames = Vec::new();
        let mut interactions = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        loop {
            let frame = match tokio::time::timeout_at(
                deadline.min(tokio::time::Instant::now() + Duration::from_millis(150)),
                stream.next(),
            )
            .await
            {
                Ok(Some(Ok(frame))) => frame,
                Ok(Some(Err(error))) => {
                    stop.cancel();
                    return Err(remote_error(error));
                }
                Ok(None) | Err(_) => break,
            };
            if frames.len() == 128 {
                stop.cancel();
                return Err(ErrorCode::Capacity);
            }
            if matches!(
                frame.method.as_str(),
                "approval/requested" | "question/requested"
            ) {
                match self
                    .gateway
                    .mint_interaction_ticket(scope.clone(), frame.rpc_id.clone(), 600)
                    .await
                {
                    Ok(ticket) => interactions.push(ticket),
                    Err(
                        xharness_remote::Error::Invalid(_)
                        | xharness_remote::Error::IdentityConflict,
                    ) => {} // Resolved between native snapshot and ticket creation.
                    Err(error) => {
                        stop.cancel();
                        return Err(remote_error(error));
                    }
                }
            }
            frames.push(frame);
            if serde_json::to_vec(&json!({"frames":&frames,"interactions":&interactions}))
                .map_or(true, |v| v.len() > MAX_FRAME_BYTES - 2048)
            {
                stop.cancel();
                return Err(ErrorCode::Capacity);
            }
        }
        stop.cancel();
        // No persistent relay event queue. Client calls Snapshot again for current
        // pending interactions and Events for contiguous durable output recovery.
        Ok(json!({"generation":scope.generation,"frames":frames,"interactions":interactions}))
    }
}
