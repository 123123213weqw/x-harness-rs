use std::collections::HashSet;

use serde_json::{json, Value};
use xharness_api::{
    protocol::{TypedRpcParams, TypedRpcResponse},
    ClientRequest, HostFrame, MuxFrame, RpcErrorCode, RpcId, RpcMethod, RpcReceipt, RpcResult,
    ServerRequest, ServerResponse, UPSTREAM_CONTRACT_REVISION,
};

const SUPPORTED_METHODS: &[&str] = &[
    "session.list",
    "session.search",
    "session.create",
    "session.import",
    "session.history",
    "session.models",
    "session.selectModel",
    "session.rename",
    "session.fork",
    "session.prompt",
    "session.attachment",
    "session.updateQueue",
    "session.cancel",
    "session.delete",
    "subagent.list",
    "subagent.history",
    "subagent.prompt",
    "subagent.interrupt",
    "host.describe",
    "host.pickDirectory",
    "host.listDirectory",
    "host.createDirectory",
    "host.openPath",
    "workspace.list",
    "workspace.create",
    "workspace.rename",
    "workspace.delete",
    "workspace.insertBefore",
    "workspace.insertSessionBefore",
    "workspace.archiveSession",
    "workspace.unarchiveSession",
    "skill.list",
    "agentPreset.list",
    "agentPreset.select",
    "agentPreset.read",
    "agentPreset.copy",
    "agentPreset.openDocument",
    "agentPreset.remove",
    "goal.updatePlan",
    "goal.create",
    "goal.edit",
    "goal.pause",
    "goal.resume",
    "goal.complete",
    "goal.clear",
    "settings.describe",
    "settings.openDocument",
    "settings.update",
    "settings.replace",
    "settings.mutate",
    "credentials.describe",
    "credentials.set",
    "credentials.unset",
    "llm.providers",
    "llm.models",
    "llm.discoverModels",
];

#[test]
fn method_directory_matches_upstream_plus_session_lifecycle_extensions() {
    assert_eq!(UPSTREAM_CONTRACT_REVISION, "deepseek-harness@141eb6fef8");
    let actual = RpcMethod::ALL
        .iter()
        .map(|method| method.as_str())
        .collect::<Vec<_>>();
    assert_eq!(actual, SUPPORTED_METHODS);
    assert_eq!(actual.iter().copied().collect::<HashSet<_>>().len(), 56);
    for name in SUPPORTED_METHODS {
        assert_eq!(name.parse::<RpcMethod>().unwrap().as_str(), *name);
    }
}

#[test]
fn mux_and_host_discriminants_match_frontend_frames() {
    let mux = MuxFrame::SessionSubscribed {
        session_id: "s".into(),
        last_seq: -1,
    }
    .into_server_request(RpcId::new("m1"));
    assert_eq!(
        serde_json::to_value(mux).unwrap(),
        json!({
            "type": "server-request", "rpcId": "m1", "method": "session/subscribed",
            "payload": {"type":"session/subscribed", "sessionId":"s", "lastSeq":-1}
        })
    );

    let host = HostFrame::SessionStatus {
        session_id: "s".into(),
        running: true,
    }
    .into_server_request(RpcId::new("h1"));
    assert_eq!(host.method, "host/session-status");
    assert_eq!(host.payload["sessionId"], "s");
}

#[test]
fn question_stream_retains_deferred_wait_metadata_and_accepts_legacy_shape() {
    let legacy = json!({"type":"question/requested","sessionId":"s","questions":[]});
    let decoded: MuxFrame = serde_json::from_value(legacy.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), legacy);
    let current = json!({"type":"question/requested","sessionId":"s","questions":[],"deferred":true,"waitTimeoutSeconds":60});
    let decoded: MuxFrame = serde_json::from_value(current.clone()).unwrap();
    assert_eq!(serde_json::to_value(decoded).unwrap(), current);
    assert!(serde_json::from_value::<MuxFrame>(
        json!({"type":"question/requested","sessionId":"s","questions":[],"deferred":"true"})
    )
    .is_err());
}

