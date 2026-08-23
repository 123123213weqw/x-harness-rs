use std::{
    collections::{HashMap, HashSet},
    fmt,
    pin::Pin,
};

use futures::{stream::FuturesUnordered, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::{ToolConcurrency, ToolExecutor, ToolRequest, ToolResult};

/// One model-ordered request in a tool batch.
#[derive(Clone, Debug)]
pub struct ToolBatchRequest {
    pub order: usize,
    pub request: ToolRequest,
}

impl ToolBatchRequest {
    pub fn new(order: usize, request: ToolRequest) -> Self {
        Self { order, request }
    }
}

/// A completed batch item. Events are emitted in wall-clock completion order;
/// the final batch result is sorted by `order` for provider replay.
#[derive(Clone, Debug)]
pub struct ToolBatchResult {
    pub order: usize,
    pub result: ToolResult,
}

#[derive(Clone, Debug)]
pub enum ToolBatchEvent {
    Completed(ToolBatchResult),
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum ToolBatchError {
    #[error("tool batch max concurrency must be greater than zero")]
    ZeroConcurrency,
    #[error("tool batch contains duplicate order {0}")]
    DuplicateOrder(usize),
    #[error("tool batch supervisor stopped before publishing its result")]
    SupervisorStopped,
}

/// Owned, structured batch activation. Dropping or explicitly cancelling the
/// handle signals every request token; `result()` still waits for executor
/// cleanup and never reports an early successful settlement.
pub struct ToolBatchRun {
    events: mpsc::UnboundedReceiver<ToolBatchEvent>,
    result: Option<oneshot::Receiver<Vec<ToolBatchResult>>>,
    cancellations: Vec<CancellationToken>,
}

impl ToolBatchRun {
    pub async fn next_event(&mut self) -> Option<ToolBatchEvent> {
        self.events.recv().await
    }

    pub fn cancel(&self) {
        for cancellation in &self.cancellations {
            cancellation.cancel();
        }
    }

    pub async fn result(&mut self) -> Result<Vec<ToolBatchResult>, ToolBatchError> {
        let Some(result) = self.result.take() else {
            return Err(ToolBatchError::SupervisorStopped);
        };
        result.await.map_err(|_| ToolBatchError::SupervisorStopped)
    }
}

impl Drop for ToolBatchRun {
    fn drop(&mut self) {
        self.cancel();
    }
}

impl ToolExecutor {
    /// Start one model-ordered batch under the executor's registry, policy,
    /// approval, middleware and lifecycle pipeline.
    ///
    /// Scheduling lives here rather than in an Agent loop: `Parallel`,
    /// resource-keyed FIFO and `Exclusive` barriers share one authoritative
    /// implementation. `max_concurrency` is scoped to this batch.
    pub async fn start_batch(
        &self,
        requests: Vec<ToolBatchRequest>,
        max_concurrency: usize,
    ) -> Result<ToolBatchRun, ToolBatchError> {
        if max_concurrency == 0 {
            return Err(ToolBatchError::ZeroConcurrency);
        }
        let mut orders = HashSet::with_capacity(requests.len());
        for request in &requests {
            if !orders.insert(request.order) {
                return Err(ToolBatchError::DuplicateOrder(request.order));
            }
        }

        let cancellations = requests
            .iter()
            .map(|request| request.request.cancellation.clone())
            .collect::<Vec<_>>();
        let mut scheduled = Vec::with_capacity(requests.len());
        for (position, request) in requests.into_iter().enumerate() {
            let (mode, key) = self.schedule_class(&request.request).await;
            scheduled.push(ScheduledBatchRequest {
                position,
                order: request.order,
                request: Some(request.request),
                mode,
                key,
                started: false,
            });
        }

        let (event_tx, events) = mpsc::unbounded_channel();
        let (result_tx, result) = oneshot::channel();
        let executor = self.clone();
        tokio::spawn(async move {
            let results = run_batch(executor, &mut scheduled, max_concurrency, event_tx).await;
            let _ = result_tx.send(results);
        });
        Ok(ToolBatchRun {
            events,
            result: Some(result),
            cancellations,
        })
    }

    async fn schedule_class(&self, request: &ToolRequest) -> (ToolConcurrency, String) {
        let Some(spec) = self.registry().get(&request.name).await else {
            return (ToolConcurrency::Exclusive, String::new());
        };
        if spec.concurrency != ToolConcurrency::Keyed {
            return (spec.concurrency, String::new());
        }
        let Ok(arguments) = serde_json::from_str::<Value>(&request.arguments_json) else {
            return (ToolConcurrency::Exclusive, String::new());
        };
        let Some(resolver) = &spec.resource_key_resolver else {
            return (ToolConcurrency::Exclusive, String::new());
        };
        let key = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| resolver(&arguments)))
            .ok()
            .flatten()
            .filter(|key| !key.is_empty());
        match key {
            Some(key) => (ToolConcurrency::Keyed, key),
            None => (ToolConcurrency::Exclusive, String::new()),
        }
    }
}

