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

use crate::task_lifecycle::{SessionTurnEvidence, TaskState, control};

/// On-disk schema version for the durable task store.
///
/// Opening a store whose persisted version is newer than this constant fails
/// rather than attempting a silent migration (stale-resource behavior after a
/// host downgrade or partial upgrade).
pub const TASK_STORE_SCHEMA_VERSION: u32 = 2;

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

/// A task-level event appended to a task's monotonic event log.
///
/// Task-level events are the durable record that *links* a task's per-turn
/// execution segments together — e.g. a `"resumed"` or `"segment_started"`
/// event recorded when a long task is picked back up under a new turn. They
/// live at the task granularity (not the segment granularity) precisely so the
/// episode export can stitch the turn-segmented sections into one task episode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskEvent {
    /// Monotonic cursor for the event (1-based, assigned by [`TaskStore::append_event`]).
    pub cursor: i64,
    /// Stable event kind discriminator (e.g. `"resumed"`, `"segment_started"`).
    pub kind: String,
    /// Opaque event payload.
    pub payload: String,
}

/// One turn-bound section of a multi-turn task episode.
///
/// Finding 4: a long task spans multiple turns, accumulating one execution
/// segment per resume. Each [`EpisodeTurnSection`] is exactly one such segment,
/// so the episode is *segmented by turn*. Every section carries BOTH the
/// `task_id` and the active `turn_id` (and the owning `session_id`): at the
/// store/segment granularity this is how "all task actions/observations carry
/// both taskId and the active turnId" is expressed. The store deliberately does
/// not persist SDK observation ids (Finding 10), so the segment is the unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeTurnSection {
    /// The task this section belongs to.
    pub task_id: String,
    /// Session that owned the turn this section executed under.
    pub session_id: String,
    /// The active turn this section was bound to.
    pub turn_id: String,
    /// Stable identifier of the underlying execution segment.
    pub segment_id: String,
    /// Kernel generation recorded for the segment, if any.
    pub generation: Option<i64>,
}

/// A multi-turn task episode, segmented by turn and linked by task-level events.
///
/// Finding 4: a single long task spans several MCP turns. [`turns`] holds one
/// [`EpisodeTurnSection`] per execution segment, in resume order; [`events`]
/// holds the task-level events that link those per-turn sections into one
/// coherent episode.
///
/// [`turns`]: EpisodeExport::turns
/// [`events`]: EpisodeExport::events
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpisodeExport {
    /// The exported task.
    pub task_id: String,
    /// Per-turn sections in resume order (one per execution segment).
    pub turns: Vec<EpisodeTurnSection>,
    /// Task-level events linking the per-turn sections, in ascending cursor order.
    pub events: Vec<TaskEvent>,
}

/// A per-resume execution segment record.
///
/// Each segment marks one execution of a task bound to a single MCP turn: a
/// long task accumulates one segment per resume, so a task that runs across
/// several turns has several segments recorded in resume order.
#[derive(Debug, Clone)]
pub struct Segment {
    /// Stable identifier for the segment.
    pub segment_id: String,
    /// Session that owns the segment.
    pub session_id: String,
    /// Turn within the session.
    pub turn_id: String,
    /// Kernel generation in effect when this segment last ran, if recorded.
    ///
    /// `None` means the generation was not captured (older segments, or a
    /// segment recorded by [`Segment::new`]); resume cannot prove kernel
    /// continuity from such a segment (Finding 16) and must recover from the
    /// durable store with a fresh observation.
    pub generation: Option<i64>,
}

impl Segment {
    /// Create a segment bound to `session_id`/`turn_id`, generating a fresh
    /// random `segment_id`. Records no kernel generation (`generation: None`).
    pub fn new(session_id: impl Into<String>, turn_id: impl Into<String>) -> Self {
        Self {
            segment_id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            generation: None,
        }
    }

