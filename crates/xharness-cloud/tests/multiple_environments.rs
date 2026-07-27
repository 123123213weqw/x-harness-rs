//! Deterministic domain tests, independent from the opt-in real KVM lab.
//! They do NOT claim to implement running-task migration or distributed fencing.
mod common;
use common::*;
use xharness_cloud::{
    testing::{FakeEnvironment, FakeFault},
    *,
};

fn four() -> (MemoryCloudTaskStore, Vec<CommandEnvelope>, Vec<TaskRecord>) {
    let store = MemoryCloudTaskStore::default();
    let mut commands = Vec::new();
    let mut records = Vec::new();
    for index in 1..=4 {
        let mut env = environment("owner1");
        env.environment_ref = reference(&format!("env-{index}"));
        env.instance_id = id(&format!("vm-{index}"));
        env.volume_id = id(&format!("volume-{index}"));
        store.register_environment(env.clone()).unwrap();
        let mut command = envelope();
        command.request_id = id(&format!("request-{index}"));
        let Command::Submit(ref mut submit) = command.command else {
            unreachable!();
        };
        submit.spec.environment_ref = env.environment_ref;
        let receipt = store.admit(&id("owner1"), &command, Counter(100)).unwrap();
        records.push(store.get(&id("owner1"), &receipt.task_id).unwrap());
        commands.push(command);
    }
    (store, commands, records)
}

#[test]
fn four_environment_admissions_and_replays_preserve_distinct_bindings() {
    let (store, commands, records) = four();
    let mut sessions = std::collections::BTreeSet::new();
    let mut bindings = std::collections::BTreeSet::new();
    for (command, task) in commands.iter().zip(&records) {
        assert!(sessions.insert(task.binding.root_session_id.clone()));
        assert!(bindings.insert(task.binding.scope.binding_id.clone()));
        for _ in 0..8 {
            let replay = store.admit(&id("owner1"), command, Counter(200)).unwrap();
            assert_eq!(replay.task_id, task.task_id);
            assert_eq!(store.get(&id("owner1"), &task.task_id).unwrap(), *task);
        }
        assert_eq!(
            store
                .stage_intents(&id("owner1"), &task.task_id)
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn switching_connection_cannot_apply_another_environment_fact_or_epoch() {
    let (store, _, tasks) = four();
    for target in &tasks {
        for source in &tasks {
            if target.task_id == source.task_id {
                continue;
            }
            code(
                store.apply_fact(
                    &id("owner1"),
                    &target.task_id,
                    target.revision,
                    &source.binding.scope,
                    &TaskFact::PrepareAdmitted {
                        operation_id: target.prepare_operation_id.clone(),
                    },
                    Counter(200),
                ),
                ErrorCode::OwnershipUnverified,
            );
        }
        let mut stale = target.binding.scope.clone();
        stale.execution_epoch = Counter(2);
        code(
            store.apply_fact(
                &id("owner1"),
                &target.task_id,
                target.revision,
                &stale,
                &TaskFact::PrepareAdmitted {
                    operation_id: target.prepare_operation_id.clone(),
                },
                Counter(200),
            ),
            ErrorCode::OwnershipUnverified,
        );
        assert_eq!(store.get(&id("owner1"), &target.task_id).unwrap(), *target);
    }
}

#[tokio::test]
async fn unknown_prepare_on_one_environment_does_not_change_other_three() {
    let (store, _, tasks) = four();
    let backend = FakeEnvironment::default();
    for task in &tasks {
        backend.bind(task.binding.scope.clone()).unwrap();
    }
    let operations: Vec<_> = tasks
        .iter()
        .map(|task| EnvironmentOperation {
            operation_id: task.prepare_operation_id.clone(),
            scope: task.binding.scope.clone(),
            kind: EnvironmentOperationKind::Prepare,
        })
        .collect();
    backend
        .inject_fault(
            operations[0].operation_id.clone(),
            FakeFault::UnknownBeforeApply,
        )
        .unwrap();
    code(
        backend.execute(operations[0].clone()).await,
        ErrorCode::OutcomeUnknown,
    );
    assert!(backend.inspect(&operations[0]).await.unwrap().is_none());
    for operation in &operations[1..] {
        assert!(matches!(
            backend.execute(operation.clone()).await.unwrap(),
            EnvironmentOperationResult::Applied { .. }
        ));
        assert_eq!(backend.effect_count(&operation.operation_id).unwrap(), 1);
    }
    // Connection loss / unknown result is NOT permission to bind a new VM
    // to the old task's retained volume.
    let mut replacement = tasks[0].binding.scope.clone();
    replacement.environment_instance_id = id("replacement-vm");
    replacement.execution_epoch = Counter(2);
    code(backend.bind(replacement), ErrorCode::EnvironmentBusy);
    for task in &tasks {
        assert_eq!(store.get(&id("owner1"), &task.task_id).unwrap(), *task);
    }
}

#[test]
fn cancelling_one_environment_does_not_cancel_or_rebind_the_others() {
    let (store, _, tasks) = four();
    let cancelled = fact(
        &store,
        &tasks[0],
        TaskFact::CancelRequested {
            operation_id: id("cancel-one"),
        },
    );
    assert_eq!(cancelled.phase, TaskPhase::Settling);
    for task in &tasks[1..] {
        let prepared = fact(
            &store,
            task,
            TaskFact::PrepareAdmitted {
                operation_id: task.prepare_operation_id.clone(),
            },
        );
        assert_eq!(prepared.phase, TaskPhase::Provisioning);
        assert_eq!(prepared.binding, task.binding);
    }
}
