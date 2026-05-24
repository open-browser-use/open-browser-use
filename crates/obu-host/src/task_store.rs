//! Durable SQLite store for long-task metadata, checkpoints, and events.
//!
//! The store lives in an owner-only directory under the host runtime root and
//! survives host restarts. It is owner-local and single-process: a single
//! [`rusqlite::Connection`] is held for the lifetime of the [`TaskStore`].
//!
//! This module deliberately stores **no** SDK observation ids or pointer state
//! (Finding 10): observation identity is a cross-process concern that does not
//! belong in the host's durable task metadata.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use obu_wire::runtime_dir::validate_owner_only_dir;
use rusqlite::{Connection, OptionalExtension};

/// On-disk schema version for the durable task store.
///
/// Opening a store whose persisted version is newer than this constant fails
/// rather than attempting a silent migration (stale-resource behavior after a
/// host downgrade or partial upgrade).
pub const TASK_STORE_SCHEMA_VERSION: u32 = 1;

/// Parameters for creating a new task row.
#[derive(Debug, Clone)]
pub struct NewTask {
    /// Human-meaningful label for the task.
    pub label: String,
    /// Schema version the caller expects; recorded on the row.
    pub schema_version: u32,
}

/// A durable checkpoint appended to a task's monotonic checkpoint log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    /// Monotonic cursor for the checkpoint.
    pub cursor: i64,
    /// Opaque checkpoint payload.
    pub payload: String,
}

/// A per-resume execution segment record.
///
/// Task 5.4 elaborates the segment API; this is the minimal insert shape.
#[derive(Debug, Clone)]
pub struct Segment {
    /// Stable identifier for the segment.
    pub segment_id: String,
    /// Session that owns the segment.
    pub session_id: String,
    /// Turn within the session.
    pub turn_id: String,
}

/// A task loaded back from the durable store.
#[derive(Debug, Clone)]
pub struct LoadedTask {
    /// Task id.
    pub id: String,
    /// Human-meaningful label.
    pub label: String,
    /// Coarse task state, stored as a string.
    pub state: String,
    /// Schema version recorded on the row.
    pub schema_version: u32,
    /// Creation timestamp (unix millis).
    pub created_at: i64,
    /// Checkpoints in ascending cursor order.
    checkpoints: Vec<Checkpoint>,
}

impl LoadedTask {
    /// The highest-cursor checkpoint, if any have been appended.
    pub fn last_checkpoint(&self) -> Option<Checkpoint> {
        self.checkpoints.iter().max_by_key(|c| c.cursor).cloned()
    }
}