    /// Create a segment that records the kernel `generation` in effect when it
    /// ran, generating a fresh random `segment_id` (like [`Segment::new`]).
    ///
    /// The recorded generation lets a later resume detect a kernel reboot: if
    /// the current kernel generation differs, the prior in-memory SDK bindings
    /// are gone and resume must recover from the durable store (Finding 16).
    pub fn with_generation(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        generation: i64,
    ) -> Self {
        Self {
            segment_id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            generation: Some(generation),
        }
    }
}

/// A task loaded back from the durable store.
#[derive(Debug, Clone)]
pub struct LoadedTask {
    /// Task id.
    pub id: String,
    /// Human-meaningful label.
    pub label: String,
    /// Coarse task state. Persisted as a stable string (see
    /// [`TaskState::as_str`]) and parsed back on load.
    pub state: TaskState,
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

/// Record a fresh execution segment for a task resume, bound to the current
/// MCP turn.
///
/// Turn-authority gate: a resume may only record a segment when the current
/// request carries both a non-empty `session_id` and a non-empty `turn_id`.
/// This mirrors the dispatcher's `require_mutation_context` rule (which already
/// rejects mutating browser methods — including session-control resume —
/// without both ids) at the task-store level, so a resume cannot proceed to
/// record execution or take later browser side effects without turn authority.
/// On success the new [`Segment`] is appended and returned; on a missing/empty
/// id the call is rejected and no segment is appended.
pub fn record_resume_segment(
    store: &TaskStore,
    task_id: &str,
    session_id: Option<&str>,
    turn_id: Option<&str>,
) -> Result<Segment> {
    let session_id = session_id.unwrap_or_default();
    let turn_id = turn_id.unwrap_or_default();
    if session_id.is_empty() {
        bail!("missing session_id: resume requires turn authority");
    }
    if turn_id.is_empty() {
        bail!("missing turn_id: resume requires turn authority");
    }
    let segment = Segment::new(session_id, turn_id);
    store.append_segment(task_id, segment.clone())?;
    Ok(segment)
}

/// Plan for resuming a long task, derived from kernel-generation continuity.
///
/// Finding 16: the JS kernel carries a monotonically increasing *generation*
/// (surfaced by `browser_status.kernel_generation`). A change in that generation
/// means the kernel was rebooted, so every SDK in-memory observation and pointer
/// binding from the prior generation is gone. When continuity cannot be proven,
/// resume must NOT trust stale in-memory bindings: it has to rebuild from the
/// durable task store and allocate a fresh observation (which ties into Task
/// 5.6's process-local observation-id contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResumePlan {
    /// When `true`, resume must reconstruct execution state from the durable
    /// task store rather than from SDK in-memory bindings.
    pub recover_from_store: bool,
    /// When `true`, resume must allocate a fresh observation before taking
    /// browser side effects (prior-generation observation bindings are void).
    pub requires_fresh_observation: bool,
}

/// Decide how a task resume must recover, given the current kernel generation.
///
/// Compares the most recent execution segment's recorded kernel generation to
/// `current_kernel_generation`:
///
/// - last segment's generation is `Some(g)` and `g == current` → kernel
///   continuity holds → resume may continue from in-memory bindings
///   (`recover_from_store: false, requires_fresh_observation: false`).
/// - generation differs (`Some(g)`, `g != current`), is `None` (continuity
///   cannot be proven), or there are no segments at all → resume MUST recover
///   from the durable store and re-observe
///   (`recover_from_store: true, requires_fresh_observation: true`).
///
/// `current_kernel_generation` is a parameter precisely so the eventual
/// task-resume RPC handler can pass `browser_status`'s `kernel_generation`
/// (added by Task 1.2) straight through — no `TaskStore` is wired into the live
/// dispatcher request path here (that resume route is unbuilt; see the Task 5.7
/// scoping note).
///
/// Returns a [`ResumePlan`] directly (not a `Result`): on the unlikely event
/// that reading segments fails, it conservatively returns the recover-from-store
/// plan, which is the safe default — never resume from possibly-stale in-memory
/// bindings on a read error.
pub fn plan_task_resume(
    store: &TaskStore,
    task_id: &str,
    current_kernel_generation: i64,
) -> ResumePlan {
    // Safe default: recover from durable state + re-observe. Used for the
    // changed/unrecorded/no-segments cases and for a conservative read-error
    // fallback.
    let recover = ResumePlan {
        recover_from_store: true,
        requires_fresh_observation: true,
    };

    let segments = match store.segments(task_id) {
        Ok(segments) => segments,
        // Conservative: on a DB read error we cannot prove continuity. Surface
        // the error so an operator keeps the signal, then default to recovery.
        Err(e) => {
            tracing::warn!(
                task_id = %task_id,
                error = %e,
                "plan_task_resume: failed to read segments; defaulting to store recovery"
            );
            return recover;
        }
    };

    match segments.last().and_then(|seg| seg.generation) {
        Some(g) if g == current_kernel_generation => ResumePlan {
            recover_from_store: false,
            requires_fresh_observation: false,
        },
        // Generation differs, was never recorded (None), or no segments exist.
        _ => recover,
    }
}

