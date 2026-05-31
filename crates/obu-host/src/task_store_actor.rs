//! Single-writer actor wrapping the synchronous [`TaskStore`].
//!
//! The [`TaskStore`] holds a [`rusqlite::Connection`], which is not friendly to
//! hold across `await` points on an async runtime. This module isolates the
//! blocking SQLite work in a dedicated OS thread that owns the store for its
//! lifetime and processes commands one at a time over an mpsc channel. Callers
//! interact through the cloneable async [`TaskStoreHandle`], which sends a
//! command plus a oneshot reply channel and awaits the result.
//!
//! Running every store mutation through this one thread enforces the
//! single-writer invariant the store assumes (gap-free event cursors, etc.) and
//! keeps the blocking `rusqlite` calls off the async runtime's worker threads.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::task_lifecycle::{
    SessionTurnEvidence, TaskState, allowed_transitions, task_state_allowed,
};
use crate::task_store::{
    EpisodeExport, NewTask, ResumeAttemptBegin, Segment, TASK_STORE_SCHEMA_VERSION, TaskListFilter,
    TaskStore, TaskSummary, now_millis, plan_task_resume,
};

/// Bounded capacity of the actor command channel (audit §4.9).
///
/// Comfortably absorbs interactive bursts while capping the queue + cloned
/// payloads a tight command loop can pile up before the single SQLite writer
/// drains them. Best-effort observability writes shed (and count) past this;
/// must-send writes (resume/export/list) apply back-pressure instead.
const ACTOR_CHANNEL_CAPACITY: usize = 1024;

const DEFAULT_TASK_STORE_RETENTION_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_TASK_STORE_EVENT_CAP: i64 = 10_000;
const DEFAULT_TASK_STORE_SEGMENT_CAP: i64 = 1_000;
const DEFAULT_TASK_STORE_MAINTENANCE_INTERVAL_MS: i64 = 60_000;
const DEFAULT_TASK_STORE_MAINTENANCE_TASKS_PER_PASS: usize = 64;

const ENV_TASK_STORE_RETENTION_WINDOW_MS: &str = "OBU_TASK_STORE_RETENTION_WINDOW_MS";
const ENV_TASK_STORE_EVENT_CAP: &str = "OBU_TASK_STORE_EVENT_CAP";
const ENV_TASK_STORE_SEGMENT_CAP: &str = "OBU_TASK_STORE_SEGMENT_CAP";
const ENV_TASK_STORE_MAINTENANCE_INTERVAL_MS: &str = "OBU_TASK_STORE_MAINTENANCE_INTERVAL_MS";
const ENV_TASK_STORE_MAINTENANCE_TASKS_PER_PASS: &str = "OBU_TASK_STORE_MAINTENANCE_TASKS_PER_PASS";

/// Runtime maintenance bounds for the durable task store (audit §2.2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TaskStoreMaintenanceConfig {
    retention_window_ms: i64,
    max_events_per_task: i64,
    max_segments_per_task: i64,
    maintenance_interval_ms: i64,
    maintenance_tasks_per_pass: usize,
}

impl Default for TaskStoreMaintenanceConfig {
    fn default() -> Self {
        Self {
            retention_window_ms: DEFAULT_TASK_STORE_RETENTION_WINDOW_MS,
            max_events_per_task: DEFAULT_TASK_STORE_EVENT_CAP,
            max_segments_per_task: DEFAULT_TASK_STORE_SEGMENT_CAP,
            maintenance_interval_ms: DEFAULT_TASK_STORE_MAINTENANCE_INTERVAL_MS,
            maintenance_tasks_per_pass: DEFAULT_TASK_STORE_MAINTENANCE_TASKS_PER_PASS,
        }
    }
}

impl TaskStoreMaintenanceConfig {
    fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> Self {
        let default = Self::default();
        Self {
            retention_window_ms: env_i64_at_least(
                &mut lookup,
                ENV_TASK_STORE_RETENTION_WINDOW_MS,
                default.retention_window_ms,
                0,
            ),
            max_events_per_task: env_i64_at_least(
                &mut lookup,
                ENV_TASK_STORE_EVENT_CAP,
                default.max_events_per_task,
                0,
            ),
            max_segments_per_task: env_i64_at_least(
                &mut lookup,
                ENV_TASK_STORE_SEGMENT_CAP,
                default.max_segments_per_task,
                0,
            ),
            maintenance_interval_ms: env_i64_at_least(
                &mut lookup,
                ENV_TASK_STORE_MAINTENANCE_INTERVAL_MS,
                default.maintenance_interval_ms,
                1,
            ),
            maintenance_tasks_per_pass: env_usize_at_least(
                &mut lookup,
                ENV_TASK_STORE_MAINTENANCE_TASKS_PER_PASS,
                default.maintenance_tasks_per_pass,
                1,
            ),
        }
    }
}

#[derive(Default)]
struct TaskStoreMaintenanceCursor {
    after_task_id: Option<String>,
}

#[derive(Default)]
struct TaskStoreMaintenanceStats {
    pruned_tasks: usize,
    capped_events: usize,
    capped_segments: usize,
}

impl TaskStoreMaintenanceStats {
    fn changed(&self) -> bool {
        self.pruned_tasks > 0 || self.capped_events > 0 || self.capped_segments > 0
    }
}

fn env_i64_at_least(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    name: &str,
    default: i64,
    min: i64,
) -> i64 {
    lookup(name)
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= min)
        .unwrap_or(default)
}

fn env_usize_at_least(
    lookup: &mut impl FnMut(&str) -> Option<String>,
    name: &str,
    default: usize,
    min: usize,
) -> usize {
    lookup(name)
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value >= min)
        .unwrap_or(default)
}

