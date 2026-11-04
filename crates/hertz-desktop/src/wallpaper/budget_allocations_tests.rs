// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors
use super::*;

fn plan(owner: OwnerKind, session: &str, generation: u64) -> SessionPlan {
    SessionPlan::new(
        BudgetRequest {
            owner,
            session: session.into(),
            generation,
            task_id: "presentation".into(),
            targets: u32::from(owner == OwnerKind::Desktop),
            contexts: 1,
            decoders: 1,
            transcode_slots: 0,
            decode_pixel_rate: 100,
            output_pixel_rate: 200,
            cpu_bytes: 300,
            prepare_cpu_bytes: 0,
            asset_cpu_bytes: 0,
            gpu_bytes: 400,
            prepare_tasks: 0,
        },
        vec![
            ResourcePlan {
                id: "decode".into(),
                maximum: ResourceAmounts {
                    decoders: 1,
                    decode_pixel_rate: 100,
                    cpu_bytes: 300,
                    ..Default::default()
                },
            },
            ResourcePlan {
                id: "render".into(),
                maximum: ResourceAmounts {
                    contexts: 1,
                    output_pixel_rate: 200,
                    gpu_bytes: 400,
                    ..Default::default()
                },
            },
        ],
    )
    .unwrap()
}

#[test]
fn session_reserves_once_and_suballocations_do_not_double_charge_preview_or_bytes() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Preview, "preview", 7);
    let parent = budget.grant_session(&plan).unwrap();
    let before = budget.usage();
    assert_eq!(
        budget.grant_session(&plan).unwrap_err().code,
        "allocation_identity"
    );
    assert_eq!(budget.usage(), before);
    assert_eq!(
        (
            before.targets,
            before.contexts,
            before.preview_instances,
            before.decoder_slots
        ),
        (0, 1, 1, 1)
    );
    for entry in plan.resources() {
        budget
            .allocate_resource(parent, "preview", 7, &entry.id, entry.maximum)
            .unwrap();
    }
    let after = budget.usage();
    assert_eq!(
        (
            after.targets,
            after.contexts,
            after.preview_instances,
            after.decoder_slots
        ),
        (0, 1, 1, 1)
    );
    assert_eq!(
        (
            after.cpu_bytes,
            after.gpu_bytes,
            after.output_pixel_rate,
            after.decode_pixel_rate
        ),
        (300, 400, 200, 100)
    );
    assert_eq!(
        (after.session_reservations, after.resource_allocations),
        (1, 2)
    );
    let snapshot = budget.allocation_snapshot(parent, "preview", 7).unwrap();
    assert_eq!(snapshot.allocated, snapshot.reserved);
    assert!(snapshot.allocation_revision > 0);
}

#[test]
fn resource_plan_and_parent_identity_bound_every_allocation() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "desktop", 2);
    let parent = budget.grant_session(&plan).unwrap();
    let before = budget.usage();
    for (owner, generation, resource, amounts, code) in [
        (
            "wrong",
            2,
            "decode",
            ResourceAmounts::default(),
            "allocation_identity",
        ),
        (
            "desktop",
            1,
            "decode",
            ResourceAmounts::default(),
            "allocation_identity",
        ),
        (
            "desktop",
            2,
            "unplanned",
            ResourceAmounts::default(),
            "resource_not_planned",
        ),
        (
            "desktop",
            2,
            "decode",
            ResourceAmounts {
                gpu_bytes: 1,
                ..Default::default()
            },
            "budget_exceeded",
        ),
        (
            "desktop",
            2,
            "render",
            ResourceAmounts {
                gpu_bytes: 401,
                ..Default::default()
            },
            "budget_exceeded",
        ),
    ] {
        assert_eq!(
            budget
                .allocate_resource(parent, owner, generation, resource, amounts)
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(budget.usage(), before);
    }
    let child = budget
        .allocate_resource(parent, "desktop", 2, "decode", plan.resources()[0].maximum)
        .unwrap();
    let wrong_revision = Allocation {
        allocation_revision: child.allocation_revision + 1,
        ..child
    };
    assert_eq!(
        budget
            .release_resource(wrong_revision, "desktop", 2)
            .unwrap_err()
            .code,
        "allocation_identity"
    );
    assert_eq!(
        budget
            .confirm_resource_exit(child, "desktop", 1)
            .unwrap_err()
            .code,
        "allocation_identity"
    );
    assert_eq!(budget.usage().resource_release_pending, 0);
}