/// Outcome of a [`cancel_task`] call.
///
/// Finding 9 splits the *task-record* cancellation (always performed: the task
/// reaches a terminal [`TaskState::Cancelled`]) from the *act* of releasing
/// browser resources (only authorized in trusted contexts). This struct carries
/// the cleanup *decision*: whether the caller is authorized to release tabs.
/// The actual CDP/tab-closing side effect lives in the dispatcher/backend and is
/// out of scope here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CleanupOutcome {
    /// Whether browser resources may be released as part of this cancellation.
    ///
    /// `false` when a human currently holds control (human takeover / yielded):
    /// cancellation records a terminal task state without releasing tabs while
    /// a human holds control (Finding 9). `true` in trusted contexts (trusted
    /// stop, host shutdown, repair, or explicit user-approved cleanup), encoded
    /// here as the absence of a human-present control state.
    pub cleaned_browser_resources: bool,
}

/// Returns whether browser cleanup is authorized given the session/turn
/// `evidence`.
///
/// Finding 9: cancellation records a terminal task state without releasing tabs
/// while a human holds control. Cleanup is therefore gated OFF when the
/// `control_state` projects a human-present state (`human_takeover` or
/// `yielded`), and authorized otherwise (trusted contexts: trusted stop, host
/// shutdown, repair, or explicit user-approved cleanup).
fn browser_cleanup_authorized(evidence: &SessionTurnEvidence) -> bool {
    !matches!(
        evidence.control_state.as_deref(),
        Some(control::HUMAN_TAKEOVER) | Some(control::YIELDED)
    )
}