fn run_task_store_maintenance(
    store: &TaskStore,
    config: TaskStoreMaintenanceConfig,
    cursor: &mut TaskStoreMaintenanceCursor,
) -> Result<TaskStoreMaintenanceStats> {
    let task_limit = config.maintenance_tasks_per_pass.max(1);
    let mut stats = TaskStoreMaintenanceStats {
        pruned_tasks: store.prune_terminal_tasks_limited(config.retention_window_ms, task_limit)?,
        ..TaskStoreMaintenanceStats::default()
    };
    let mut task_ids = store.task_ids_after(
        cursor.after_task_id.as_deref(),
        task_limit.saturating_add(1),
    )?;
    let reached_end = task_ids.len() <= task_limit;
    if !reached_end {
        task_ids.truncate(task_limit);
    }
    let next_after = task_ids.last().cloned();
    for task_id in task_ids {
        stats.capped_events += store.cap_task_events(&task_id, config.max_events_per_task)?;
        stats.capped_segments += store.cap_task_segments(&task_id, config.max_segments_per_task)?;
    }
    cursor.after_task_id = if reached_end { None } else { next_after };
    store.incremental_vacuum()?;
    Ok(stats)
}

fn maybe_run_task_store_maintenance(
    store: &TaskStore,
    config: TaskStoreMaintenanceConfig,
    cursor: &mut TaskStoreMaintenanceCursor,
    next_maintenance_at_ms: &mut i64,
) {
    let now = now_millis();
    if now < *next_maintenance_at_ms {
        return;
    }
    run_task_store_maintenance_and_log(store, config, cursor, "periodic");
    *next_maintenance_at_ms = now.saturating_add(config.maintenance_interval_ms);
}

fn run_task_store_maintenance_and_log(
    store: &TaskStore,
    config: TaskStoreMaintenanceConfig,
    cursor: &mut TaskStoreMaintenanceCursor,
    trigger: &'static str,
) {
    match run_task_store_maintenance(store, config, cursor) {
        Ok(stats) if stats.changed() => {
            tracing::debug!(
                trigger,
                pruned_tasks = stats.pruned_tasks,
                capped_events = stats.capped_events,
                capped_segments = stats.capped_segments,
                next_after_task_id = cursor.after_task_id.as_deref().unwrap_or(""),
                "task store maintenance applied"
            );
        }
        Ok(_) => {}
        Err(error) => {
            tracing::warn!(%error, trigger, "task store maintenance failed");
        }
    }
}

/// Cloneable async handle to the task-store actor.
///
/// Each handle holds the sender end of the actor's command channel; cloning a
/// handle shares the same underlying single-writer thread. When the last handle
/// is dropped the channel closes and the actor thread exits after draining.
#[derive(Clone)]
pub struct TaskStoreHandle {
    tx: mpsc::Sender<TaskStoreCommand>,
    /// Count of best-effort writes shed because the bounded queue was full.
    dropped_best_effort_writes: Arc<AtomicU64>,
}

