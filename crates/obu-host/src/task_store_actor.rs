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
use std::thread;

use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::task_store::{
    EpisodeExport, ResumeAttemptBegin, TaskListFilter, TaskStore, TaskSummary, plan_task_resume,
};

/// Cloneable async handle to the task-store actor.
///
/// Each handle holds the sender end of the actor's command channel; cloning a
/// handle shares the same underlying single-writer thread. When the last handle
/// is dropped the channel closes and the actor thread exits after draining.
#[derive(Clone)]
pub struct TaskStoreHandle {
    tx: mpsc::UnboundedSender<TaskStoreCommand>,
}

/// A unit of work for the task-store actor thread.
///
/// Each variant carries its inputs plus a oneshot `reply` channel the actor
/// uses to send the (stringified) result back to the awaiting caller. Errors are
/// carried as `String` so the SQLite-bound error does not have to cross the
/// thread boundary as a non-`Send` type.
///
/// Task 8 wires the full set of task-RPC variants: existence checks, episode
/// export, and resume begin/attach/block. Every variant carries JSON-safe
/// inputs and replies with either a serializable DTO or a pre-built
/// [`serde_json::Value`] (for variants that must consult store-private types
/// the dispatcher does not import).
enum TaskStoreCommand {
    ListTasks {
        filter: TaskListFilter,
        reply: oneshot::Sender<Result<Vec<TaskSummary>, String>>,
    },
    TaskExists {
        task_id: String,
        reply: oneshot::Sender<Result<bool, String>>,
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
        let (tx, mut rx) = mpsc::unbounded_channel::<TaskStoreCommand>();
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
                        TaskStoreCommand::TaskExists { task_id, reply } => {
                            let _ = reply.send(
                                store.task_exists(&task_id).map_err(|error| error.to_string()),
                            );
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
                            let result = store
                                .complete_resume_attached(&token, generation)
                                .map_err(|error| error.to_string())
                                .and_then(|outcome| {
                                    serde_json::to_value(outcome.segment)
                                        .map_err(|error| error.to_string())
                                });
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
                            let result = store
                                .complete_resume_blocked(&token, payload)
                                .map_err(|error| error.to_string());
                            // Terminal state reached: evict the cached raw token
                            // so the map stays bounded.
                            evict_resume_token(&mut raw_resume_tokens, &token);
                            let _ = reply.send(result);
                        }
                    }
                }
            })?;
        Ok(Self { tx })
    }

    /// List tasks matching `filter` via the actor thread.
    ///
    /// Sends a [`TaskStoreCommand::ListTasks`] with a fresh oneshot reply
    /// channel and awaits the result. Resolves to an error if the actor channel
    /// is closed (the actor thread has exited, e.g. the store failed to open or
    /// every handle was dropped) instead of hanging.
    pub async fn list_tasks(&self, filter: TaskListFilter) -> Result<Vec<TaskSummary>> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(TaskStoreCommand::ListTasks { filter, reply })
            .map_err(|_| anyhow!("task store actor closed"))?;
        rx.await
            .map_err(|_| anyhow!("task store actor closed"))?
            .map_err(anyhow::Error::msg)
    }

    /// Whether a task row with `task_id` exists, via the actor thread.
    pub async fn task_exists(&self, task_id: String) -> Result<bool> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(TaskStoreCommand::TaskExists { task_id, reply })
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
            .map_err(|_| anyhow!("task store actor closed"))?;
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
    if !store.task_exists(task_id).map_err(|error| error.to_string())? {
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
    Ok(json!({
        "resumeToken": resume_token,
        "attemptId": attempt_id,
        "plan": plan,
        "episode": episode,
    }))
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
}