#[test]
fn four_quadrant_envelopes_match_wire_shape() {
    let request = ClientRequest::new(RpcId::new("c1"), RpcMethod::SessionList, json!({}));
    assert_eq!(
        serde_json::to_value(&request).unwrap(),
        json!({
            "type": "client-request", "rpcId": "c1", "method": "session.list", "payload": {}
        })
    );

    let response = ServerResponse::new(RpcId::new("c1"), RpcResult::success(json!({"items": []})));
    let encoded = serde_json::to_value(&response).unwrap();
    assert_eq!(
        encoded,
        json!({
            "type": "server-response", "rpcId": "c1",
            "result": {"ok": true, "value": {"items": []}}
        })
    );
    assert_eq!(
        serde_json::from_value::<ServerResponse>(encoded).unwrap(),
        response
    );

    let frame = ServerRequest::frame(
        RpcId::new("s1"),
        json!({"type": "session/subscribed", "sessionId": "session", "lastSeq": -1}),
    )
    .unwrap();
    assert_eq!(frame.method, "session/subscribed");
    assert_eq!(
        serde_json::to_value(frame).unwrap()["type"],
        "server-request"
    );
}

#[test]
fn result_and_receipt_boolean_discriminants_are_strict() {
    assert!(serde_json::from_value::<RpcResult>(json!({"ok": true})).is_ok());
    assert!(serde_json::from_value::<RpcResult>(json!({"ok": false})).is_err());
    assert!(serde_json::from_value::<RpcResult>(json!({
        "ok": false,
        "error": {"code": "internal", "message": "x", "details": {}}
    }))
    .is_ok());
    assert_eq!(
        serde_json::to_value(RpcReceipt::Accepted).unwrap(),
        json!({"accepted": true})
    );
    assert!(serde_json::from_value::<RpcReceipt>(json!({"accepted": false})).is_err());

    let error_code: RpcErrorCode =
        serde_json::from_value(Value::String("bad-request".into())).unwrap();
    assert_eq!(error_code, RpcErrorCode::BadRequest);
}