/// A unit of work for the task-store actor thread.
///
/// Each variant carries its inputs plus a oneshot `reply` channel the actor
/// uses to send the (stringified) result back to the awaiting caller. Errors are
/// carried as `String` so the SQLite-bound error does not have to cross the
/// thread boundary as a non-`Send` type.
///
/// Task 8 wires the full set of task-RPC variants: episode export and resume
/// begin/attach/block. Every variant carries JSON-safe inputs and replies with
/// either a serializable DTO or a pre-built [`serde_json::Value`] (for variants
/// that must consult store-private types the dispatcher does not import).
/// Existence checks are not a standalone command — they run synchronously on
/// the actor thread inside `Export` and `resume_begin` (see `store.task_exists`).
enum TaskStoreCommand {
    ListTasks {
        filter: TaskListFilter,
        reply: oneshot::Sender<Result<Vec<TaskSummary>, String>>,
    },
    Export {
        task_id: String,
        reply: oneshot::Sender<Result<EpisodeExport, String>>,
    },
    ResumeBegin {
        task_id: String,
        session_id: String,
        turn_id: String,
        generation: i64,
        ttl_ms: i64,
        /// Replies with the fully-built `tasksResume` wire result
        /// (`{ resumeToken, attemptId, plan, episode }`).
        reply: oneshot::Sender<Result<Value, String>>,
    },
    ResumeCompleteAttached {
        token: String,
        generation: i64,
        /// Replies with the attached execution segment serialized to JSON.
        reply: oneshot::Sender<Result<Value, String>>,
    },
    ResumeCompleteBlocked {
        token: String,
        payload: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Record finalize evidence for the current turn (Task 10).
    ///
    /// Atomic ensure+append on the actor thread: resolve (or auto-create+bind) the
    /// session's task, ensure the `(session, turn)` segment exists, then append a
    /// `tabs_finalized` typed event referencing the resolved `taskId`/`segmentId`.
    /// Building the payload here keeps the resolved `task_id` on the writer thread
    /// (no second round trip) and the whole thing single-writer.
    ///
    /// `outcome` is the REAL finalize disposition the dispatcher extracted from the
    /// backend's normalized finalize result (closed/released/kept/deliverable tab
    /// sets), embedded verbatim so the durable evidence records what finalize
    /// actually did rather than a constant.
    RecordFinalizeEvidence {
        session_id: String,
        turn_id: String,
        generation: Option<i64>,
        outcome: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Record turn-ended evidence for the current turn (Task 10).
    ///
    /// Same atomic ensure+append shape as [`TaskStoreCommand::RecordFinalizeEvidence`],
    /// appending a `turn_ended` typed event instead.
    RecordTurnEndedEvidence {
        session_id: String,
        turn_id: String,
        generation: Option<i64>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Record one routed browser command against the current turn.
    RecordCommandEvent {
        session_id: String,
        turn_id: String,
        generation: Option<i64>,
        event: Value,
        reply: oneshot::Sender<Result<(), String>>,
    },
}

impl TaskStoreHandle {
    /// Open the task store in owner-only directory `dir` on a dedicated actor
    /// thread and return a handle to it.
    ///
    /// An `Ok(Self)` means the actor THREAD started; it does NOT guarantee the
    /// store opened. If [`TaskStore::open`] fails inside the thread (e.g. `dir`
    /// is not owner-only), the thread exits and the first command resolves to a
    /// "task store actor closed" error rather than blocking.
    ///
    /// Spawns the `obu-task-store` thread, which calls [`TaskStore::open`] and
    /// then blocks on the command channel, processing one command at a time. If
    /// the store cannot be opened the thread logs and exits, which closes the
    /// reply path; subsequent calls on the handle then resolve to a "task store
    /// actor closed" error rather than blocking.
    pub fn open(dir: PathBuf) -> Result<Self> {
        Self::open_with_maintenance_config(dir, TaskStoreMaintenanceConfig::from_env())
    }

    fn open_with_maintenance_config(
        dir: PathBuf,
        maintenance_config: TaskStoreMaintenanceConfig,
    ) -> Result<Self> {
        let (tx, mut rx) = mpsc::channel::<TaskStoreCommand>(ACTOR_CHANNEL_CAPACITY);
        thread::Builder::new()
            .name("obu-task-store".into())
            .spawn(move || {
                let store = match TaskStore::open(&dir) {
                    Ok(store) => store,
                    Err(error) => {
                        tracing::warn!(%error, "task store unavailable");
                        return;
                    }
                };
                let mut maintenance_cursor = TaskStoreMaintenanceCursor::default();
                run_task_store_maintenance_and_log(
                    &store,
                    maintenance_config,
                    &mut maintenance_cursor,
                    "startup",
                );
                let mut next_maintenance_at_ms =
                    now_millis().saturating_add(maintenance_config.maintenance_interval_ms);
                // Raw resume tokens for in-flight attempts, keyed by attempt id.
                // The store persists only token *hashes*, never the raw token,
                // so this in-memory map is the only place the raw wire token
                // lives. It is intentionally process-local: after a host restart
                // it starts empty, and the rotate-on-miss path below re-mints a
                // token without double-counting the attempt. Entries are removed
                // when an attempt reaches a terminal state (attached/blocked); it
                // is otherwise bounded by the set of currently-pending attempts
                // over this process lifetime.
                let mut raw_resume_tokens: HashMap<String, String> = HashMap::new();
                // Blocking receive: this thread owns the store and processes
                // commands serially, so the single-writer invariant holds. We
                // use `blocking_recv` (not `.await`) because this is a plain OS
                // thread, not an async task.
                while let Some(command) = rx.blocking_recv() {
                    match command {
                        TaskStoreCommand::ListTasks { filter, reply } => {
                            let _ = reply
                                .send(store.list_tasks(filter).map_err(|error| error.to_string()));
                        }
                        TaskStoreCommand::Export { task_id, reply } => {
                            // §13: export of an unknown id must surface an
                            // explicit existence failure, not an empty episode.
                            // Checked here on the actor thread so it shares the
                            // single round trip with `export_episode`.
                            let result = store
                                .task_exists(&task_id)
                                .map_err(|error| error.to_string())
                                .and_then(|exists| {
                                    if exists {
                                        store
                                            .export_episode(&task_id)
                                            .map_err(|error| error.to_string())
                                    } else {
                                        Err("unknown_task".to_string())
                                    }
                                });
                            let _ = reply.send(result);
                        }
                        TaskStoreCommand::ResumeBegin {
                            task_id,
                            session_id,
                            turn_id,
                            generation,
                            ttl_ms,
                            reply,
                        } => {
                            let result = resume_begin(
                                &store,
                                &mut raw_resume_tokens,
                                &task_id,
                                &session_id,
                                &turn_id,
                                generation,
                                ttl_ms,
                            );
                            let _ = reply.send(result);
                        }
                        TaskStoreCommand::ResumeCompleteAttached {
                            token,
                            generation,
                            reply,
                        } => {
                            let result = match store.complete_resume_attached(&token, generation) {
                                Ok(outcome) => {
                                    // The resumed segment is now the attached
                                    // browser-side-effect authority: project Running.
                                    project_task_state(
                                        &store,
                                        &outcome.task_id,
                                        TaskState::Running,
                                        &SessionTurnEvidence::running_on_turn(
                                            outcome.segment.turn_id.clone(),
                                        ),
                                    );
                                    serde_json::to_value(outcome.segment)
                                        .map_err(|error| error.to_string())
                                }
                                Err(error) => Err(error.to_string()),
                            };
                            // Terminal state reached: evict the cached raw token
                            // so the map stays bounded.
                            evict_resume_token(&mut raw_resume_tokens, &token);
                            let _ = reply.send(result);
                        }
                        TaskStoreCommand::ResumeCompleteBlocked {
                            token,
                            payload,
                            reply,
                        } => {
                            let result = match store.complete_resume_blocked(&token, payload) {
                                Ok(task_id) => {
                                    // Resume gave up: project Blocked (control-state
                                    // projection; transition guarded as always).
                                    project_task_state(
                                        &store,
                                        &task_id,
                                        TaskState::Blocked,
                                        &SessionTurnEvidence::blocked(),
                                    );
                                    Ok(())
                                }
                                Err(error) => Err(error.to_string()),
                            };
                            // Terminal state reached: evict the cached raw token
                            // so the map stays bounded.
                            evict_resume_token(&mut raw_resume_tokens, &token);
                            let _ = reply.send(result);
                        }
                        TaskStoreCommand::RecordFinalizeEvidence {
                            session_id,
                            turn_id,
                            generation,
                            outcome,
                            reply,
                        } => {
                            let result = record_finalize_evidence(
                                &store,
                                &session_id,
                                &turn_id,
                                generation,
                                outcome,
                            );
                            let _ = reply.send(result);
                        }
                        TaskStoreCommand::RecordTurnEndedEvidence {
                            session_id,
                            turn_id,
                            generation,
                            reply,
                        } => {
                            let result = record_turn_ended_evidence(
                                &store,
                                &session_id,
                                &turn_id,
                                generation,
                            );
                            let _ = reply.send(result);
                        }
                        TaskStoreCommand::RecordCommandEvent {
                            session_id,
                            turn_id,
                            generation,
                            event,
                            reply,
                        } => {
                            let result = record_command_event(
                                &store,
                                &session_id,
                                &turn_id,
                                generation,
                                event,
                            );
                            let _ = reply.send(result);
                        }
                    }
                    maybe_run_task_store_maintenance(
                        &store,
                        maintenance_config,
                        &mut maintenance_cursor,
                        &mut next_maintenance_at_ms,
                    );
                }
            })?;
        Ok(Self {
            tx,
            dropped_best_effort_writes: Arc::new(AtomicU64::new(0)),
        })
    }

    #[cfg(test)]
    fn open_with_maintenance_config_for_test(
        dir: PathBuf,
        maintenance_config: TaskStoreMaintenanceConfig,
    ) -> Result<Self> {
        Self::open_with_maintenance_config(dir, maintenance_config)
    }

    /// Number of best-effort observability writes shed because the bounded queue
    /// was full (audit §4.9). Monotonic over the handle's lifetime; useful for
    /// diagnostics and exercised by the load-shedding unit test.
    pub fn dropped_best_effort_writes(&self) -> u64 {
        self.dropped_best_effort_writes.load(Ordering::Relaxed)
    }

    /// List tasks matching `filter` via the actor thread.
    ///
    /// Sends a [`TaskStoreCommand::ListTasks`] with a fresh oneshot reply
    /// channel and awaits the result. Resolves to an error if the actor channel
    /// is closed (the actor thread has exited, e.g. the store failed to open or
    /// every handle was dropped) instead of hanging.
    pub async fn list_tasks(&self, filter: TaskListFilter) -> Result<Vec<TaskSummary>> {
        let (reply, rx) = oneshot::channel();
        // must-send: the blocking, back-pressured `send().await` is intentional —
        // do NOT convert these (list/export/resume_*) to `try_send`. Shedding a
        // write whose result the caller awaits would silently lose durable
        // resume/episode state. Only the best-effort observability writes shed
        // (see `ACTOR_CHANNEL_CAPACITY`).
        self.tx
            .send(TaskStoreCommand::ListTasks { filter, reply })
            .await
            .map_err(|_| anyhow!("task store actor closed"))?;
        rx.await
            .map_err(|_| anyhow!("task store actor closed"))?
            .map_err(anyhow::Error::msg)
    }

    /// Export the full multi-turn episode for `task_id`, via the actor thread.
    pub async fn export_episode(&self, task_id: String) -> Result<EpisodeExport> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(TaskStoreCommand::Export { task_id, reply })
            .await
            .map_err(|_| anyhow!("task store actor closed"))?;
        rx.await
            .map_err(|_| anyhow!("task store actor closed"))?
            .map_err(anyhow::Error::msg)
    }

    /// Begin a resume attempt and return the assembled `tasksResume` wire result
    /// (`{ resumeToken, attemptId, plan, episode }`) as JSON.
    ///
    /// The raw wire token is resolved entirely on the actor thread (see
    /// `resume_begin`): a freshly created attempt returns its newly minted
    /// token, an idempotent retry returns the cached token, and a cache miss
    /// after a host restart rotates a fresh token WITHOUT appending another
    /// `resume_attempt_started` event.
    pub async fn resume_begin(
        &self,
        task_id: String,
        session_id: String,
        turn_id: String,
        generation: i64,
        ttl_ms: i64,
    ) -> Result<Value> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(TaskStoreCommand::ResumeBegin {
                task_id,
                session_id,
                turn_id,
                generation,
                ttl_ms,
                reply,
            })
            .await
            .map_err(|_| anyhow!("task store actor closed"))?;
        rx.await
            .map_err(|_| anyhow!("task store actor closed"))?
            .map_err(anyhow::Error::msg)
    }

    /// Complete a resume attempt as attached, returning the attached execution
    /// segment serialized to JSON.
    pub async fn resume_complete_attached(&self, token: String, generation: i64) -> Result<Value> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(TaskStoreCommand::ResumeCompleteAttached {
                token,
                generation,
                reply,
            })
            .await
            .map_err(|_| anyhow!("task store actor closed"))?;
        rx.await
            .map_err(|_| anyhow!("task store actor closed"))?
            .map_err(anyhow::Error::msg)
    }