struct ScheduledBatchRequest {
    position: usize,
    order: usize,
    request: Option<ToolRequest>,
    mode: ToolConcurrency,
    key: String,
    started: bool,
}

impl fmt::Debug for ScheduledBatchRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ScheduledBatchRequest")
            .field("position", &self.position)
            .field("order", &self.order)
            .field("mode", &self.mode)
            .field("key", &self.key)
            .field("started", &self.started)
            .finish_non_exhaustive()
    }
}

type BatchFuture = Pin<Box<dyn futures::Future<Output = (usize, ToolBatchResult)> + Send>>;

async fn run_batch(
    executor: ToolExecutor,
    scheduled: &mut [ScheduledBatchRequest],
    max_concurrency: usize,
    event_tx: mpsc::UnboundedSender<ToolBatchEvent>,
) -> Vec<ToolBatchResult> {
    let mut active = FuturesUnordered::<BatchFuture>::new();
    let mut active_modes = HashMap::<usize, (ToolConcurrency, String)>::new();
    let mut results = std::iter::repeat_with(|| None)
        .take(scheduled.len())
        .collect::<Vec<Option<ToolBatchResult>>>();
    let mut completed = 0usize;

    while completed < scheduled.len() {
        let mut launched_any = true;
        while launched_any && active.len() < max_concurrency {
            launched_any = false;
            let barrier = scheduled
                .iter()
                .position(|item| !item.started && item.mode == ToolConcurrency::Exclusive)
                .unwrap_or(scheduled.len());

            for item in scheduled.iter_mut().take(barrier) {
                if active.len() >= max_concurrency {
                    break;
                }
                if item.started || !can_launch(item, active_modes.values()) {
                    continue;
                }
                launch(&executor, item, &mut active, &mut active_modes);
                launched_any = true;
            }

            if !launched_any && barrier < scheduled.len() && active.is_empty() {
                launch(
                    &executor,
                    &mut scheduled[barrier],
                    &mut active,
                    &mut active_modes,
                );
                launched_any = true;
            }
        }

        let Some((position, result)) = active.next().await else {
            break;
        };
        active_modes.remove(&position);
        completed += 1;
        let _ = event_tx.send(ToolBatchEvent::Completed(result.clone()));
        results[position] = Some(result);
    }

    drop(event_tx);
    let mut results = results.into_iter().flatten().collect::<Vec<_>>();
    results.sort_by_key(|result| result.order);
    results
}

fn launch(
    executor: &ToolExecutor,
    item: &mut ScheduledBatchRequest,
    active: &mut FuturesUnordered<BatchFuture>,
    active_modes: &mut HashMap<usize, (ToolConcurrency, String)>,
) {
    item.started = true;
    active_modes.insert(item.position, (item.mode, item.key.clone()));
    let executor = executor.clone();
    let position = item.position;
    let order = item.order;
    let request = item
        .request
        .take()
        .expect("a batch request is launched exactly once");
    active.push(Box::pin(async move {
        let result = executor.execute(request).await;
        (position, ToolBatchResult { order, result })
    }));
}

fn can_launch<'a>(
    item: &ScheduledBatchRequest,
    active: impl Iterator<Item = &'a (ToolConcurrency, String)>,
) -> bool {
    let active = active.collect::<Vec<_>>();
    if active
        .iter()
        .any(|(mode, _)| *mode == ToolConcurrency::Exclusive)
    {
        return false;
    }
    match item.mode {
        ToolConcurrency::Exclusive => active.is_empty(),
        ToolConcurrency::Keyed => !active
            .iter()
            .any(|(mode, key)| *mode == ToolConcurrency::Keyed && *key == item.key),
        ToolConcurrency::Parallel => true,
    }
}