#[test]
fn cancelling_a_resource_keeps_capacity_until_exit_and_does_not_shrink_global_reservation() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "desktop", 1);
    let parent = budget.grant_session(&plan).unwrap();
    let amounts = plan.resources()[0].maximum;
    let first = budget
        .allocate_resource(parent, "desktop", 1, "decode", amounts)
        .unwrap();
    budget.release_resource(first, "desktop", 1).unwrap();
    budget.release_resource(first, "desktop", 1).unwrap();
    assert_eq!(budget.usage().resource_release_pending, 1);
    assert_eq!(
        budget
            .allocate_resource(parent, "desktop", 1, "decode", amounts)
            .unwrap_err()
            .code,
        "budget_exceeded"
    );
    assert!(!budget.forget_resource(first, "desktop", 1).unwrap());
    assert_eq!(
        budget.confirm_exit(parent, "desktop", 1),
        Err(LedgerError::ChildrenPending)
    );
    budget.confirm_resource_exit(first, "desktop", 1).unwrap();
    budget.confirm_resource_exit(first, "desktop", 1).unwrap();
    assert_eq!(
        budget.usage().decoder_slots,
        1,
        "only internal capacity returns"
    );
    assert!(budget.forget_resource(first, "desktop", 1).unwrap());
    assert_eq!(budget.usage().resource_records, 0);
    let second = budget
        .allocate_resource(parent, "desktop", 1, "decode", amounts)
        .unwrap();
    assert_ne!(first.token, second.token);
    assert!(budget.release_resource(first, "desktop", 1).is_err());
    assert_eq!(budget.usage().resource_release_pending, 0);
    budget.release(parent, "desktop", 1).unwrap();
    assert_eq!(
        budget.usage().resource_release_pending,
        1,
        "parent cancellation propagates without freeing"
    );
    assert_eq!(
        budget
            .allocate_resource(parent, "desktop", 1, "decode", ResourceAmounts::default())
            .unwrap_err()
            .code,
        "allocation_retiring"
    );
    budget.confirm_resource_exit(second, "desktop", 1).unwrap();
    budget.confirm_exit(parent, "desktop", 1).unwrap();
    budget.forget_released(parent, "desktop", 1).unwrap();
    assert_eq!(budget.usage(), BudgetUsage::default());
}

#[test]
fn concurrent_resources_compete_for_reserved_subcapacity_atomically() {
    let budget = Arc::new(BudgetCoordinator::new());
    let plan = plan(OwnerKind::Desktop, "desktop", 1);
    let parent = budget.grant_session(&plan).unwrap();
    let amounts = plan.resources()[0].maximum;
    let barrier = Arc::new(std::sync::Barrier::new(12));
    let threads = (0..12)
        .map(|_| {
            let budget = Arc::clone(&budget);
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                budget.allocate_resource(parent, "desktop", 1, "decode", amounts)
            })
        })
        .collect::<Vec<_>>();
    let results = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(budget.usage().resource_allocations, 1);
    assert_eq!(budget.usage().decoder_slots, 1);
}

#[test]
fn plans_cannot_overflow_duplicate_resources_or_expand_the_global_envelope() {
    let original = plan(OwnerKind::Desktop, "desktop", 1);
    let entry = original.resources()[0].clone();
    assert!(SessionPlan::new(
        original.request().clone(),
        vec![entry.clone(), entry.clone()]
    )
    .is_err());
    assert!(SessionPlan::new(
        original.request().clone(),
        vec![
            ResourcePlan {
                id: "large".into(),
                maximum: ResourceAmounts {
                    cpu_bytes: u64::MAX,
                    ..Default::default()
                }
            },
            ResourcePlan {
                id: "overflow".into(),
                maximum: ResourceAmounts {
                    cpu_bytes: 1,
                    ..Default::default()
                }
            }
        ]
    )
    .is_err());
    assert!(SessionPlan::new(
        original.request().clone(),
        vec![ResourcePlan {
            id: "large".into(),
            maximum: ResourceAmounts {
                cpu_bytes: 301,
                ..Default::default()
            }
        }]
    )
    .is_err());
    assert!(SessionPlan::new(original.request().clone(), Vec::new()).is_err());
    let mut wrong = original.request().clone();
    wrong.generation = 0;
    assert!(SessionPlan::new(wrong, vec![entry]).is_err());
}