    /// Complete a resume attempt as blocked/terminal, recording `payload` as the
    /// failure reason.
    pub async fn resume_complete_blocked(&self, token: String, payload: Value) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(TaskStoreCommand::ResumeCompleteBlocked {
                token,
                payload,
                reply,
            })
            .await
            .map_err(|_| anyhow!("task store actor closed"))?;
        rx.await
            .map_err(|_| anyhow!("task store actor closed"))?
            .map_err(anyhow::Error::msg)
    }

    /// Record finalize evidence for the current turn's segment (Task 10).
    ///
    /// Atomically (on the actor thread) ensures the session's task and the
    /// `(session, turn)` segment exist — auto-creating and binding a task when the
    /// session has none — then appends a `tabs_finalized` typed event whose
    /// `outcome` is the real finalize disposition. This is a best-effort
    /// observability side effect: callers (the dispatcher's finalize route) log and
    /// continue on `Err` so a store hiccup never fails the user's finalize.
    pub async fn record_finalize_evidence(
        &self,
        session_id: String,
        turn_id: String,
        generation: Option<i64>,
        outcome: Value,
    ) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        // Best-effort observability write: shed (and count) instead of blocking
        // when the bounded queue is full, so a tight command loop can never grow
        // the actor queue without bound (audit §4.9). A full queue resolves
        // Ok(()) — the dispatcher's caller already log-and-continues on Err, and a
        // shed finalize-evidence record must not stall or fail the user's action.
        match self.tx.try_send(TaskStoreCommand::RecordFinalizeEvidence {
            session_id,
            turn_id,
            generation,
            outcome,
            reply,
        }) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                let prev = self
                    .dropped_best_effort_writes
                    .fetch_add(1, Ordering::Relaxed);
                // audit §4.9: the shed is otherwise dark. Warn on the first drop
                // and on power-of-two boundaries (rate-limited so a saturated
                // command loop cannot spam the log) so an operator/verifier can
                // detect a degraded episode. The dropped row is best-effort
                // observability only — resume/segment state is must-send.
                if prev == 0 || (prev + 1).is_power_of_two() {
                    tracing::warn!(
                        dropped_best_effort_writes = prev + 1,
                        write = "record_finalize_evidence",
                        "task store actor queue full; shedding a best-effort observability write (audit §4.9)"
                    );
                }
                return Ok(());
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(anyhow!("task store actor closed"));
            }
        }
        rx.await
            .map_err(|_| anyhow!("task store actor closed"))?
            .map_err(anyhow::Error::msg)
    }

    /// Record turn-ended evidence for the current turn's segment (Task 10).
    ///
    /// Same atomic ensure+append contract as [`TaskStoreHandle::record_finalize_evidence`],
    /// appending a `turn_ended` typed event. Best-effort: callers log and continue
    /// on `Err`.
    pub async fn record_turn_ended_evidence(
        &self,
        session_id: String,
        turn_id: String,
        generation: Option<i64>,
    ) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        // Best-effort observability write: shed (and count) instead of blocking
        // when the bounded queue is full, so a tight command loop can never grow
        // the actor queue without bound (audit §4.9). A full queue resolves
        // Ok(()) — the dispatcher's caller already log-and-continues on Err, and a
        // shed turn-ended-evidence record must not stall or fail the user's action.
        match self.tx.try_send(TaskStoreCommand::RecordTurnEndedEvidence {
            session_id,
            turn_id,
            generation,
            reply,
        }) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                let prev = self
                    .dropped_best_effort_writes
                    .fetch_add(1, Ordering::Relaxed);
                // audit §4.9: the shed is otherwise dark. Warn on the first drop
                // and on power-of-two boundaries (rate-limited so a saturated
                // command loop cannot spam the log) so an operator/verifier can
                // detect a degraded episode. The dropped row is best-effort
                // observability only — resume/segment state is must-send.
                if prev == 0 || (prev + 1).is_power_of_two() {
                    tracing::warn!(
                        dropped_best_effort_writes = prev + 1,
                        write = "record_turn_ended_evidence",
                        "task store actor queue full; shedding a best-effort observability write (audit §4.9)"
                    );
                }
                return Ok(());
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(anyhow!("task store actor closed"));
            }
        }
        rx.await
            .map_err(|_| anyhow!("task store actor closed"))?
            .map_err(anyhow::Error::msg)
    }

    /// Record a routed browser command for the current turn's segment.
    ///
    /// Same best-effort call shape as finalize/turn-ended evidence: the actor
    /// resolves (or auto-creates) the current task and segment, then appends a
    /// typed `browser_command` event.
    pub async fn record_command_event(
        &self,
        session_id: String,
        turn_id: String,
        generation: Option<i64>,
        event: Value,
    ) -> Result<()> {
        let (reply, rx) = oneshot::channel();
        // Best-effort observability write: shed (and count) instead of blocking
        // when the bounded queue is full, so a tight command loop can never grow
        // the actor queue without bound (audit §4.9). A full queue resolves
        // Ok(()) — the dispatcher's caller already log-and-continues on Err, and a
        // shed command-event must not stall or fail the user's action.
        match self.tx.try_send(TaskStoreCommand::RecordCommandEvent {
            session_id,
            turn_id,
            generation,
            event,
            reply,
        }) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => {
                let prev = self
                    .dropped_best_effort_writes
                    .fetch_add(1, Ordering::Relaxed);
                // audit §4.9: the shed is otherwise dark. Warn on the first drop
                // and on power-of-two boundaries (rate-limited so a saturated
                // command loop cannot spam the log) so an operator/verifier can
                // detect a degraded episode. The dropped row is best-effort
                // observability only — resume/segment state is must-send.
                if prev == 0 || (prev + 1).is_power_of_two() {
                    tracing::warn!(
                        dropped_best_effort_writes = prev + 1,
                        write = "record_command_event",
                        "task store actor queue full; shedding a best-effort observability write (audit §4.9)"
                    );
                }
                return Ok(());
            }
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(anyhow!("task store actor closed"));
            }
        }
        rx.await
            .map_err(|_| anyhow!("task store actor closed"))?
            .map_err(anyhow::Error::msg)
    }
}

