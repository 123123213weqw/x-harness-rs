//! Bounded assignment reconciliation, not a new worker or coordinator execution loop.
use super::{access, service};
use crate::BasicHost;
use std::collections::{BTreeMap, BTreeSet};
use xharness_api::{RpcErrorCode, RpcId};
use xharness_control::{SwarmStatus, SwarmTaskState};

struct CandidateTask {
    id: String,
    workers: Vec<String>,
}
struct CandidateTeam {
    id: String,
    owner: String,
    tasks: Vec<CandidateTask>,
    reserved_workers: BTreeSet<String>,
}
impl BasicHost {
    /// Only human-enabled teams and explicitly routed tasks enter this path.
    /// The shared claim service rechecks policy, ownership and CAS under the team gate.
    pub(crate) async fn reconcile_swarm_dispatch(&self) -> Result<(), String> {
        let teams = {
            let state = self.state.read().await;
            state
                .swarms
                .values()
                .filter(|team| team.auto_dispatch && team.status == SwarmStatus::Active)
                .filter_map(|team| {
                    // Do not clone retained instructions/results every tick, or once per
                    // waiting task. This snapshot contains candidate identities only.
                    let tasks = team
                        .tasks
                        .values()
                        .filter(|task| {
                            task.ready(team) && !task.eligible_worker_session_ids.is_empty()
                        })
                        .map(|task| CandidateTask {
                            id: task.id.clone(),
                            workers: task.eligible_worker_session_ids.clone(),
                        })
                        .collect::<Vec<_>>();
                    (!tasks.is_empty()).then(|| CandidateTeam {
                        id: team.id.clone(),
                        owner: team.owner_session_id.clone(),
                        tasks,
                        reserved_workers: team
                            .tasks
                            .values()
                            .filter_map(|task| match &task.state {
                                SwarmTaskState::Assigned {
                                    worker_session_id, ..
                                } => Some(worker_session_id.clone()),
                                _ => None,
                            })
                            .collect(),
                    })
                })
                .collect::<Vec<_>>()
        };
        let mut last_error = None;
        for team in teams {
            if let Err(error) = self.dispatch_swarm_team(&team).await {
                last_error = Some(error);
            }
        }
        match last_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
    async fn dispatch_swarm_team(&self, team: &CandidateTeam) -> Result<(), String> {
        if !access::owner_dispatch_allowed(self, &team.owner)
            .await
            .map_err(|e| e.message)?
        {
            return Ok(());
        }
        // Bound commits and observe each worker at most once per pass. A cached
        // prefilter never authorizes a claim: the service checks again under admission.
        let mut observations = BTreeMap::new();
        let mut reserved = team.reserved_workers.clone();
        let mut claims = 0;
        for task in &team.tasks {
            if claims == 8 {
                break;
            }
            for worker in &task.workers {
                if reserved.contains(worker) {
                    continue;
                }
                let revision = {
                    let state = self.state.read().await;
                    let Some(current) = state.swarms.get(&team.id) else {
                        break;
                    };
                    if !current.auto_dispatch
                        || current.status != SwarmStatus::Active
                        || current.owner_session_id != team.owner
                    {
                        break;
                    }
                    if !current
                        .tasks
                        .get(&task.id)
                        .is_some_and(|task| task.ready(current))
                    {
                        break;
                    }
                    current.revision
                };
                let idle = match observations.get(worker) {
                    Some(idle) => *idle,
                    None => {
                        let idle = access::observe(self, worker)
                            .await
                            .map_err(|e| e.message)?
                            .idle();
                        observations.insert(worker.clone(), idle);
                        idle
                    }
                };
                if !idle {
                    continue;
                }
                let request = service::Request {
                    owner_session_id: team.owner.clone(),
                    command: service::Command::Claim {
                        swarm_id: team.id.clone(),
                        expected_revision: revision,
                        task_id: task.id.clone(),
                        worker_session_id: worker.clone(),
                    },
                };
                let payload = serde_json::to_value(&request).map_err(|e| e.to_string())?;
                let id = RpcId::new(format!("swarm-auto:{}:{}:{revision}", team.id, task.id));
                // Conflicts or changed eligibility are parked for the next observation,
                // never treated as permission to rerun an existing assignment.
                match service::execute_automatic(self, id, request, &payload).await {
                    Ok(_) => {
                        claims += 1;
                        reserved.insert(worker.clone());
                        break;
                    }
                    Err(error) if error.code == RpcErrorCode::BadRequest => {
                        observations.insert(worker.clone(), false);
                    }
                    Err(error) => return Err(error.message),
                }
            }
        }
        Ok(())
    }
}
