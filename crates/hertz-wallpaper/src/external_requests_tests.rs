// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

use super::*;
use serde_json::json;

fn generate(brief: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({"operationId":"sdk:request-1","brief":brief,"outputKind":"builtin"}))
        .unwrap()
}

fn switch() -> serde_json::Value {
    json!({"operationId":"switch-1","workKey":"A326A8B2-B5D7-4DB6-B981-FD2B5DBB9D3E","packageHash":"A".repeat(64),"targetHandle":"B".repeat(64)})
}

#[test]
fn accepts_only_the_four_fixed_operations() {
    let catalog = parse("catalog", b"{}").unwrap();
    assert_eq!(catalog.operation(), Operation::Catalog);
    assert!(matches!(
        catalog,
        Request::Catalog(CatalogRequest {
            limit: 32,
            cursor: None
        })
    ));
    let input = parse("switch", &serde_json::to_vec(&switch()).unwrap()).unwrap();
    assert_eq!(input.operation_id(), Some("switch-1"));
    let input = parse("generate", &generate("雨夜，低运动")).unwrap();
    assert_eq!(input.operation(), Operation::Generate);
    assert!(matches!(
        parse(
            "get",
            br#"{"requestId":"a326a8b2-b5d7-4db6-b981-fd2b5dbb9d3e"}"#
        )
        .unwrap(),
        Request::Get(_)
    ));
    for name in ["wallpaper.apply", "execute", "GENERATE", ""] {
        assert!(parse(name, b"{}").is_err());
    }
}

#[test]
fn canonical_digest_normalizes_field_order_and_hex_preserves_work_key() {
    let first = parse("switch", &serde_json::to_vec(&switch()).unwrap()).unwrap();
    let second = parse("switch", format!(r#"{{"targetHandle":"{}","packageHash":"{}","workKey":"A326A8B2-B5D7-4DB6-B981-FD2B5DBB9D3E","operationId":"switch-1"}}"#, "b".repeat(64), "a".repeat(64)).as_bytes()).unwrap();
    assert_eq!(first.canonical_bytes(), second.canonical_bytes());
    assert_eq!(first.digest(), second.digest());
    assert!(crate::valid_sha256_hex(&first.digest()));
    let mut changed = switch();
    changed["workKey"] = json!("a326a8b2-b5d7-4db6-b981-fd2b5dbb9d3e");
    assert_ne!(
        first.digest(),
        parse("switch", &serde_json::to_vec(&changed).unwrap())
            .unwrap()
            .digest()
    );
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&first.canonical_bytes()).unwrap()["operation"],
        "switch"
    );
    assert_ne!(
        parse("generate", &generate("雨夜")).unwrap().digest(),
        parse("generate", &generate(" 雨夜")).unwrap().digest()
    );
}