/// Begin a resume attempt on the actor thread and assemble the wire result.
///
/// Token resolution (Task 8, Step 6):
/// - [`TaskStore::begin_resume_attempt`] returning `resume_token: Some(token)`
///   means a fresh attempt was created — cache the raw token by attempt id and
///   use it.
/// - returning `None` means an idempotent retry matched an existing pending
///   attempt. Use the cached raw token if we still have it; if the cache has no
///   entry (the attempt outlived this process — host restart), call
///   [`TaskStore::rotate_resume_attempt_token`], which mints a replacement and
///   stores its hash WITHOUT appending a second `resume_attempt_started` event,
///   then cache and use the replacement.
///
/// The plan and episode are read after the attempt so the SDK gets the recovery
/// decision (Finding 16) and the durable episode in the same round trip.
fn resume_begin(
    store: &TaskStore,
    raw_resume_tokens: &mut HashMap<String, String>,
    task_id: &str,
    session_id: &str,
    turn_id: &str,
    generation: i64,
    ttl_ms: i64,
) -> Result<Value, String> {
    // §13: resume of an unknown id gets an explicit existence failure before any
    // attempt insert, so the caller sees `unknown_task` rather than an opaque
    // foreign-key-violation InternalError from `begin_resume_attempt`.
    if !store
        .task_exists(task_id)
        .map_err(|error| error.to_string())?
    {
        return Err("unknown_task".to_string());
    }
    let ResumeAttemptBegin {
        attempt_id,
        resume_token,
        ..
    } = store
        .begin_resume_attempt(task_id, session_id, turn_id, generation, ttl_ms)
        .map_err(|error| error.to_string())?;

    let resume_token = match resume_token {
        Some(token) => {
            raw_resume_tokens.insert(attempt_id.clone(), token.clone());
            token
        }
        None => match raw_resume_tokens.get(&attempt_id) {
            Some(token) => token.clone(),
            None => {
                let token = store
                    .rotate_resume_attempt_token(&attempt_id)
                    .map_err(|error| error.to_string())?;
                raw_resume_tokens.insert(attempt_id.clone(), token.clone());
                token
            }
        },
    };

    let plan = plan_task_resume(store, task_id, generation);
    let episode = store
        .export_episode(task_id)
        .map_err(|error| error.to_string())?;

    let plan = serde_json::to_value(plan).map_err(|error| error.to_string())?;
    let episode = serde_json::to_value(episode).map_err(|error| error.to_string())?;

    // A resume attempt has begun: project Resuming. Best-effort and guarded — a
    // task still in `Created` (no prior Running) legally has no `Resuming`
    // transition, so this is simply skipped there.
    project_task_state(
        store,
        task_id,
        TaskState::Resuming,
        &SessionTurnEvidence::resuming(),
    );

    Ok(json!({
        "resumeToken": resume_token,
        "attemptId": attempt_id,
        "plan": plan,
        "episode": episode,
    }))
}