fn canonical_request(method: RpcMethod) -> Value {
    match method {
        RpcMethod::SessionList => json!({}),
        RpcMethod::SessionSearch => json!({"query":"needle"}),
        RpcMethod::SessionImport => json!({"source":"codex","jsonl":"{}\n","preview":true}),
        RpcMethod::SessionCreate => json!({"workspaceId":"workspace","agentPreset":"coding"}),
        RpcMethod::SessionHistory => json!({"sessionId":"session","beforeSeq":42,"maxMessages":50}),
        RpcMethod::SessionModels => json!({"sessionId":"session"}),
        RpcMethod::SessionSelectModel => json!({
            "sessionId":"session", "provider":"provider", "model":"model",
            "reasoningEffort":"high"
        }),
        RpcMethod::SessionRename => json!({"sessionId":"session","title":"title"}),
        RpcMethod::SessionFork => json!({"sessionId":"session","atSeq":7}),
        RpcMethod::SessionPrompt => json!({
            "sessionId":"session", "mode":"queue",
            "content":[{"type":"text","text":"hello"}],
            "requireIdle":true, "clientTimeZone":"Asia/Shanghai"
        }),
        RpcMethod::SessionAttachment => json!({"sessionId":"session","attachmentId":"attachment"}),
        RpcMethod::SessionUpdateQueue => json!({
            "sessionId":"session", "itemId":"item", "action":{"kind":"remove"}
        }),
        RpcMethod::SessionCancel => json!({"sessionId":"session"}),
        RpcMethod::SubagentList => json!({"parentSessionId":"parent"}),
        RpcMethod::SubagentHistory => json!({
            "parentSessionId":"parent", "childSessionId":"child", "mode":"continuable"
        }),
        RpcMethod::SubagentPrompt => json!({
            "parentSessionId":"parent", "childSessionId":"child", "mode":"continuable",
            "content":[{"type":"text","text":"continue"}]
        }),
        RpcMethod::SubagentInterrupt => json!({
            "parentSessionId":"parent", "childSessionId":"child", "mode":"continuable"
        }),
        RpcMethod::HostDescribe | RpcMethod::HostPickDirectory => json!({}),
        RpcMethod::HostListDirectory => json!({"path":"/tmp"}),
        RpcMethod::HostCreateDirectory => json!({"path":"/tmp","name":"child"}),
        RpcMethod::HostOpenPath => json!({"path":"/tmp"}),
        RpcMethod::WorkspaceList => json!({}),
        RpcMethod::WorkspaceCreate => json!({"path":"/tmp"}),
        RpcMethod::WorkspaceRename => json!({"workspaceId":"workspace","title":"title"}),
        RpcMethod::WorkspaceDelete => json!({"workspaceId":"workspace"}),
        RpcMethod::WorkspaceInsertBefore => json!({
            "workspaceId":"workspace", "beforeWorkspaceId":"other"
        }),
        RpcMethod::WorkspaceInsertSessionBefore => json!({
            "workspaceId":"workspace", "sessionId":"session", "beforeSessionId":"other"
        }),
        RpcMethod::WorkspaceArchiveSession => json!({"sessionId":"session"}),
        RpcMethod::WorkspaceUnarchiveSession | RpcMethod::SessionDelete => {
            json!({"sessionId":"session"})
        }
        RpcMethod::SkillList => json!({"sessionId":"session"}),
        RpcMethod::AgentPresetList => json!({}),
        RpcMethod::AgentPresetSelect => json!({"sessionId":"session","agentPreset":"coding"}),
        RpcMethod::AgentPresetRead => json!({"agentPreset":"coding"}),
        RpcMethod::AgentPresetCopy => json!({"from":"coding","agentPreset":"custom"}),
        RpcMethod::AgentPresetOpenDocument | RpcMethod::AgentPresetRemove => {
            json!({"agentPreset":"custom"})
        }
        RpcMethod::GoalUpdatePlan => json!({"sessionId":"session","planRevision":0,"items":[]}),
        RpcMethod::GoalCreate => json!({"sessionId":"session","objective":"ship"}),
        RpcMethod::GoalEdit => json!({
            "sessionId":"session", "ref":{"id":"goal","revision":1},
            "objective":"ship safely", "maxGoalRounds":64
        }),
        RpcMethod::GoalPause
        | RpcMethod::GoalResume
        | RpcMethod::GoalComplete
        | RpcMethod::GoalClear => {
            json!({"sessionId":"session","ref":{"id":"goal","revision":1}})
        }
        RpcMethod::SettingsDescribe | RpcMethod::SettingsOpenDocument => json!({}),
        RpcMethod::SettingsUpdate => json!({
            "ns":"xharness", "patch":{"theme":"dark"}, "expectedRevision":1
        }),
        RpcMethod::SettingsReplace => json!({
            "ns":"xharness", "section":{"theme":"dark"}, "expectedRevision":1
        }),
        RpcMethod::SettingsMutate => json!({
            "ns":"xharness", "ops":[{"op":"set","path":["theme"],"value":"dark"}],
            "expectedRevision":1
        }),
        RpcMethod::CredentialsDescribe => json!({"refs":["EXAMPLE_API_KEY"]}),
        RpcMethod::CredentialsSet => json!({"ref":"EXAMPLE_API_KEY","value":"secret"}),
        RpcMethod::CredentialsUnset => json!({"ref":"EXAMPLE_API_KEY"}),
        RpcMethod::LlmProviders | RpcMethod::LlmModels => json!({}),
        RpcMethod::LlmDiscoverModels => json!({"settingsNs":"llm-example"}),
    }
}

#[test]
fn every_fixed_rpc_method_has_a_typed_request_contract() {
    for &method in RpcMethod::ALL {
        let payload = canonical_request(method);
        let typed = TypedRpcParams::decode(method, &payload)
            .unwrap_or_else(|error| panic!("{method}: {error}; payload={payload}"));
        assert_eq!(typed.method(), method);
        assert_eq!(typed.to_value(), payload, "{method} request roundtrip");
    }
}

#[test]
fn typed_protocol_reports_method_and_side_for_shape_errors() {
    let error = TypedRpcParams::decode(RpcMethod::SessionHistory, &json!({})).unwrap_err();
    assert_eq!(error.method, RpcMethod::SessionHistory);
    assert_eq!(error.side, "request");

    let error = TypedRpcResponse::decode(RpcMethod::SessionList, &json!({})).unwrap_err();
    assert_eq!(error.method, RpcMethod::SessionList);
    assert_eq!(error.side, "response");
}

#[test]
fn compatibility_boundary_tolerates_additive_fields() {
    let payload = json!({"sessionId":"session","futureField":{"enabled":true}});
    let typed = TypedRpcParams::decode(RpcMethod::SessionModels, &payload).unwrap();
    assert_eq!(typed.method(), RpcMethod::SessionModels);
}

