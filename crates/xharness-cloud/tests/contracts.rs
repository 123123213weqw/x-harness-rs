mod common;
use common::*;
use serde_json::{json, Value};
use xharness_cloud::*;

fn decode(value: Value) -> CloudResult<CommandEnvelope> {
    CommandEnvelope::decode(
        &serde_json::to_vec(&value).unwrap(),
        &AdmissionLimits::default(),
    )
}
fn wire() -> Value {
    serde_json::from_slice(include_bytes!("fixtures/submit-v1.json")).unwrap()
}

#[test]
fn identifier_rejects_paths_unicode_and_excess_length() {
    for text in [
        "",
        ".hidden",
        "../task",
        "a/b",
        "a\\b",
        "a:b",
        "任务",
        "a\n",
        "a．b",
        &"a".repeat(129),
    ] {
        code(Id::new(text), ErrorCode::InvalidRequest);
    }
    for text in ["a", "A-9_x.y", &"z".repeat(128)] {
        assert_eq!(id(text).as_str(), text);
    }
}
#[test]
fn counters_are_lossless_canonical_strings() {
    for number in [0, 1, 9_007_199_254_740_993, u64::MAX] {
        let encoded = serde_json::to_string(&Counter(number)).unwrap();
        assert_eq!(encoded, format!("\"{number}\""));
        assert_eq!(
            serde_json::from_str::<Counter>(&encoded).unwrap(),
            Counter(number)
        );
    }
    for text in [
        "1",
        "-1",
        "null",
        "\"\"",
        "\"01\"",
        "\"+1\"",
        "\"1.0\"",
        "\" 1\"",
        "\"18446744073709551616\"",
    ] {
        assert!(serde_json::from_str::<Counter>(text).is_err(), "{text}");
    }
    code(Counter(u64::MAX).next(), ErrorCode::InvalidRequest);
}
#[test]
fn fingerprint_matches_independent_golden_fixture() {
    let fingerprint = envelope().command.fingerprint().unwrap();
    assert_eq!(fingerprint.version, FINGERPRINT_VERSION);
    assert_eq!(
        fingerprint.sha256.as_str(),
        include_str!("fixtures/submit-v1.sha256").trim()
    );
    assert_eq!(
        decode(serde_json::to_value(envelope()).unwrap()).unwrap(),
        envelope()
    );
}
#[test]
fn fingerprint_defaults_and_null_are_normalized() {
    let mut value = wire();
    let spec = value["payload"]["spec"].as_object_mut().unwrap();
    for key in [
        "system_privilege",
        "selected_material_refs",
        "usage_policy_ref",
        "notification_policy_ref",
    ] {
        spec.remove(key);
    }
    spec["workspace_source"]
        .as_object_mut()
        .unwrap()
        .remove("patch_bundle_ref");
    assert_eq!(
        decode(value).unwrap().command.fingerprint().unwrap(),
        envelope().command.fingerprint().unwrap()
    );
}
#[test]
fn fingerprint_preserves_content_and_list_order_but_not_request_identity() {
    let baseline = envelope().command.fingerprint().unwrap();
    let mut value = wire();
    value["request_id"] = json!("another-request");
    assert_eq!(
        decode(value).unwrap().command.fingerprint().unwrap(),
        baseline
    );
    for change in ["order", "objective", "version"] {
        let mut value = wire();
        match change {
            "order" => value["payload"]["spec"]["acceptance_criteria"]
                .as_array_mut()
                .unwrap()
                .reverse(),
            "objective" => value["payload"]["spec"]["objective"] = json!("只查看，不修改"),
            _ => value["payload"]["spec"]["credential_ref"]["version"] = json!("v99"),
        }
        assert_ne!(
            decode(value).unwrap().command.fingerprint().unwrap(),
            baseline
        );
    }
}
#[test]
fn unknown_secret_owner_and_permission_fields_are_rejected_without_echo() {
    for key in [
        "api_key",
        "owner_id",
        "address",
        "max_goal_rounds",
        "permission_mode",
    ] {
        let mut value = wire();
        value["payload"]["spec"][key] = json!("secret-do-not-echo");
        let error = decode(value).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
        assert!(!error.to_string().contains("secret-do-not-echo"));
    }
    let mut value = wire();
    value["owner_id"] = json!("owner1");
    code(decode(value), ErrorCode::InvalidRequest);
    let mut value = wire();
    value["payload"]["spec"]["permission"] = json!("sandbox");
    code(decode(value), ErrorCode::InvalidRequest);
}
#[test]
fn duplicate_json_fields_are_not_silently_overwritten() {
    let original = include_str!("fixtures/submit-v1.json");
    for (from, to) in [
        (
            "\"request_id\":",
            "\"request_id\": \"first\", \"request_id\":",
        ),
        ("\"objective\":", "\"objective\": \"first\", \"objective\":"),
        ("\"commit\":", "\"commit\": \"first\", \"commit\":"),
    ] {
        code(
            CommandEnvelope::decode(
                original.replace(from, to).as_bytes(),
                &AdmissionLimits::default(),
            ),
            ErrorCode::InvalidRequest,
        );
    }
}
#[test]
fn invalid_and_future_protocols_never_decode_as_current_commands() {
    let mut value = wire();
    value["protocol"] = json!("xharness-cloud/v2");
    code(decode(value), ErrorCode::VersionUnsupported);
    let mut value = wire();
    value["method"] = json!("environment.stop");
    code(decode(value), ErrorCode::InvalidRequest);
    for bytes in [b"{}".as_slice(), b"null", b"{", b"[]"] {
        code(
            CommandEnvelope::decode(bytes, &AdmissionLimits::default()),
            ErrorCode::InvalidRequest,
        );
    }
}
#[test]
fn workspace_union_requires_fixed_validated_sources() {
    for source in [
        json!({"kind":"git_revision", "repository_ref":reference("repo"), "commit":"master"}),
        json!({"kind":"git_revision", "repository_ref":reference("repo"), "commit":"A".repeat(40)}),
        json!({"kind":"existing_workspace", "workspace_ref":reference("workspace"), "expected_fingerprint":"f".repeat(64), "path":"/tmp/work"}),
        json!({"kind":"uploaded_bundle", "object_ref":reference("object"), "manifest_sha256":"x".repeat(64), "unpack_policy_ref":reference("policy")}),
        json!({"kind":"existing_workspace", "workspace_ref":reference("workspace"), "expected_fingerprint":"f".repeat(64), "repository_ref":reference("repo")}),
    ] {
        let mut value = wire();
        value["payload"]["spec"]["workspace_source"] = source;
        code(decode(value), ErrorCode::InvalidRequest);
    }
    for source in [
        json!({"kind":"existing_workspace", "workspace_ref":reference("workspace"), "expected_fingerprint":"f".repeat(64)}),
        json!({"kind":"uploaded_bundle", "object_ref":reference("object"), "manifest_sha256":"a".repeat(64), "unpack_policy_ref":reference("policy")}),
    ] {
        let mut value = wire();
        value["payload"]["spec"]["workspace_source"] = source;
        assert!(decode(value).is_ok());
    }
}
#[test]
fn admission_limits_reject_without_truncating_user_text() {
    let mut request = envelope();
    if let Command::Submit(ref mut submit) = request.command {
        submit.spec.objective = " \n\t".into();
    }
    code(
        request.validate(&AdmissionLimits::default()),
        ErrorCode::InvalidRequest,
    );
    let request = envelope();
    let limits = AdmissionLimits {
        objective_bytes: 1,
        ..AdmissionLimits::default()
    };
    code(request.validate(&limits), ErrorCode::InvalidRequest);
    let limits = AdmissionLimits {
        request_bytes: 1,
        ..AdmissionLimits::default()
    };
    code(request.validate(&limits), ErrorCode::InvalidRequest);
    code(
        CommandEnvelope::decode(b"{}", &limits),
        ErrorCode::InvalidRequest,
    );
    let limits = AdmissionLimits {
        criteria_count: 1,
        ..AdmissionLimits::default()
    };
    code(request.validate(&limits), ErrorCode::InvalidRequest);
    let mut spec = spec();
    spec.acceptance_criteria = vec!["".into()];
    code(
        spec.validate(&AdmissionLimits::default()),
        ErrorCode::InvalidRequest,
    );
}
#[test]
fn cancel_wire_requires_cas_decimal_revision() {
    for payload in [
        json!({"task_id":"task_1"}),
        json!({"task_id":"task_1","expected_revision":7}),
        json!({"task_id":"task_1","expected_revision":"7","owner_id":"owner1"}),
    ] {
        code(
            decode(
                json!({"protocol":PROTOCOL,"request_id":"cancel1","method":"task.cancel","payload":payload}),
            ),
            ErrorCode::InvalidRequest,
        );
    }
    assert!(decode(json!({"protocol":PROTOCOL,"request_id":"cancel1","method":"task.cancel","payload":{"task_id":"task_1","expected_revision":"7"}})).is_ok());
}