/// Resolve (or auto-create + bind) the task for `session_id`, then ensure the
/// `(session_id, turn_id)` execution segment exists, returning both ids.
///
/// Runs on the actor thread so the resolved `task_id` stays where the typed
/// evidence payload is built (no second round trip). When the session has no
/// bound task yet, a fresh task is created (`label: "Browser task {session_id}"`)
/// at the current [`TASK_STORE_SCHEMA_VERSION`] and bound to the session before
/// the segment is ensured. [`TaskStore::ensure_turn_segment`] is idempotent, so a
/// second finalize/turn-end for the same turn returns the existing segment rather
/// than creating a second one.
fn ensure_current_turn_segment(
    store: &TaskStore,
    session_id: &str,
    turn_id: &str,
    generation: Option<i64>,
) -> Result<(String, Segment), String> {
    let task_id = match store
        .task_for_session(session_id)
        .map_err(|e| e.to_string())?
    {
        Some(task_id) => task_id,
        None => {
            let task_id = store
                .create_task(NewTask {
                    label: format!("Browser task {session_id}"),
                    schema_version: TASK_STORE_SCHEMA_VERSION,
                })
                .map_err(|e| e.to_string())?;
            store
                .bind_session_task(session_id, &task_id)
                .map_err(|e| e.to_string())?;
            task_id
        }
    };
    let segment = store
        .ensure_turn_segment(&task_id, session_id, turn_id, generation)
        .map_err(|e| e.to_string())?;
    Ok((task_id, segment))
}