#[test]
fn subtoken_metadata_is_bounded_and_old_tokens_cannot_release_replacements() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "desktop", 1);
    let parent = budget.grant_session(&plan).unwrap();
    let mut tokens = Vec::new();
    for _ in 0..256 {
        tokens.push(
            budget
                .allocate_resource(parent, "desktop", 1, "render", ResourceAmounts::default())
                .unwrap(),
        );
    }
    assert_eq!(
        budget
            .allocate_resource(parent, "desktop", 1, "render", ResourceAmounts::default())
            .unwrap_err()
            .code,
        "budget_busy"
    );
    budget.release_resource(tokens[0], "desktop", 1).unwrap();
    budget
        .confirm_resource_exit(tokens[0], "desktop", 1)
        .unwrap();
    assert_eq!(
        budget
            .allocate_resource(parent, "desktop", 1, "render", ResourceAmounts::default())
            .unwrap_err()
            .code,
        "budget_busy",
        "uncollected tombstones remain bounded"
    );
    budget.forget_resource(tokens[0], "desktop", 1).unwrap();
    let fresh = budget
        .allocate_resource(parent, "desktop", 1, "render", ResourceAmounts::default())
        .unwrap();
    assert_ne!(fresh.token, tokens[0].token);
    assert!(budget
        .confirm_resource_exit(tokens[0], "desktop", 1)
        .is_err());
    assert_eq!(budget.usage().resource_allocations, 256);
    assert_eq!(budget.usage().resource_records, 256);
}

#[test]
fn resource_exit_never_confirms_another_parent_or_a_later_generation() {
    let budget = BudgetCoordinator::new();
    let old = plan(OwnerKind::Desktop, "desktop", 1);
    let new = plan(OwnerKind::Desktop, "desktop", 2);
    let p1 = budget.grant_session(&old).unwrap();
    let p2 = budget.grant_session(&new).unwrap();
    let a = budget
        .allocate_resource(p1, "desktop", 1, "decode", old.resources()[0].maximum)
        .unwrap();
    let b = budget
        .allocate_resource(p2, "desktop", 2, "decode", new.resources()[0].maximum)
        .unwrap();
    let forged = Allocation {
        parent_token: p2,
        allocation_revision: b.allocation_revision,
        ..a
    };
    assert!(budget.confirm_resource_exit(forged, "desktop", 2).is_err());
    budget.release(p1, "desktop", 1).unwrap();
    budget.confirm_resource_exit(a, "desktop", 1).unwrap();
    budget.confirm_exit(p1, "desktop", 1).unwrap();
    budget.forget_released(p1, "desktop", 1).unwrap();
    assert_eq!(budget.usage().decoder_slots, 1);
    assert_eq!(budget.usage().resource_allocations, 1);
    assert_eq!(
        budget
            .allocation_snapshot(p2, "desktop", 2)
            .unwrap()
            .allocated,
        new.resources()[0].maximum
    );
}

#[test]
fn empty_flat_reservations_cannot_grow_native_metadata_without_bound() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "metadata", 1);
    let mut request = plan.request().clone();
    request.owner = OwnerKind::Probe;
    request.targets = 0;
    request.contexts = 0;
    request.decoders = 0;
    request.cpu_bytes = 0;
    request.gpu_bytes = 0;
    request.decode_pixel_rate = 0;
    request.output_pixel_rate = 0;
    let mut tokens = Vec::new();
    for _ in 0..MAX_RESERVATIONS {
        tokens.push(budget.grant(&request).unwrap());
    }
    assert_eq!(
        budget.grant(&request).unwrap_err().quota,
        "reservation_metadata"
    );
    budget.confirm_exit(tokens[0], "metadata", 1).unwrap();
    assert_eq!(
        budget.grant(&request).unwrap_err().quota,
        "reservation_metadata"
    );
    budget.forget_released(tokens[0], "metadata", 1).unwrap();
    assert!(budget.grant(&request).is_ok());
}

