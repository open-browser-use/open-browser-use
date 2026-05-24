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

use std::path::PathBuf;
use std::thread;

use anyhow::{Result, anyhow};
use tokio::sync::{mpsc, oneshot};

use crate::task_store::{TaskListFilter, TaskStore, TaskSummary};

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
/// Task 8 extends this with more variants (e.g. existence checks, episode
/// export, resume begin/attach); only `ListTasks` exists at this stage.
enum TaskStoreCommand {
    ListTasks {
        filter: TaskListFilter,
        reply: oneshot::Sender<Result<Vec<TaskSummary>, String>>,
    },
}

impl TaskStoreHandle {
    /// Open the task store in owner-only directory `dir` on a dedicated actor
    /// thread and return a handle to it.
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
    }
}