#[test]
fn working_plan_contract_has_typed_items_and_a_plan_not_a_goal_ref() {
    let value =
        json!({"plan":{"revision":1,"items":[{"id":"a","title":"Verify","status":"in_progress"}]}});
    let reply = TypedRpcResponse::decode(RpcMethod::GoalUpdatePlan, &value).unwrap();
    let TypedRpcResponse::GoalUpdatePlan(reply) = reply else {
        panic!("expected plan reply")
    };
    assert_eq!(serde_json::to_value(reply).unwrap(), value);
    assert!(TypedRpcResponse::decode(
        RpcMethod::GoalUpdatePlan,
        &json!({"ref":{"id":"not-a-plan","revision":1}})
    )
    .is_err());
    assert!(TypedRpcParams::decode(RpcMethod::GoalUpdatePlan,&json!({"sessionId":"s","planRevision":0,"items":[{"id":"a","title":"Verify","status":"unknown"}]})).is_err());
}

#[test]
fn scoped_interaction_capabilities_are_not_rpc_directory_or_default_fallbacks() {
    futures::executor::block_on(async {
        use xharness_api::{
            ApiBackend, ScopedInteraction, ScopedInteractionAnswer, UnavailableBackend,
        };
        let host = UnavailableBackend;
        assert!(host
            .session_interaction("w", "s", &RpcId::new("request"))
            .await
            .is_err());
        let expected = ScopedInteraction {
            nonce: "fixture".into(),
            frame: xharness_api::ServerRequest::new(
                RpcId::new("request"),
                "approval/requested",
                json!({}),
            ),
        };
        assert!(host
            .answer_session_interaction(
                "w",
                "s",
                expected,
                ScopedInteractionAnswer::Approval { allowed: true }
            )
            .await
            .is_err());
        assert!(RpcMethod::ALL
            .iter()
            .all(|m| !m.as_str().contains("interaction")));
    });
}
#[test]
fn scoped_interaction_answer_is_closed_typed_and_bounded() {
    use xharness_api::ScopedInteractionAnswer as A;
    assert!(serde_json::from_value::<A>(
        json!({"type":"approval","allowed":true,"rpcId":"forged"})
    )
    .is_err());
    assert!(serde_json::from_value::<A>(json!({"type":"question","answers":[{"id":"q","selected":null,"custom":"text","sessionId":"other"}]})).is_err());
    assert!(!A::Question { answers: vec![] }.is_bounded());
    assert!(A::Approval { allowed: false }.is_bounded());
}

#[test]
fn scoped_catalogue_closed_pages_do_not_grant_ids_paths_or_unbounded_metadata() {
    use xharness_api::*;
    let query = ScopedCatalogueQuery {
        workspaces: ["w".into()].into(),
        sessions: ["s".into()].into(),
        after: None,
    };
    let page = ScopedCataloguePage {
        workspaces: vec![CatalogueWorkspace {
            id: "w".into(),
            title: "Workspace".into(),
        }],
        sessions: vec![CatalogueSession {
            workspace: "w".into(),
            id: "s".into(),
            title: None,
            running: false,
            restoring: false,
        }],
        next: None,
    };
    assert!(query.admits(&page));
    let mut malformed = page.clone();
    malformed.sessions[0].id = "other".into();
    assert!(!query.admits(&malformed));
    malformed = page.clone();
    malformed.sessions.push(page.sessions[0].clone());
    assert!(!query.admits(&malformed));
    malformed = page.clone();
    malformed.workspaces[0].id = "foreign".into();
    assert!(!query.admits(&malformed));
    malformed = page.clone();
    malformed.sessions[0].title = Some("x".repeat(4097));
    assert!(!query.admits(&malformed));
    malformed = page.clone();
    malformed.next = Some(page.sessions[0].cursor());
    assert!(!query.admits(&malformed));
    let mut wire = serde_json::to_value(&page).unwrap();
    wire["sessions"][0]["cwd"] = json!("/secret");
    assert!(serde_json::from_value::<ScopedCataloguePage>(wire).is_err());
    let mut bad_query = query.clone();
    bad_query.after = Some(CatalogueCursor {
        workspace: "w".into(),
        session: "other".into(),
    });
    assert!(!bad_query.is_bounded());
    bad_query = query.clone();
    bad_query.workspaces.insert("bad\n".into());
    assert!(!bad_query.is_bounded());
    bad_query = query;
    bad_query.sessions = (0..4097).map(|i| format!("s-{i}")).collect();
    assert!(!bad_query.is_bounded());
}