#[test]
fn resource_retirement_returns_its_global_envelope_and_seals_only_that_resource() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Preview, "preview", 7);
    let parent = budget.grant_session(&plan).unwrap();
    let decode = budget
        .allocate_resource(parent, "preview", 7, "decode", plan.resources()[0].maximum)
        .unwrap();
    let render = budget
        .allocate_resource(parent, "preview", 7, "render", plan.resources()[1].maximum)
        .unwrap();
    let mut successor = self::plan(OwnerKind::Desktop, "successor", 1)
        .request()
        .clone();
    successor.decoders = MAX_DECODER_SLOTS;
    assert_eq!(budget.grant(&successor).unwrap_err().quota, "decoder_slots");
    let revision = budget.ledger.lock().unwrap().revision;
    budget.release_resource(decode, "preview", 7).unwrap();
    budget.confirm_resource_exit(decode, "preview", 7).unwrap();
    budget.retire_resource_plan(decode, "preview", 7).unwrap();
    let usage = budget.usage();
    assert_eq!(
        (
            usage.decoder_slots,
            usage.decode_pixel_rate,
            usage.cpu_bytes
        ),
        (0, 0, 0)
    );
    assert_eq!(
        (
            usage.preview_instances,
            usage.contexts,
            usage.gpu_bytes,
            usage.output_pixel_rate
        ),
        (1, 1, 400, 200)
    );
    assert_eq!(
        (usage.session_reservations, usage.resource_allocations),
        (1, 1)
    );
    let snapshot = budget.allocation_snapshot(parent, "preview", 7).unwrap();
    assert_eq!(snapshot.reserved, plan.resources()[1].maximum);
    assert_eq!(snapshot.allocated, snapshot.reserved);
    assert_eq!(snapshot.allocation_revision, render.allocation_revision);
    assert!(budget.ledger.lock().unwrap().revision > revision);
    let revision = budget.ledger.lock().unwrap().revision;
    budget.retire_resource_plan(decode, "preview", 7).unwrap();
    assert_eq!(budget.usage(), usage);
    assert_eq!(budget.ledger.lock().unwrap().revision, revision);
    budget.forget_resource(decode, "preview", 7).unwrap();
    assert_eq!(
        budget
            .allocate_resource(parent, "preview", 7, "decode", ResourceAmounts::default())
            .unwrap_err()
            .code,
        "resource_plan_retired"
    );
    // The envelope is available to another session, rather than just to this parent.
    let other = budget.grant(&successor).unwrap();
    assert_eq!(budget.usage().decoder_slots, MAX_DECODER_SLOTS);
    budget.confirm_exit(other, "successor", 1).unwrap();
    budget.forget_released(other, "successor", 1).unwrap();
    // The surviving token retains its identity and still guards the parent exit.
    budget.release(parent, "preview", 7).unwrap();
    assert_eq!(
        budget.confirm_exit(parent, "preview", 7),
        Err(LedgerError::ChildrenPending)
    );
    budget.confirm_resource_exit(render, "preview", 7).unwrap();
    budget.confirm_exit(parent, "preview", 7).unwrap();
    budget.forget_released(parent, "preview", 7).unwrap();
    assert_eq!(budget.usage(), Default::default());
}

#[test]
fn resource_retirement_requires_every_child_exit_and_the_exact_parent_identity() {
    let budget = BudgetCoordinator::new();
    let plan = plan(OwnerKind::Desktop, "desktop", 2);
    let parent = budget.grant_session(&plan).unwrap();
    let amounts = ResourceAmounts {
        cpu_bytes: 100,
        ..Default::default()
    };
    let first = budget
        .allocate_resource(parent, "desktop", 2, "decode", amounts)
        .unwrap();
    let second = budget
        .allocate_resource(parent, "desktop", 2, "decode", amounts)
        .unwrap();
    for (allocation, session, generation, code) in [
        (first, "wrong", 2, "allocation_identity"),
        (first, "desktop", 1, "allocation_identity"),
        (
            Allocation {
                allocation_revision: first.allocation_revision + 1,
                ..first
            },
            "desktop",
            2,
            "allocation_identity",
        ),
        (
            Allocation {
                token: second.token + 1,
                ..first
            },
            "desktop",
            2,
            "allocation_identity",
        ),
        (first, "desktop", 2, "resource_exit_pending"),
    ] {
        let before = budget.usage();
        assert_eq!(
            budget
                .retire_resource_plan(allocation, session, generation)
                .unwrap_err()
                .code,
            code
        );
        assert_eq!(budget.usage(), before);
    }
    budget.confirm_resource_exit(first, "desktop", 2).unwrap();
    budget.release_resource(second, "desktop", 2).unwrap();
    assert_eq!(
        budget
            .retire_resource_plan(first, "desktop", 2)
            .unwrap_err()
            .code,
        "resource_exit_pending"
    );
    assert_eq!(budget.usage().cpu_bytes, 300);
    budget.confirm_resource_exit(second, "desktop", 2).unwrap();
    budget.release(parent, "desktop", 2).unwrap();
    budget.retire_resource_plan(first, "desktop", 2).unwrap();
    assert_eq!(
        budget.usage().cpu_bytes,
        0,
        "the whole planned envelope, including unused capacity, returns"
    );
    assert_eq!(budget.usage().contexts, 1);
    assert_eq!(budget.usage().targets, 1);
    budget.confirm_exit(parent, "desktop", 2).unwrap();
    assert_eq!(
        budget
            .retire_resource_plan(first, "desktop", 2)
            .unwrap_err()
            .code,
        "allocation_retiring"
    );
    budget.forget_released(parent, "desktop", 2).unwrap();
    assert_eq!(budget.usage(), Default::default());
}