/// Ensure the current turn's segment and append a `tabs_finalized` typed event.
///
/// The payload carries the resolved `taskId`/`segmentId` plus the real finalize
/// `outcome` (the closed/released/kept/deliverable tab dispositions the dispatcher
/// extracted from the backend's normalized finalize result), so the durable
/// episode records what finalize actually did — not a constant.
fn record_finalize_evidence(
    store: &TaskStore,
    session_id: &str,
    turn_id: &str,
    generation: Option<i64>,
    outcome: Value,
) -> Result<(), String> {
    let (task_id, segment) = ensure_current_turn_segment(store, session_id, turn_id, generation)?;
    let payload = json!({
        "kind": "tabs_finalized",
        "taskId": task_id,
        "segmentId": segment.segment_id,
        "sessionId": session_id,
        "turnId": turn_id,
        "outcome": outcome,
        "at": now_millis(),
    });
    store
        .append_typed_event(&task_id, "tabs_finalized", payload)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Ensure the current turn's segment and append a `turn_ended` typed event.
fn record_turn_ended_evidence(
    store: &TaskStore,
    session_id: &str,
    turn_id: &str,
    generation: Option<i64>,
) -> Result<(), String> {
    let (task_id, segment) = ensure_current_turn_segment(store, session_id, turn_id, generation)?;
    let payload = json!({
        "kind": "turn_ended",
        "taskId": task_id,
        "segmentId": segment.segment_id,
        "sessionId": session_id,
        "turnId": turn_id,
        "at": now_millis(),
    });
    store
        .append_typed_event(&task_id, "turn_ended", payload)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Ensure the current turn's segment and append a `browser_command` typed event.
fn record_command_event(
    store: &TaskStore,
    session_id: &str,
    turn_id: &str,
    generation: Option<i64>,
    event: Value,
) -> Result<(), String> {
    let (task_id, segment) = ensure_current_turn_segment(store, session_id, turn_id, generation)?;
    let mut payload = match event {
        Value::Object(map) => map,
        other => {
            let mut map = serde_json::Map::new();
            map.insert("payload".to_string(), other);
            map
        }
    };
    payload.insert(
        "kind".to_string(),
        Value::String("browser_command".to_string()),
    );
    payload.insert("taskId".to_string(), Value::String(task_id.clone()));
    payload.insert(
        "segmentId".to_string(),
        Value::String(segment.segment_id.clone()),
    );
    payload.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    payload.insert("turnId".to_string(), Value::String(turn_id.to_string()));
    payload.insert("at".to_string(), Value::Number(now_millis().into()));
    let succeeded = payload.get("status").and_then(Value::as_str) == Some("ok");
    store
        .append_typed_event(&task_id, "browser_command", Value::Object(payload))
        .map_err(|e| e.to_string())?;

    // Project Running: a successful browser command proves the turn is open, the
    // tab is commandable, and this segment is the attached authority. Best-effort
    // and guarded (see project_task_state) so a terminal/cancelling task is never
    // revived and illegal transitions are skipped.
    if succeeded {
        project_task_state(
            store,
            &task_id,
            TaskState::Running,
            &SessionTurnEvidence::running_on_turn(turn_id),
        );
    }
    Ok(())
}

/// Best-effort forward projection: persist `target` only if the evidence supports
/// it AND it is a legal one-step transition from the current state. Never fails the
/// caller — task-state is an observability projection, not control flow — and logs
/// on error.
fn project_task_state(
    store: &TaskStore,
    task_id: &str,
    target: TaskState,
    evidence: &SessionTurnEvidence,
) {
    let current = match store.task_state(task_id) {
        Ok(state) => state,
        Err(error) => {
            tracing::warn!(%error, task_id, ?target, "project_task_state: read failed");
            return;
        }
    };
    if current == target {
        return;
    }
    if !task_state_allowed(target, evidence) {
        return;
    }
    if !allowed_transitions(current).contains(&target) {
        return;
    }
    if let Err(error) = store.set_state(task_id, target) {
        tracing::warn!(%error, task_id, ?target, "project_task_state: set_state failed");
    }
}

/// Evict the cached raw token whose value matches `token`.
///
/// The map is keyed by attempt id, but a completion is identified by its raw
/// wire token, so we drop the (single) entry whose value equals `token`. A
/// no-op when the token is not cached (e.g. completed in a later process after a
/// restart, where the cache started empty).
fn evict_resume_token(raw_resume_tokens: &mut HashMap<String, String>, token: &str) {
    if let Some(attempt_id) = raw_resume_tokens
        .iter()
        .find(|(_, cached)| cached.as_str() == token)
        .map(|(attempt_id, _)| attempt_id.clone())
    {
        raw_resume_tokens.remove(&attempt_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maintenance_config_uses_defaults_and_env_overrides() {
        assert_eq!(
            TaskStoreMaintenanceConfig::from_lookup(|_| None),
            TaskStoreMaintenanceConfig::default()
        );

        let overridden = TaskStoreMaintenanceConfig::from_lookup(|name| match name {
            ENV_TASK_STORE_RETENTION_WINDOW_MS => Some("10".into()),
            ENV_TASK_STORE_EVENT_CAP => Some("11".into()),
            ENV_TASK_STORE_SEGMENT_CAP => Some("12".into()),
            ENV_TASK_STORE_MAINTENANCE_INTERVAL_MS => Some("13".into()),
            ENV_TASK_STORE_MAINTENANCE_TASKS_PER_PASS => Some("14".into()),
            _ => None,
        });
        assert_eq!(
            overridden,
            TaskStoreMaintenanceConfig {
                retention_window_ms: 10,
                max_events_per_task: 11,
                max_segments_per_task: 12,
                maintenance_interval_ms: 13,
                maintenance_tasks_per_pass: 14,
            }
        );

        let invalid = TaskStoreMaintenanceConfig::from_lookup(|name| match name {
            ENV_TASK_STORE_RETENTION_WINDOW_MS => Some("-1".into()),
            ENV_TASK_STORE_EVENT_CAP => Some("not-a-number".into()),
            ENV_TASK_STORE_SEGMENT_CAP => Some("-12".into()),
            ENV_TASK_STORE_MAINTENANCE_INTERVAL_MS => Some("0".into()),
            ENV_TASK_STORE_MAINTENANCE_TASKS_PER_PASS => Some("0".into()),
            _ => None,
        });
        assert_eq!(invalid, TaskStoreMaintenanceConfig::default());
    }

    #[test]
    fn maintenance_cursor_bounds_segment_and_event_capping_per_pass() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(
            dir.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let store = TaskStore::open(dir.path()).unwrap();

        for task_index in 0..3 {
            let task_id = store
                .create_task(NewTask {
                    label: format!("task-{task_index}"),
                    schema_version: TASK_STORE_SCHEMA_VERSION,
                })
                .unwrap();
            for _ in 0..3 {
                store.append_event(&task_id, "marker", "{}").unwrap();
            }
            for segment_index in 0..3 {
                store
                    .ensure_turn_segment(
                        &task_id,
                        &format!("s{task_index}"),
                        &format!("t{segment_index}"),
                        Some(7),
                    )
                    .unwrap();
            }
        }

        let task_ids = store.task_ids_after(None, 10).unwrap();
        assert_eq!(task_ids.len(), 3);
        let config = TaskStoreMaintenanceConfig {
            retention_window_ms: 60_000,
            max_events_per_task: 1,
            max_segments_per_task: 1,
            maintenance_interval_ms: 0,
            maintenance_tasks_per_pass: 1,
        };
        let mut cursor = TaskStoreMaintenanceCursor::default();

        run_task_store_maintenance(&store, config, &mut cursor).unwrap();
        assert_eq!(store.events(&task_ids[0]).unwrap().len(), 1);
        assert_eq!(store.segments(&task_ids[0]).unwrap().len(), 1);
        assert_eq!(store.events(&task_ids[1]).unwrap().len(), 3);
        assert_eq!(store.segments(&task_ids[1]).unwrap().len(), 3);

        run_task_store_maintenance(&store, config, &mut cursor).unwrap();
        assert_eq!(store.events(&task_ids[1]).unwrap().len(), 1);
        assert_eq!(store.segments(&task_ids[1]).unwrap().len(), 1);
        assert_eq!(store.events(&task_ids[2]).unwrap().len(), 3);
        assert_eq!(store.segments(&task_ids[2]).unwrap().len(), 3);

        run_task_store_maintenance(&store, config, &mut cursor).unwrap();
        assert_eq!(store.events(&task_ids[2]).unwrap().len(), 1);
        assert_eq!(store.segments(&task_ids[2]).unwrap().len(), 1);
        assert_eq!(cursor.after_task_id, None);
    }

    #[tokio::test]
    async fn actor_opens_store_and_lists_empty_tasks() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(
            dir.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let handle = TaskStoreHandle::open(dir.path().to_path_buf()).unwrap();
        let rows = handle.list_tasks(Default::default()).await.unwrap();
        assert!(rows.is_empty());

        // A clone shares the same underlying actor thread and works against the
        // same (good) store, proving `TaskStoreHandle: Clone` is more than a
        // formality.
        let rows = handle.clone().list_tasks(Default::default()).await.unwrap();
        assert!(rows.is_empty());
    }

    /// The actor's primary failure guarantee: when the store cannot open,
    /// `list_tasks` resolves to an error and never hangs.
    ///
    /// We force a deterministic open failure by handing the actor a tempdir with
    /// world-accessible (`0o777`) permissions: `TaskStore::open` calls
    /// `validate_owner_only_dir`, which rejects any dir whose mode has group/other
    /// bits set (`mode & 0o077 != 0`) with `PermissionDenied`. So `TaskStore::open`
    /// returns `Err` before touching SQLite, the actor thread logs and exits, and
    /// the command resolves to "task store actor closed".
    ///
    /// This is race-free: whether the send loses to the thread's rx-drop or the
    /// command is enqueued then orphaned by the exiting thread, `list_tasks`
    /// resolves to an error either way.
    #[cfg(unix)]
    #[tokio::test]
    async fn list_tasks_errors_when_store_fails_to_open() {
        let dir = tempfile::tempdir().unwrap();
        // Opposite of the passing test: world-accessible perms, which
        // `validate_owner_only_dir` (and thus `TaskStore::open`) rejects.
        std::fs::set_permissions(
            dir.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o777),
        )
        .unwrap();
        let handle = TaskStoreHandle::open(dir.path().to_path_buf()).unwrap();
        let result = handle.list_tasks(Default::default()).await;
        assert!(result.is_err());
    }

    /// A best-effort write past the bounded queue capacity is dropped (counted),
    /// never grows the queue, and resolves `Ok(())` so the caller's
    /// log-and-continue path is unaffected (audit §4.9).
    #[tokio::test]
    async fn record_command_event_sheds_load_when_queue_is_full() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(
            dir.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();
        let handle = TaskStoreHandle::open(dir.path().to_path_buf()).unwrap();
        // Flood far past the bounded capacity with best-effort writes. Each call is
        // spawned (not awaited inline) so the sends outpace the single SQLite writer
        // — exactly how the dispatcher fires these (`tokio::spawn` +
        // `record_command_event`, see `Dispatcher::route_request`). Awaiting each
        // call inline would instead serialize on its oneshot reply, holding queue
        // depth at one and never exercising the shed path. With the flood, some
        // `try_send`s see a full queue and are counted as drops — yet every call
        // still resolves `Ok(())`, leaving the caller's log-and-continue unaffected.
        let mut writes = Vec::with_capacity(10_000);
        for _ in 0..10_000 {
            let handle = handle.clone();
            writes.push(tokio::spawn(async move {
                handle
                    .record_command_event(
                        "s1".into(),
                        "t1".into(),
                        None,
                        serde_json::json!({"method": "noop"}),
                    )
                    .await
                    .expect("best-effort write must resolve Ok even when shed");
            }));
        }
        for write in writes {
            write
                .await
                .expect("spawned best-effort write must not panic");
        }
        assert!(
            handle.dropped_best_effort_writes() > 0,
            "a 10k-deep flood past the bounded queue must shed at least one write"
        );
    }

    #[tokio::test]
    async fn actor_maintenance_prunes_old_terminal_and_caps_written_rows() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(
            dir.path(),
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )
        .unwrap();

        {
            let store = TaskStore::open(dir.path()).unwrap();
            let old_terminal = store
                .create_task(NewTask {
                    label: "old".into(),
                    schema_version: TASK_STORE_SCHEMA_VERSION,
                })
                .unwrap();
            store
                .ensure_turn_segment(&old_terminal, "old-session", "old-turn", Some(1))
                .unwrap();
            store
                .append_typed_event(
                    &old_terminal,
                    "marker",
                    serde_json::json!({"kind": "marker"}),
                )
                .unwrap();
            store
                .set_task_created_at_for_test(&old_terminal, now_millis() - 1_000_000)
                .unwrap();
            store
                .set_state(&old_terminal, TaskState::Completed)
                .unwrap();
        }

        let handle = TaskStoreHandle::open_with_maintenance_config_for_test(
            dir.path().to_path_buf(),
            TaskStoreMaintenanceConfig {
                retention_window_ms: 60_000,
                max_events_per_task: 3,
                max_segments_per_task: 2,
                maintenance_interval_ms: 0,
                maintenance_tasks_per_pass: 64,
            },
        )
        .unwrap();

        assert!(
            handle
                .list_tasks(Default::default())
                .await
                .unwrap()
                .is_empty(),
            "startup maintenance must prune old terminal tasks through the actor path"
        );

        for index in 0..5 {
            handle
                .record_command_event(
                    "s1".into(),
                    format!("t{index}"),
                    Some(7),
                    serde_json::json!({"method": "noop", "status": "ok", "index": index}),
                )
                .await
                .unwrap();
        }

        let rows = handle.list_tasks(Default::default()).await.unwrap();
        assert_eq!(rows.len(), 1);
        let episode = handle
            .export_episode(rows[0].task_id.clone())
            .await
            .unwrap();
        assert_eq!(
            episode.events.len(),
            3,
            "actor-written task events must be capped by periodic maintenance"
        );
        assert_eq!(
            episode.turns.len(),
            2,
            "actor-created execution segments must be capped by periodic maintenance"
        );
    }
}