#[test]
fn scoped_catalogue_has_no_default_or_public_rpc_directory_fallback() {
    use xharness_api::{ApiBackend, ScopedCatalogueQuery, UnavailableBackend};
    futures::executor::block_on(async {
        assert!(UnavailableBackend
            .scoped_catalogue(ScopedCatalogueQuery {
                workspaces: ["w".into()].into(),
                sessions: ["s".into()].into(),
                after: None
            })
            .await
            .is_err());
    });
    assert!(RpcMethod::ALL
        .iter()
        .all(|m| !m.as_str().contains("catalogue")));
}

#[test]
fn durable_forward_event_page_is_contiguous_scoped_bounded_and_has_no_default_fallback() {
    use xharness_api::*;
    let frame = MuxFrame::SessionEvent {
        session_id: "s".into(),
        event: json!({"seq":5,"type":"assistant/chunk","data":{}}),
        view: None,
    }
    .into_server_request(RpcId::new("e"));
    let page = ScopedEventPage {
        start_seq: 5,
        next_seq: 6,
        head_seq: 9,
        events: vec![frame],
    };
    assert!(page.is_scoped("s", Some(5)));
    assert!(page.has_more());
    assert!(!page.is_scoped("foreign", Some(5)));
    assert!(!page.is_scoped("s", Some(4)));
    assert!(!page.is_scoped("s", None));
    let mut bad = page.clone();
    bad.events[0].payload["event"]["seq"] = json!(6);
    assert!(!bad.is_scoped("s", Some(5)));
    bad = page.clone();
    bad.events.clear();
    bad.next_seq = 5;
    assert!(!bad.is_scoped("s", Some(5)));
    let probe = ScopedEventPage {
        start_seq: 9,
        next_seq: 9,
        head_seq: 9,
        events: vec![],
    };
    assert!(probe.is_scoped("s", None));
    assert!(
        futures::executor::block_on(UnavailableBackend.session_event_page("w", "s", Some(0)))
            .is_err()
    );
    let mut wire = serde_json::to_value(&page).unwrap();
    wire["rawSession"] = json!({});
    assert!(serde_json::from_value::<ScopedEventPage>(wire).is_err());
}

#[test]
fn event_attachment_capability_is_fail_closed_not_a_public_rpc_and_redacts_bytes() {
    use xharness_api::*;
    assert!(
        futures::executor::block_on(UnavailableBackend.session_event_attachment(
            "w",
            "s",
            0,
            &"a".repeat(64)
        ))
        .is_err()
    );
    assert!(!RpcMethod::ALL
        .iter()
        .any(|m| m.as_str() == "session.event_attachment"));
    let media = ScopedAttachment {
        id: "a".repeat(64),
        kind: ScopedAttachmentKind::File,
        media_type: "text/plain".into(),
        width: 0,
        height: 0,
        data: b"PRIVATE_ATTACHMENT_BYTES".to_vec(),
    };
    assert!(!format!("{media:?}").contains("PRIVATE_ATTACHMENT_BYTES"));
    assert_eq!(MAX_SCOPED_ATTACHMENT_BYTES, 4 * 1024 * 1024);
}

#[test]
fn scoped_creation_identity_is_closed_deterministic_and_no_default_or_public_rpc() {
    use xharness_api::*;
    let request = ScopedSessionCreate {
        workspace: "registered".into(),
        request_key: "a".repeat(64),
    };
    assert!(request.is_bounded());
    assert_eq!(request.session_id(), format!("remote-{}", "a".repeat(64)));
    assert_eq!(request.receipt().session, request.session_id());
    for key in ["A".repeat(64), "a".repeat(63), "g".repeat(64)] {
        let bad = ScopedSessionCreate {
            request_key: key,
            ..request.clone()
        };
        assert!(!bad.is_bounded());
    }
    let mut wire = serde_json::to_value(&request).unwrap();
    wire["cwd"] = json!("/secret");
    assert!(serde_json::from_value::<ScopedSessionCreate>(wire).is_err());
    futures::executor::block_on(async {
        assert!(UnavailableBackend
            .create_scoped_session(request.clone())
            .await
            .is_err());
        assert!(UnavailableBackend
            .scoped_session_creation_receipt(request)
            .await
            .is_err());
    });
    assert!(RpcMethod::ALL
        .iter()
        .all(|m| !m.as_str().contains("scoped") && !m.as_str().contains("creation_receipt")));
}