/// Cancel a task: record a terminal task state and decide cleanup authority.
///
/// This SPLITS the task-record cancellation from the browser-cleanup act
/// (Finding 9):
///
/// 1. The task record is always driven to terminal [`TaskState::Cancelled`] and
///    a cancellation marker is recorded, stopping future side effects.
/// 2. Browser cleanup is only *authorized* in trusted contexts. While a human
///    holds control (human takeover / yielded), cleanup is gated OFF so tabs are
///    not closed/released out from under the human.
///
/// The returned [`CleanupOutcome::cleaned_browser_resources`] is the cleanup
/// *decision*, not the act: this store-level function holds no live browser
/// handle. The actual tab-closing belongs to the dispatcher/backend.
pub fn cancel_task(
    store: &TaskStore,
    task_id: &str,
    evidence: &SessionTurnEvidence,
) -> Result<CleanupOutcome> {
    // Record the terminal task state and the cancellation marker. The lifecycle
    // conceptually passes through Cancelling -> Cancelled; the store persists
    // the final terminal Cancelled state.
    store.mark_cancellation(task_id)?;
    store.set_state(task_id, TaskState::Cancelled)?;

    Ok(CleanupOutcome {
        cleaned_browser_resources: browser_cleanup_authorized(evidence),
    })
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
                 generation INTEGER,
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
                // Fresh db: the CREATE TABLE above already includes every
                // current-version column, so just record the current version.
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
                // v1 -> v2: a real v1 db created `task_segments` without the
                // `generation` column (the `CREATE TABLE IF NOT EXISTS` above is
                // a no-op against the existing table, so it does not backfill the
                // column). Add it exactly once, guarded strictly on `Some(1)` so
                // `ALTER TABLE ADD COLUMN` never runs against a table that
                // already has the column. Stays inside this transaction so the
                // ALTER and the version bump are atomic.
                if on_disk == 1 {
                    tx.execute_batch(
                        "ALTER TABLE task_segments ADD COLUMN generation INTEGER;",
                    )
                    .context("migrate task_segments: add generation column (v1->v2)")?;
                }
                if on_disk < TASK_STORE_SCHEMA_VERSION {
                    tx.execute(
                        "UPDATE meta SET value = ?1 WHERE key = 'schema_version'",
                        [TASK_STORE_SCHEMA_VERSION.to_string()],
                    )
                    .context("record migrated schema_version")?;
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
                    TaskState::Created.as_str(),
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

        let state: TaskState = state
            .parse()
            .with_context(|| format!("parse persisted task state for {task_id}"))?;

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
                "INSERT INTO task_segments (task_id, segment_id, session_id, turn_id, started_at, generation)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    task_id,
                    segment.segment_id,
                    segment.session_id,
                    segment.turn_id,
                    now_millis(),
                    segment.generation,
                ],
            )
            .context("insert segment")?;
        Ok(())
    }

    /// Return a task's execution segments in insertion (resume) order.
    ///
    /// Ordering is `started_at ASC, rowid ASC`: `started_at` is a millisecond
    /// timestamp that can collide for two fast appends, so the implicit
    /// `rowid` is the deterministic tiebreak that preserves insertion order.
    pub fn segments(&self, task_id: &str) -> Result<Vec<Segment>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT segment_id, session_id, turn_id, generation
                 FROM task_segments
                 WHERE task_id = ?1
                 ORDER BY started_at ASC, rowid ASC",
            )
            .context("prepare segments query")?;
        let rows = stmt
            .query_map([task_id], |row| {
                Ok(Segment {
                    segment_id: row.get(0)?,
                    session_id: row.get(1)?,
                    turn_id: row.get(2)?,
                    generation: row.get::<_, Option<i64>>(3)?,
                })
            })
            .context("query segments")?;
        let mut segments = Vec::new();
        for row in rows {
            segments.push(row.context("read segment row")?);
        }
        Ok(segments)
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

    /// Append a task-level event, assigning the next monotonic cursor.
    ///
    /// The cursor is `event_cursor(task_id) + 1` (1-based, gap-free for a single
    /// process), so the first event on a task gets cursor `1`. These task-level
    /// events are what *link* a long task's per-turn execution segments together
    /// (e.g. a `"resumed"` or `"segment_started"` marker) and are surfaced by
    /// [`TaskStore::export_episode`]. Returns the assigned cursor.
    pub fn append_event(&self, task_id: &str, kind: &str, payload: &str) -> Result<i64> {
        let cursor = self.event_cursor(task_id)? + 1;
        self.conn
            .execute(
                "INSERT INTO task_events (task_id, cursor, kind, payload, at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![task_id, cursor, kind, payload, now_millis()],
            )
            .context("insert task event")?;
        Ok(cursor)
    }

    /// Return a task's task-level events in ascending cursor order.
    pub fn events(&self, task_id: &str) -> Result<Vec<TaskEvent>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT cursor, kind, payload
                 FROM task_events
                 WHERE task_id = ?1
                 ORDER BY cursor ASC",
            )
            .context("prepare events query")?;
        let rows = stmt
            .query_map([task_id], |row| {
                Ok(TaskEvent {
                    cursor: row.get(0)?,
                    kind: row.get(1)?,
                    payload: row.get(2)?,
                })
            })
            .context("query events")?;
        let mut events = Vec::new();
        for row in rows {
            events.push(row.context("read event row")?);
        }
        Ok(events)
    }

    /// Export a long task as a turn-segmented episode.
    ///
    /// Finding 4: a long task spans multiple MCP turns, accumulating one
    /// execution segment per resume. This export is therefore *segmented by
    /// turn*: it reads the task's execution segments (in resume order) and
    /// emits one [`EpisodeTurnSection`] per segment, each tagged with the
    /// `task_id` and the active `(session_id, turn_id)` it ran under, then
    /// reads the task-level events that *link* those per-turn sections into one
    /// coherent episode. The store does not persist SDK observation ids
    /// (Finding 10), so the execution segment is the unit of turn-bound
    /// attribution.
    pub fn export_episode(&self, task_id: &str) -> Result<EpisodeExport> {
        let turns = self
            .segments(task_id)?
            .into_iter()
            .map(|seg| EpisodeTurnSection {
                task_id: task_id.to_string(),
                session_id: seg.session_id,
                turn_id: seg.turn_id,
                segment_id: seg.segment_id,
                generation: seg.generation,
            })
            .collect();
        let events = self.events(task_id)?;
        Ok(EpisodeExport {
            task_id: task_id.to_string(),
            turns,
            events,
        })
    }

    /// Update a task's persisted coarse state.
    ///
    /// Writes the stable string form (see [`TaskState::as_str`]) into the
    /// `tasks.state` column. Errors if the task row does not exist so a stray
    /// id cannot silently no-op.
    pub fn set_state(&self, task_id: &str, state: TaskState) -> Result<()> {
        let updated = self
            .conn
            .execute(
                "UPDATE tasks SET state = ?2 WHERE id = ?1",
                rusqlite::params![task_id, state.as_str()],
            )
            .context("update task state")?;
        if updated == 0 {
            bail!("task not found: {task_id}");
        }
        Ok(())
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

    /// Open a fresh store in an owner-only temp dir.
    ///
    /// Returns the `TempDir` alongside the store so the caller can bind it for
    /// the test scope: the `TaskStore` does not own the dir, so the dir must
    /// outlive it via RAII (dropping the dir removes the SQLite file).
    fn open_temp_store() -> (TaskStore, tempfile::TempDir) {
        let dir = owner_only_tempdir();
        let store = TaskStore::open(dir.path()).unwrap();
        (store, dir)
    }

    /// A default `NewTask` for tests that do not care about the label.
    fn default_new_task() -> NewTask {
        NewTask {
            label: "task".into(),
            schema_version: TASK_STORE_SCHEMA_VERSION,
        }
    }

    #[test]
    fn resume_appends_new_segment_with_current_turn() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        store.append_segment(&task_id, Segment::new("s1", "t1")).unwrap();
        // resume under a NEW turn
        store.append_segment(&task_id, Segment::new("s1", "t2")).unwrap();
        let segs = store.segments(&task_id).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs.last().unwrap().turn_id, "t2");
    }

    #[test]
    fn record_resume_segment_binds_to_current_turn_and_spans_turns() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();

        let first = record_resume_segment(&store, &task_id, Some("s1"), Some("t1")).unwrap();
        assert_eq!(first.session_id, "s1");
        assert_eq!(first.turn_id, "t1");

        // Resuming under a new turn appends a second segment: a single task
        // spans multiple turns, one segment per resume.
        let second = record_resume_segment(&store, &task_id, Some("s1"), Some("t2")).unwrap();
        assert_eq!(second.turn_id, "t2");
        assert_ne!(first.segment_id, second.segment_id);

        let segs = store.segments(&task_id).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].turn_id, "t1");
        assert_eq!(segs[1].turn_id, "t2");
    }

    #[test]
    fn record_resume_segment_rejects_missing_turn_authority() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();

        // No turn_id => no turn authority => rejected, no segment appended.
        assert!(record_resume_segment(&store, &task_id, Some("s1"), None).is_err());
        // Empty turn_id is also rejected.
        assert!(record_resume_segment(&store, &task_id, Some("s1"), Some("")).is_err());
        // Missing/empty session_id is rejected too.
        assert!(record_resume_segment(&store, &task_id, None, Some("t1")).is_err());
        assert!(record_resume_segment(&store, &task_id, Some(""), Some("t1")).is_err());

        assert_eq!(
            store.segments(&task_id).unwrap().len(),
            0,
            "rejected resume must not append a segment"
        );
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
                    generation: None,
                },
            )
            .unwrap();
        store.mark_cancellation(&task_id).unwrap();
        // idempotent
        store.mark_cancellation(&task_id).unwrap();
    }

    // Finding 9: cancellation records a terminal task state without releasing
    // tabs while a human holds control.
    #[test]
    fn cancel_during_human_takeover_does_not_clean_browser() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let cleanup =
            cancel_task(&store, &task_id, &SessionTurnEvidence::human_takeover()).unwrap();
        assert_eq!(store.load_task(&task_id).unwrap().state, TaskState::Cancelled);
        assert!(
            !cleanup.cleaned_browser_resources,
            "must not clean browser during human takeover"
        );
    }

    // Finding 9: in trusted contexts (no human-present control state) cancel is
    // authorized to release browser resources.
    #[test]
    fn cancel_in_trusted_context_authorizes_browser_cleanup() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        // Default evidence carries no human-present control_state => trusted.
        let cleanup = cancel_task(&store, &task_id, &SessionTurnEvidence::default()).unwrap();
        assert_eq!(store.load_task(&task_id).unwrap().state, TaskState::Cancelled);
        assert!(
            cleanup.cleaned_browser_resources,
            "trusted-context cancel must authorize browser cleanup"
        );
    }

    // A voluntarily yielded human-present state is also gated off.
    #[test]
    fn cancel_during_yielded_does_not_clean_browser() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let yielded = SessionTurnEvidence {
            control_state: Some(control::YIELDED.into()),
            ..Default::default()
        };
        let cleanup = cancel_task(&store, &task_id, &yielded).unwrap();
        assert_eq!(store.load_task(&task_id).unwrap().state, TaskState::Cancelled);
        assert!(
            !cleanup.cleaned_browser_resources,
            "must not clean browser while a human holds control (yielded)"
        );
    }

    // Finding 16: a kernel-generation change means the JS kernel was rebooted,
    // so any SDK in-memory observation/pointer bindings from the prior
    // generation are gone -> resume must rebuild from the durable store and
    // allocate a fresh observation.
    #[test]
    fn resume_recovers_from_store_when_kernel_generation_changed() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        store
            .append_segment(&task_id, Segment::with_generation("s1", "t1", 3))
            .unwrap();
        let plan = plan_task_resume(&store, &task_id, /* current_kernel_generation */ 5);
        assert!(
            plan.recover_from_store,
            "generation changed -> must recover from durable state"
        );
        assert!(plan.requires_fresh_observation);
    }

    #[test]
    fn resume_continues_in_memory_when_kernel_generation_matches() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        store
            .append_segment(&task_id, Segment::with_generation("s1", "t1", 5))
            .unwrap();
        let plan = plan_task_resume(&store, &task_id, 5);
        assert!(
            !plan.recover_from_store,
            "matching generation -> continuity holds, resume from in-memory bindings"
        );
        assert!(!plan.requires_fresh_observation);
    }

    #[test]
    fn resume_recovers_from_store_when_generation_unrecorded() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        // Segment::new records no generation: continuity cannot be proven.
        store.append_segment(&task_id, Segment::new("s1", "t1")).unwrap();
        let plan = plan_task_resume(&store, &task_id, 5);
        assert!(plan.recover_from_store);
        assert!(plan.requires_fresh_observation);
    }

    #[test]
    fn resume_recovers_from_store_when_no_segments() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let plan = plan_task_resume(&store, &task_id, 5);
        assert!(plan.recover_from_store);
        assert!(plan.requires_fresh_observation);
    }

    #[test]
    fn fresh_db_round_trips_segment_generation() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        store
            .append_segment(&task_id, Segment::with_generation("s1", "t1", 7))
            .unwrap();
        store.append_segment(&task_id, Segment::new("s1", "t2")).unwrap();
        let segs = store.segments(&task_id).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].generation, Some(7));
        assert_eq!(segs[1].generation, None);
    }

    // v1->v2 migration: an existing v1-shaped db (task_segments created WITHOUT
    // the generation column, meta version '1') must open, get the column added,
    // record version 2, and load its pre-existing segment with generation None.
    #[test]
    fn opens_and_migrates_v1_database() {
        let dir = owner_only_tempdir();
        let db_path = dir.path().join("tasks.db");
        // Construct a v1-shaped db by hand.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE tasks (
                     id             TEXT PRIMARY KEY,
                     label          TEXT NOT NULL,
                     state          TEXT NOT NULL,
                     schema_version INTEGER NOT NULL,
                     created_at     INTEGER NOT NULL
                 );
                 CREATE TABLE task_segments (
                     task_id    TEXT NOT NULL,
                     segment_id TEXT NOT NULL,
                     session_id TEXT NOT NULL,
                     turn_id    TEXT NOT NULL,
                     started_at INTEGER NOT NULL,
                     PRIMARY KEY (task_id, segment_id)
                 );
                 INSERT INTO meta (key, value) VALUES ('schema_version', '1');
                 INSERT INTO tasks (id, label, state, schema_version, created_at)
                     VALUES ('task-1', 'l', 'created', 1, 0);
                 INSERT INTO task_segments (task_id, segment_id, session_id, turn_id, started_at)
                     VALUES ('task-1', 'seg-1', 's1', 't1', 0);",
            )
            .unwrap();
        }

        let store = TaskStore::open(dir.path()).unwrap();
        let version: String = store
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, TASK_STORE_SCHEMA_VERSION.to_string());
        let segs = store.segments("task-1").unwrap();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].segment_id, "seg-1");
        assert_eq!(
            segs[0].generation, None,
            "pre-existing v1 segment has no recorded generation after migration"
        );
    }

    // Finding 4: a long task spans multiple turns (one segment per resume), so
    // its episode export is segmented by turn: one section per `(session,turn)`
    // segment, in resume order, linked by task-level events. Every section
    // carries both the `task_id` and the active `turn_id`.
    #[test]
    fn task_spanning_two_turns_exports_two_turn_segmented_sections() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();

        // Two turns: one segment per resume.
        store.append_segment(&task_id, Segment::new("s1", "t1")).unwrap();
        store.append_segment(&task_id, Segment::new("s1", "t2")).unwrap();

        // A task-level linking event spanning the segments.
        let cursor = store.append_event(&task_id, "resumed", "to t2").unwrap();
        assert_eq!(cursor, 1);

        let ep = store.export_episode(&task_id).unwrap();

        // One turn-segmented section per segment, in resume order.
        assert_eq!(ep.turns.len(), 2);
        assert_eq!(ep.turns[0].turn_id, "t1");
        assert_eq!(ep.turns[1].turn_id, "t2");

        // Every section carries both the task_id and a non-empty active turn_id.
        for section in &ep.turns {
            assert_eq!(section.task_id, task_id, "section must carry task_id");
            assert!(!section.turn_id.is_empty(), "section must carry active turn_id");
        }

        // Task-level linking events are exported alongside the sections.
        assert!(ep.events.len() >= 1, "linking events must be exported");
        assert!(
            ep.events
                .iter()
                .any(|e| e.kind == "resumed" && e.payload == "to t2"),
            "exported events must contain the appended task-level link"
        );
        assert_eq!(ep.task_id, task_id);
    }

    #[test]
    fn append_event_assigns_monotonic_cursors() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();

        let c1 = store.append_event(&task_id, "segment_started", "a").unwrap();
        let c2 = store.append_event(&task_id, "resumed", "b").unwrap();
        assert_eq!(c1, 1);
        assert_eq!(c2, 2);

        let events = store.events(&task_id).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].cursor, 1);
        assert_eq!(events[0].kind, "segment_started");
        assert_eq!(events[0].payload, "a");
        assert_eq!(events[1].cursor, 2);
        assert_eq!(events[1].kind, "resumed");
        assert_eq!(events[1].payload, "b");
    }

    #[test]
    fn export_episode_of_task_without_segments_has_no_turns() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let ep = store.export_episode(&task_id).unwrap();
        assert_eq!(ep.task_id, task_id);
        assert_eq!(ep.turns.len(), 0);
        assert_eq!(ep.events.len(), 0);
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