/// Owner-local, single-process durable task store backed by SQLite.
pub struct TaskStore {
    conn: Connection,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl TaskStore {
    /// Open (or create) the task store in the owner-only directory `dir`.
    ///
    /// Validates `dir` is owner-only, opens `dir/tasks.db`, runs the
    /// `CREATE TABLE IF NOT EXISTS` migrations, and records/checks the schema
    /// version in the `meta` table. Refuses to open when the persisted version
    /// is newer than [`TASK_STORE_SCHEMA_VERSION`].
    pub fn open(dir: &Path) -> Result<Self> {
        validate_owner_only_dir(dir)
            .with_context(|| format!("task store dir not owner-only: {}", dir.display()))?;

        let db_path = dir.join("tasks.db");
        let mut conn = Connection::open(&db_path)
            .with_context(|| format!("open task store db: {}", db_path.display()))?;

        conn.pragma_update(None, "journal_mode", "WAL")
            .context("set journal_mode=WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .context("enable foreign_keys")?;

        Self::setup_schema(&mut conn)?;

        Ok(Self { conn })
    }

    /// Run migrations and record/check the schema version atomically.
    ///
    /// Everything happens inside a single transaction so a crash mid-setup
    /// cannot leave tables without a recorded version (and so future
    /// multi-statement migrations stay all-or-nothing). The version *check*
    /// stays correct: on an existing db it reads the stored version and bails
    /// if it is newer than supported; on a fresh db it writes the current
    /// version inside the transaction.
    fn setup_schema(conn: &mut Connection) -> Result<()> {
        let tx = conn.transaction().context("begin schema setup tx")?;

        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS tasks (
                 id             TEXT PRIMARY KEY,
                 label          TEXT NOT NULL,
                 state          TEXT NOT NULL,
                 schema_version INTEGER NOT NULL,
                 created_at     INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS task_segments (
                 task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 segment_id TEXT NOT NULL,
                 session_id TEXT NOT NULL,
                 turn_id    TEXT NOT NULL,
                 started_at INTEGER NOT NULL,
                 PRIMARY KEY (task_id, segment_id)
             );
             CREATE TABLE IF NOT EXISTS task_checkpoints (
                 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 cursor  INTEGER NOT NULL,
                 payload TEXT NOT NULL,
                 at      INTEGER NOT NULL,
                 PRIMARY KEY (task_id, cursor)
             );
             CREATE TABLE IF NOT EXISTS task_events (
                 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 cursor  INTEGER NOT NULL,
                 kind    TEXT NOT NULL,
                 payload TEXT NOT NULL,
                 at      INTEGER NOT NULL,
                 PRIMARY KEY (task_id, cursor)
             );
             CREATE TABLE IF NOT EXISTS task_resources (
                 task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 resource_id TEXT NOT NULL,
                 kind        TEXT NOT NULL,
                 PRIMARY KEY (task_id, resource_id)
             );
             CREATE TABLE IF NOT EXISTS task_cancellation (
                 task_id      TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
                 requested_at INTEGER NOT NULL
             );",
        )
        .context("run task store migrations")?;

        let stored: Option<String> = tx
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()
            .context("read stored schema_version")?;

        match stored {
            None => {
                tx.execute(
                    "INSERT INTO meta (key, value) VALUES ('schema_version', ?1)",
                    [TASK_STORE_SCHEMA_VERSION.to_string()],
                )
                .context("record schema_version")?;
            }
            Some(value) => {
                let on_disk: u32 = value
                    .parse()
                    .with_context(|| format!("parse stored schema_version {value:?}"))?;
                if on_disk > TASK_STORE_SCHEMA_VERSION {
                    bail!(
                        "task store schema version {on_disk} is newer than supported {TASK_STORE_SCHEMA_VERSION}"
                    );
                }
            }
        }

        tx.commit().context("commit schema setup tx")?;
        Ok(())
    }

    /// Create a new task row and return its generated id.
    pub fn create_task(&self, new_task: NewTask) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.conn
            .execute(
                "INSERT INTO tasks (id, label, state, schema_version, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    id,
                    new_task.label,
                    "created",
                    new_task.schema_version,
                    now_millis(),
                ],
            )
            .context("insert task row")?;
        Ok(id)
    }