#[test]
fn rejects_missing_unknown_duplicate_and_cross_operation_fields() {
    for raw in [
        br#"{"brief":"rain","outputKind":"builtin"}"#.as_slice(),
        br#"{"operationId":"x","brief":"rain","outputKind":"builtin","approved":true}"#,
        br#"{"operationId":"x","brief":"rain","outputKind":"builtin","targetHandle":"x"}"#,
        br#"{"operationId":"x","operation\u0049d":"y","brief":"rain","outputKind":"builtin"}"#,
    ] {
        assert!(
            parse("generate", raw).is_err(),
            "accepted {}",
            String::from_utf8_lossy(raw)
        );
    }
    assert_eq!(
        parse("catalog", br#"{"extra":{"a":1,"a":2}}"#)
            .unwrap_err()
            .code,
        "duplicate_key"
    );
    assert!(parse("catalog", br#"{"operation":"catalog"}"#).is_err());
}

#[test]
fn enforces_framing_size_depth_and_typed_scalar_limits() {
    assert!(parse("generate", &generate(&"a".repeat(4096))).is_ok());
    assert!(parse("generate", &generate(&"a".repeat(4097))).is_err());
    for brief in ["", " \t\r\n", "\u{0000}"] {
        assert!(parse("generate", &generate(brief)).is_err());
    }
    for id in ["", "bad id", "../x", "秘密", "x\n"] {
        assert!(parse(
            "generate",
            &serde_json::to_vec(&json!({"operationId":id,"brief":"rain","outputKind":"builtin"}))
                .unwrap()
        )
        .is_err());
    }
    assert!(parse(
        "generate",
        &serde_json::to_vec(
            &json!({"operationId":"x".repeat(128),"brief":"rain","outputKind":"image"})
        )
        .unwrap()
    )
    .is_ok());
    assert!(parse(
        "generate",
        &serde_json::to_vec(
            &json!({"operationId":"x".repeat(129),"brief":"rain","outputKind":"image"})
        )
        .unwrap()
    )
    .is_err());
    for raw in [
        br#"{"limit":0}"#.as_slice(),
        br#"{"limit":33}"#,
        br#"{"cursor":20001}"#,
        br#"{"cursor":-1}"#,
        br#"{"limit":"32"}"#,
    ] {
        assert!(parse("catalog", raw).is_err());
    }
    assert!(parse("catalog", br#"{"limit":1,"cursor":20000}"#).is_ok());
    let deep = format!("{{\"extra\":{}{}}}", "[".repeat(17), "]".repeat(17));
    assert_eq!(
        parse("catalog", deep.as_bytes()).unwrap_err().code,
        "manifest_depth"
    );
    assert!(parse("catalog", &vec![b' '; 12289]).is_err());
    assert!(parse("catalog", b"{}{}").is_err());
    assert!(parse("catalog", &[b'{', b'"', 0xff, b'"', b':', b'0', b'}']).is_err());
}

#[test]
fn rejects_untrusted_switch_identities_and_invalid_receipt_id() {
    for (field, value) in [
        ("workKey", "../rain"),
        ("packageHash", "bad"),
        ("targetHandle", "DISPLAY1"),
    ] {
        let mut input = switch();
        input[field] = json!(value);
        assert!(parse("switch", &serde_json::to_vec(&input).unwrap()).is_err());
    }
    assert!(parse("get", br#"{"requestId":"../receipt"}"#).is_err());
}

#[test]
fn receipt_has_only_safe_result_fields() {
    let receipt = Receipt {
        request_id: "a326a8b2-b5d7-4db6-b981-fd2b5dbb9d3e".into(),
        operation_id: "sdk-1".into(),
        state: RequestState::PendingConfirmation,
        output_kind: Some(WallpaperGenerationKind::Builtin),
        job_id: None,
        native_operation_id: None,
        created_at: 100,
        expires_at: 220,
        error_code: None,
    };
    let value = serde_json::to_value(receipt).unwrap();
    assert_eq!(value["state"], "pending_confirmation");
    let keys: Vec<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        vec![
            "createdAt",
            "expiresAt",
            "operationId",
            "outputKind",
            "requestId",
            "state"
        ]
    );
}

#[test]
fn accepts_native_namespaced_work_keys_without_rewriting_identity() {
    // Native ImportJobs and WorkDrafts publish local-{manifest.workId}; the
    // existing AI catalog contract accepts bounded ASCII namespace IDs.
    for work_key in [
        "local-a326a8b2-b5d7-4db6-b981-fd2b5dbb9d3e",
        "unsigned-import-a326a8b2-b5d7-4db6-b981-fd2b5dbb9d3e",
        "publisher_Name-A326A8B2-B5D7-4DB6-B981-FD2B5DBB9D3E",
    ] {
        let mut input = switch();
        input["workKey"] = json!(work_key);
        let parsed = parse("switch", &serde_json::to_vec(&input).unwrap()).unwrap();
        assert!(matches!(parsed, Request::Switch(input) if input.work_key == work_key));
    }
    for work_key in ["", "../x", "C:\\wallpaper", "a/b", "秘密", "bad key"] {
        let mut input = switch();
        input["workKey"] = json!(work_key);
        assert!(parse("switch", &serde_json::to_vec(&input).unwrap()).is_err());
    }
    let mut input = switch();
    input["workKey"] = json!("k".repeat(128));
    assert!(parse("switch", &serde_json::to_vec(&input).unwrap()).is_ok());
    input["workKey"] = json!("k".repeat(129));
    assert!(parse("switch", &serde_json::to_vec(&input).unwrap()).is_err());
}