#[test]
fn saved_automation_capabilities_are_closed_scoped_and_fail_closed_by_default() {
    use xharness_api::*;
    let read = ScopedAutomationRead {
        workspace: "w".into(),
        session: "s".into(),
        read: AutomationRead::List { after: None },
    };
    let mutation = ScopedAutomationMutation {
        workspace: "w".into(),
        session: "s".into(),
        request_key: "a".repeat(64),
        control: AutomationControl::Pause {
            id: "id with spaces".into(),
        },
    };
    assert!(read.is_bounded() && mutation.is_bounded());
    for v in [
        json!({"action":"create","prompt":"PRIVATE"}),
        json!({"action":"pause","id":"s","session":"other"}),
        json!({"action":"update","id":"s"}),
    ] {
        assert!(serde_json::from_value::<AutomationControl>(v).is_err());
    }
    let mut wire = serde_json::to_value(&mutation).unwrap();
    wire["fingerprint"] = json!("user-controlled");
    assert!(serde_json::from_value::<ScopedAutomationMutation>(wire).is_err());
    futures::executor::block_on(async {
        assert!(UnavailableBackend
            .scoped_automation_read(read)
            .await
            .is_err());
        assert!(UnavailableBackend
            .scoped_automation_control(mutation.clone())
            .await
            .is_err());
        assert!(UnavailableBackend
            .scoped_automation_receipt(mutation)
            .await
            .is_err());
    });
    assert!(!RpcMethod::ALL
        .iter()
        .any(|m| m.as_str().contains("automation")));
}
#[test]
fn saved_automation_pages_and_control_receipts_cannot_adopt_other_scope_or_generic_ok() {
    use xharness_api::*;
    let read = ScopedAutomationRead {
        workspace: "w".into(),
        session: "s".into(),
        read: AutomationRead::List {
            after: Some("a".into()),
        },
    };
    let mut page = ScopedAutomationPage {
        workspace: "w".into(),
        session: "s".into(),
        read: read.read.clone(),
        entries: vec![],
        next: None,
        detail: None,
    };
    assert!(read.admits(&page));
    page.next = Some("invented".into());
    assert!(!read.admits(&page));
    page.next = None;
    page.session = "other".into();
    assert!(!read.admits(&page));
    let request = ScopedAutomationMutation {
        workspace: "w".into(),
        session: "s".into(),
        request_key: "a".repeat(64),
        control: AutomationControl::Pause { id: "rule".into() },
    };
    let mut result = ScopedAutomationApplied {
        workspace: "w".into(),
        session: "s".into(),
        request_key: request.request_key.clone(),
        control: request.control.clone(),
        state: AutomationControlState::Paused,
    };
    assert!(request.admits(&result));
    result.state = AutomationControlState::Enabled;
    assert!(!request.admits(&result));
    assert!(serde_json::from_value::<ScopedAutomationApplied>(json!({"accepted":true})).is_err());
}

#[test]
fn image_capability_wire_is_additive_and_preserves_false_vs_unknown() {
    use xharness_api::protocol::{DiscoveredModelView, ModelCatalogEntry};
    for supported in [true, false] {
        let value = serde_json::json!({"id":"model","name":"Model","imageInput":supported,
            "imageInputCapability":{"state":if supported {"supported"} else {"unsupported"},"source":"documented"}});
        let model: ModelCatalogEntry = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(model.image_input, Some(supported));
        assert_eq!(
            serde_json::to_value(model).unwrap()["imageInput"],
            supported
        );
        let discovered: DiscoveredModelView = serde_json::from_value(value).unwrap();
        assert_eq!(discovered.image_input, Some(supported));
        assert_eq!(
            serde_json::to_value(discovered).unwrap()["imageInputCapability"]["source"],
            "documented"
        );
    }
    let legacy = serde_json::json!({"id":"model","name":"Legacy"});
    let model: ModelCatalogEntry = serde_json::from_value(legacy.clone()).unwrap();
    let discovered: DiscoveredModelView = serde_json::from_value(legacy).unwrap();
    assert!(model.image_input.is_none());
    assert!(discovered.image_input.is_none());
    assert!(serde_json::to_value(model)
        .unwrap()
        .get("imageInput")
        .is_none());
    assert!(serde_json::to_value(discovered)
        .unwrap()
        .get("imageInput")
        .is_none());
}
