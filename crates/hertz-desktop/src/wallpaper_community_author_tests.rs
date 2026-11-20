// SPDX-License-Identifier: MIT
use super::*;

#[test]
fn confirmation_requires_the_current_window_nonce_and_five_minute_lifetime() {
    let mut ticket = Confirmation {
        owner: 7,
        nonce: "original-ticket".into(),
        created: Instant::now(),
        draft: (),
    };
    valid(&ticket, 7, "original-ticket").unwrap();
    assert_eq!(
        valid(&ticket, 8, "original-ticket").unwrap_err().code,
        "confirmation_expired"
    );
    assert_eq!(
        valid(&ticket, 7, "other-ticket").unwrap_err().code,
        "confirmation_expired"
    );
    ticket.created = Instant::now() - Duration::from_secs(301);
    assert_eq!(
        valid(&ticket, 7, "original-ticket").unwrap_err().code,
        "confirmation_expired"
    );
    assert_eq!(
        consent(&serde_json::json!({"consent":false}))
            .unwrap_err()
            .code,
        "confirmation_required"
    );
    assert_eq!(
        consent(&serde_json::json!({})).unwrap_err().code,
        "confirmation_required"
    );
}

#[test]
fn invalidation_cancels_the_owned_operation_and_old_finish_cannot_clear_another() {
    let cancel = Arc::new(AtomicBool::new(false));
    let mut state = State {
        active: Some(("original".into(), Arc::clone(&cancel))),
        ..Default::default()
    };
    state.clear();
    assert!(cancel.load(Ordering::Acquire));
    assert!(state.active.is_some());
    state.finish("another");
    assert!(state.active.is_some());
    state.finish("original");
    assert!(state.active.is_none());
}

#[test]
fn pagination_rejects_invalid_types_negative_and_excessive_offsets() {
    assert_eq!(offset(&serde_json::json!({})).unwrap(), 0);
    assert_eq!(
        offset(&serde_json::json!({"offset":1_000_000})).unwrap(),
        1_000_000
    );
    for value in [
        serde_json::json!(-1),
        serde_json::json!(1_000_001),
        serde_json::json!("4"),
        serde_json::json!(null),
    ] {
        assert_eq!(
            offset(&serde_json::json!({"offset":value}))
                .unwrap_err()
                .code,
            "invalid_page"
        );
    }
}