    /// Load a task and its checkpoint log by id.
    pub fn load_task(&self, task_id: &str) -> Result<LoadedTask> {
        let (label, state, schema_version, created_at) = self
            .conn
            .query_row(
                "SELECT label, state, schema_version, created_at FROM tasks WHERE id = ?1",
                [task_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .context("query task row")?
            .with_context(|| format!("task not found: {task_id}"))?;

        let mut stmt = self
            .conn
            .prepare("SELECT cursor, payload FROM task_checkpoints WHERE task_id = ?1 ORDER BY cursor ASC")
            .context("prepare checkpoint query")?;
        let checkpoints = stmt
            .query_map([task_id], |row| {
                Ok(Checkpoint {
                    cursor: row.get(0)?,
                    payload: row.get(1)?,
                })
            })
            .context("query checkpoints")?
            .collect::<rusqlite::Result<Vec<_>>>()
            .context("collect checkpoints")?;

        Ok(LoadedTask {
            id: task_id.to_string(),
            label,
            state,
            schema_version,
            created_at,
            checkpoints,
        })
    }

    /// Append a checkpoint to a task's checkpoint log.
    pub fn append_checkpoint(&self, task_id: &str, checkpoint: Checkpoint) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO task_checkpoints (task_id, cursor, payload, at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![task_id, checkpoint.cursor, checkpoint.payload, now_millis()],
            )
            .context("insert checkpoint")?;
        Ok(())
    }

    /// Append a per-resume execution segment.
    ///
    /// Minimal insert for Task 5.3; Task 5.4 extends the segment API.
    pub fn append_segment(&self, task_id: &str, segment: Segment) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO task_segments (task_id, segment_id, session_id, turn_id, started_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    task_id,
                    segment.segment_id,
                    segment.session_id,
                    segment.turn_id,
                    now_millis(),
                ],
            )
            .context("insert segment")?;
        Ok(())
    }

    /// Return the current maximum event cursor for a task (0 if no events).
    pub fn event_cursor(&self, task_id: &str) -> Result<i64> {
        let cursor: Option<i64> = self
            .conn
            .query_row(
                "SELECT MAX(cursor) FROM task_events WHERE task_id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .context("query event cursor")?
            .flatten();
        Ok(cursor.unwrap_or(0))
    }

    /// Record a cancellation request for a task (idempotent).
    pub fn mark_cancellation(&self, task_id: &str) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO task_cancellation (task_id, requested_at)
                 VALUES (?1, ?2)
                 ON CONFLICT(task_id) DO UPDATE SET requested_at = excluded.requested_at",
                rusqlite::params![task_id, now_millis()],
            )
            .context("mark cancellation")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create an owner-only temp dir, mirroring how the host provisions its
    /// runtime directory (0o700) before handing it to the task store.
    fn owner_only_tempdir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        dir
    }

    #[test]
    fn task_store_persists_and_reloads_task_metadata() {
        let dir = owner_only_tempdir();
        let store = TaskStore::open(dir.path()).unwrap();
        let task_id = store
            .create_task(NewTask {
                label: "buy".into(),
                schema_version: TASK_STORE_SCHEMA_VERSION,
            })
            .unwrap();
        store
            .append_checkpoint(
                &task_id,
                Checkpoint {
                    cursor: 1,
                    payload: "step-1".into(),
                },
            )
            .unwrap();

        // simulate host restart by reopening the same path
        drop(store);
        let store2 = TaskStore::open(dir.path()).unwrap();
        let loaded = store2.load_task(&task_id).unwrap();
        assert_eq!(loaded.label, "buy");
        assert_eq!(loaded.last_checkpoint().unwrap().cursor, 1);
    }

    #[test]
    fn task_store_refuses_newer_schema_version() {
        let dir = owner_only_tempdir();
        // Open once to create the db, then bump the stored version past support.
        {
            let store = TaskStore::open(dir.path()).unwrap();
            store
                .conn
                .execute(
                    "UPDATE meta SET value = ?1 WHERE key = 'schema_version'",
                    [(TASK_STORE_SCHEMA_VERSION + 1).to_string()],
                )
                .unwrap();
        }
        let result = TaskStore::open(dir.path());
        assert!(result.is_err());
        let err = match result {
            Ok(_) => unreachable!("expected schema-incompat error"),
            Err(e) => e,
        };
        let msg = format!("{err:#}");
        assert!(
            msg.contains("newer than supported"),
            "unexpected error message: {msg}"
        );
    }

    #[test]
    fn event_cursor_starts_at_zero() {
        let dir = owner_only_tempdir();
        let store = TaskStore::open(dir.path()).unwrap();
        let task_id = store
            .create_task(NewTask {
                label: "t".into(),
                schema_version: TASK_STORE_SCHEMA_VERSION,
            })
            .unwrap();
        assert_eq!(store.event_cursor(&task_id).unwrap(), 0);
    }

    #[test]
    fn append_segment_and_mark_cancellation_succeed() {
        let dir = owner_only_tempdir();
        let store = TaskStore::open(dir.path()).unwrap();
        let task_id = store
            .create_task(NewTask {
                label: "t".into(),
                schema_version: TASK_STORE_SCHEMA_VERSION,
            })
            .unwrap();
        store
            .append_segment(
                &task_id,
                Segment {
                    segment_id: "seg-1".into(),
                    session_id: "sess-1".into(),
                    turn_id: "turn-1".into(),
                },
            )
            .unwrap();
        store.mark_cancellation(&task_id).unwrap();
        // idempotent
        store.mark_cancellation(&task_id).unwrap();
    }

    #[test]
    fn orphan_checkpoint_is_rejected_by_foreign_keys() {
        let dir = owner_only_tempdir();
        let store = TaskStore::open(dir.path()).unwrap();
        // No create_task: this task_id has no parent row. With foreign_keys
        // enforced, the child insert must be rejected.
        let result = store.append_checkpoint(
            "no-such-task",
            Checkpoint {
                cursor: 1,
                payload: "orphan".into(),
            },
        );
        assert!(
            result.is_err(),
            "orphan checkpoint should be rejected by foreign key constraint"
        );
    }
}
