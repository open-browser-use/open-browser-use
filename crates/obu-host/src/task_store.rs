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

use crate::task_lifecycle::{ControlProjection, SessionTurnEvidence, TaskState};

/// On-disk schema version for the durable task store.
///
/// Opening a store whose persisted version is newer than this constant fails
/// rather than attempting a silent migration (stale-resource behavior after a
/// host downgrade or partial upgrade).
pub const TASK_STORE_SCHEMA_VERSION: u32 = 4;

/// Summary of a task's most recent execution segment, for task listings.
///
/// Finding 5 (wire shape): this DTO is serialized by Task 8's task-list RPC, so
/// it derives `serde::Serialize` with camelCase field renaming. Without the
/// derive Task 8 cannot compile; without camelCase the wire silently emits
/// snake_case keys instead of `segmentId`/`sessionId`/`turnId`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastSegmentSummary {
    /// Stable identifier of the segment.
    pub segment_id: String,
    /// Session that owned the segment.
    pub session_id: String,
    /// Turn the segment executed under.
    pub turn_id: String,
    /// Kernel generation recorded for the segment, if any.
    pub generation: Option<i64>,
}

/// A row in a filtered/paginated task listing.
///
/// Finding 5 (wire shape): serialized by Task 8's task-list RPC with camelCase
/// field renaming (`taskId`/`schemaVersion`/`segmentCount`/...). The
/// `segment_count` and `event_cursor` are computed by correlated subqueries in
/// [`TaskStore::list_tasks`] (Finding 4) so a multi-segment, multi-event task is
/// not cartesian-overcounted.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    /// Task id.
    pub task_id: String,
    /// Human-meaningful label.
    pub label: String,
    /// Coarse task state (stable string form).
    pub state: String,
    /// Schema version recorded on the row.
    pub schema_version: u32,
    /// Creation timestamp (unix millis).
    pub created_at: i64,
    /// Number of execution segments recorded for the task.
    pub segment_count: i64,
    /// Highest task-level event cursor (0 if no events).
    pub event_cursor: i64,
    /// The task's most recent execution segment, if any.
    pub last_segment: Option<LastSegmentSummary>,
}

/// Filter + pagination for [`TaskStore::list_tasks`].
///
/// Finding 4: `state` is an `IN (...)` filter, `scope_session_id` restricts to
/// tasks bound to a session via `task_session_bindings`, and `limit` defaults to
/// 100 when `<= 0` and is clamped to `[1, 500]`.
#[derive(Debug, Clone, Default)]
pub struct TaskListFilter {
    /// Optional set of states to include (`tasks.state IN (...)`).
    pub state: Option<Vec<String>>,
    /// Page size; `<= 0` defaults to 100, then clamped to `[1, 500]`.
    pub limit: i64,
    /// Optional session scope: only tasks bound to this session.
    pub scope_session_id: Option<String>,
}

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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
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
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
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

/// Outcome of [`TaskStore::begin_resume_attempt`].
///
/// `resume_token` is `Some` **only** when this call created a fresh attempt: the
/// store never re-derives a wire token for an already-pending attempt (it only
/// persists the token's SHA-256 hash, never the raw token), so an idempotent
/// retry returns `resume_token: None`. `created` records whether this call
/// inserted a new attempt (and therefore appended a `resume_attempt_started`
/// event) versus matched an existing pending attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeAttemptBegin {
    /// Stable id of the (new or existing) pending attempt.
    pub attempt_id: String,
    /// Raw wire token, present only when this call created the attempt.
    pub resume_token: Option<String>,
    /// Attempt expiry (unix millis).
    pub expires_at: i64,
    /// Whether this call created a new attempt (vs. matched an existing one).
    pub created: bool,
}

/// The single active execution owner of a task, if one is currently attached.
///
/// At most one owner exists per task (the `task_execution_owners.task_id`
/// primary key), so a task that has crossed into execution has exactly one
/// owning `(session_id, turn_id)` and segment, attributed to the attempt that
/// attached it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveExecutionOwner {
    /// Owned task.
    pub task_id: String,
    /// Attempt that attached this owner.
    pub attempt_id: String,
    /// Session that owns the active execution.
    pub session_id: String,
    /// Turn that owns the active execution.
    pub turn_id: String,
    /// Segment recorded for the active execution.
    pub segment_id: String,
}

/// Outcome of [`TaskStore::complete_resume_attached`].
///
/// Carries the (idempotently created) execution [`Segment`] the attempt attached
/// to, plus the attempt/task ids for the caller to record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeAttachedOutcome {
    /// Attempt that attached.
    pub attempt_id: String,
    /// Task the attempt belongs to.
    pub task_id: String,
    /// Execution segment the attempt attached to.
    pub segment: Segment,
}

/// A pending resume attempt for a task.
///
/// The partial unique index `idx_task_resume_attempts_pending` guarantees at
/// most one `status='pending'` row per task, so this is the at-most-one
/// outstanding attempt that [`TaskStore::begin_resume_attempt`] reconciles
/// against for idempotency and cross-session conflict detection.
///
/// Private: produced only by the private `pending_resume_attempt` and consumed
/// only inside `begin_resume_attempt` (same module), so it is not part of the
/// crate's public surface.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingResumeAttempt {
    attempt_id: String,
    session_id: String,
    turn_id: String,
    expires_at: i64,
}

/// A resume attempt resolved by token for completion (attach/block).
///
/// Used internally by [`TaskStore::complete_resume_attached`] and
/// [`TaskStore::complete_resume_blocked`]: it carries the attempt's identity and
/// owning `(session_id, turn_id)` so the caller can materialize the turn segment
/// and execution owner. The attempt's stored `generation` is intentionally not
/// surfaced: attach uses the caller-supplied current generation (the live kernel
/// generation), not the one recorded when the attempt began.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AttachableAttempt {
    attempt_id: String,
    task_id: String,
    session_id: String,
    turn_id: String,
}

/// Generate a fresh raw resume token (a random UUIDv4 in simple/hyphenless form).
fn resume_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Hash a raw resume token for at-rest storage.
///
/// The store persists only this SHA-256 hex digest in
/// `task_resume_attempts.token_hash`; the raw token is never written to disk, so
/// a leaked database cannot be used to forge a resume.
fn token_hash(token: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(token.as_bytes());
    format!("{digest:x}")
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

/// Current unix time in milliseconds (0 on a pre-epoch clock).
///
/// `pub(crate)` so the task-store actor can stamp typed evidence events (e.g.
/// the `tabs_finalized`/`turn_ended` `at` field) with the same clock the store
/// uses for its row timestamps.
pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn sqlite_limit(limit: usize) -> i64 {
    i64::try_from(limit).unwrap_or(i64::MAX)
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
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
/// `current_kernel_generation` is a parameter so the live task-resume RPC
/// handler can pass `browser_status`'s `kernel_generation` straight through.
/// The resume route IS wired: `task_store_actor::resume_begin` calls this
/// function and returns the resulting [`ResumePlan`] to the SDK.
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
        evidence.control_state,
        Some(ControlProjection::HumanTakeover) | Some(ControlProjection::Yielded)
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
        // §2.2: enable incremental auto-vacuum so deleted pages join a free-list
        // that `incremental_vacuum` can reclaim. SQLite only honours an
        // auto_vacuum mode change made BEFORE any table is created (a fresh db),
        // OR after a full `VACUUM`. We set it before `setup_schema` (correct for a
        // fresh db) and read it back; if a pre-existing db is still on mode 0
        // (`NONE`), a one-time `VACUUM` converts its free-list so future
        // `incremental_vacuum` calls reclaim space.
        conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")
            .context("set auto_vacuum=INCREMENTAL")?;
        let auto_vacuum: i64 = conn
            .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
            .context("read auto_vacuum mode")?;
        if auto_vacuum != 2 {
            conn.execute_batch("VACUUM")
                .context("convert existing db to incremental auto_vacuum")?;
        }

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
                 segment_seq INTEGER,
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
             );
             CREATE TABLE IF NOT EXISTS task_session_bindings (
                 session_id TEXT PRIMARY KEY,
                 task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS task_turn_bindings (
                 session_id TEXT NOT NULL,
                 turn_id    TEXT NOT NULL,
                 task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 segment_id TEXT NOT NULL,
                 source     TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 PRIMARY KEY (session_id, turn_id),
                 UNIQUE (task_id, session_id, turn_id)
             );
             CREATE TABLE IF NOT EXISTS task_resume_attempts (
                 attempt_id     TEXT PRIMARY KEY,
                 task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                 session_id     TEXT NOT NULL,
                 turn_id        TEXT NOT NULL,
                 token_hash     TEXT NOT NULL,
                 status         TEXT NOT NULL,
                 generation     INTEGER NOT NULL,
                 created_at     INTEGER NOT NULL,
                 expires_at     INTEGER NOT NULL,
                 completed_at   INTEGER,
                 segment_id     TEXT,
                 terminal_error TEXT
             );
             CREATE TABLE IF NOT EXISTS task_execution_owners (
                 task_id    TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
                 attempt_id TEXT NOT NULL REFERENCES task_resume_attempts(attempt_id) ON DELETE CASCADE,
                 session_id TEXT NOT NULL,
                 turn_id    TEXT NOT NULL,
                 segment_id TEXT NOT NULL,
                 started_at INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_task_resume_attempts_pending
             ON task_resume_attempts(task_id)
             WHERE status = 'pending';",
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
                    tx.execute_batch("ALTER TABLE task_segments ADD COLUMN generation INTEGER;")
                        .context("migrate task_segments: add generation column (v1->v2)")?;
                }
                // v2 -> v3 (Finding 3): the brand-new v3 binding/resume tables are
                // created by the `CREATE TABLE IF NOT EXISTS` batch above. But the
                // pre-existing `task_segments` table may hold duplicate
                // `(task_id, session_id, turn_id)` rows that would make the new
                // UNIQUE index fail to build. Remove duplicates (keep the earliest
                // row per group by MIN(rowid)) BEFORE the index is created below.
                // Guarded on `on_disk < 3` so it only runs for stores predating v3.
                if on_disk < 3 {
                    tx.execute_batch(
                        "DELETE FROM task_segments
                         WHERE rowid NOT IN (
                             SELECT MIN(rowid)
                             FROM task_segments
                             GROUP BY task_id, session_id, turn_id
                         );",
                    )
                    .context(
                        "migrate task_segments: remove duplicate task/session/turn rows (v3)",
                    )?;
                }
                // v3 -> v4 (audit §2.2 review): prior segment recency queries
                // used `rowid` as the millisecond-timestamp tiebreak. SQLite
                // cannot index `rowid` in a CREATE INDEX statement, so expose a
                // real sequence column and backfill it from the historical rowid
                // to preserve existing insertion order.
                if on_disk < 4 {
                    tx.execute_batch(
                        "ALTER TABLE task_segments ADD COLUMN segment_seq INTEGER;
                         UPDATE task_segments SET segment_seq = rowid WHERE segment_seq IS NULL;",
                    )
                    .context("migrate task_segments: add segment sequence (v4)")?;
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

        // Finding 3: create the UNIQUE index on the pre-existing `task_segments`
        // table AFTER the version-resolution `match` so it runs for BOTH a fresh
        // db and a migrated one (the migration arm above has already removed any
        // duplicate `(task_id, session_id, turn_id)` rows that would make this
        // fail). It is intentionally NOT in the initial `CREATE TABLE` batch:
        // building it there would fail on open against an existing store with
        // duplicates. Inside the same `tx`, so it commits atomically below.
        tx.execute_batch(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_segments_task_session_turn
             ON task_segments(task_id, session_id, turn_id);
             CREATE INDEX IF NOT EXISTS idx_task_segments_task_started_seq
             ON task_segments(task_id, started_at ASC, segment_seq ASC);
             CREATE INDEX IF NOT EXISTS idx_tasks_terminal_created
             ON tasks(created_at ASC, id ASC)
             WHERE state IN ('completed', 'cancelled', 'failed');",
        )
        .context("create task store indexes")?;

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
                "INSERT INTO task_segments
                 (task_id, segment_id, session_id, turn_id, started_at, generation, segment_seq)
                 VALUES (
                     ?1, ?2, ?3, ?4, ?5, ?6,
                     COALESCE((SELECT MAX(segment_seq) FROM task_segments WHERE task_id = ?1), 0) + 1
                 )",
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
    /// Ordering is `started_at ASC, segment_seq ASC`: `started_at` is a
    /// millisecond timestamp that can collide for two fast appends, so
    /// `segment_seq` is the deterministic, indexable tiebreak that preserves
    /// insertion order.
    pub fn segments(&self, task_id: &str) -> Result<Vec<Segment>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT segment_id, session_id, turn_id, generation
                 FROM task_segments
                 WHERE task_id = ?1
                 ORDER BY started_at ASC, segment_seq ASC",
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
    ///
    /// The `event_cursor + 1` assignment assumes single-writer ownership of the
    /// store (one `&self` connection, owner-local, single-process), which is what
    /// makes the cursor sequence gap-free. If a second writer ever raced, the
    /// `PRIMARY KEY (task_id, cursor)` constraint surfaces the collision as an
    /// INSERT error rather than silent corruption.
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

    /// Read a task's persisted coarse state. Errors if the row does not exist.
    pub fn task_state(&self, task_id: &str) -> Result<TaskState> {
        let raw: String = self
            .conn
            .query_row("SELECT state FROM tasks WHERE id = ?1", [task_id], |row| {
                row.get(0)
            })
            .optional()
            .context("query task state")?
            .ok_or_else(|| anyhow::anyhow!("task not found: {task_id}"))?;
        raw.parse()
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

    /// Whether a task row exists for `task_id`.
    pub fn task_exists(&self, task_id: &str) -> Result<bool> {
        let exists: Option<i64> = self
            .conn
            .query_row("SELECT 1 FROM tasks WHERE id = ?1", [task_id], |row| {
                row.get(0)
            })
            .optional()
            .context("check task exists")?;
        Ok(exists.is_some())
    }

    /// Delete terminal tasks older than `window_ms` (audit §2.2).
    ///
    /// Removes every task in a *canonical terminal* state — `completed` /
    /// `cancelled` / `failed`, the three FROZEN `TaskState::as_str` literals that
    /// `allowed_transitions` maps to an empty slice (`task_lifecycle.rs`) — whose
    /// `created_at` is more than `window_ms` in the past. All child rows
    /// (segments, checkpoints, events, resources, bindings, resume attempts,
    /// execution owners) are removed automatically by the existing
    /// `ON DELETE CASCADE` foreign keys. Non-terminal tasks are never touched —
    /// in particular `blocked` is recoverable (it re-enters via `resuming`), so it
    /// is deliberately excluded. Returns the number of `tasks` rows deleted.
    /// Callers pass a non-negative `window_ms`.
    pub fn prune_terminal_tasks(&self, window_ms: i64) -> Result<usize> {
        self.prune_terminal_tasks_limited(window_ms, usize::MAX)
    }

    /// Delete up to `limit` terminal tasks older than `window_ms` (audit §2.2).
    ///
    /// This is the actor-maintenance entry point: it keeps a single maintenance
    /// tick from materializing or deleting an unbounded task set.
    pub fn prune_terminal_tasks_limited(&self, window_ms: i64, limit: usize) -> Result<usize> {
        if limit == 0 {
            return Ok(0);
        }
        let cutoff = now_millis() - window_ms;
        let deleted = self
            .conn
            .execute(
                "DELETE FROM tasks
                 WHERE id IN (
                     SELECT id
                     FROM tasks
                     WHERE state IN ('completed', 'cancelled', 'failed')
                       AND created_at < ?1
                     ORDER BY created_at ASC, id ASC
                     LIMIT ?2
                 )",
                rusqlite::params![cutoff, sqlite_limit(limit)],
            )
            .context("prune terminal tasks")?;
        Ok(deleted)
    }

    /// Cap a single task's durable event log to its `cap` most recent cursors
    /// (audit §2.2).
    ///
    /// Deletes the lowest-cursor `task_events` rows so at most `cap` remain,
    /// preserving the newest events and the monotonic `MAX(cursor)` that
    /// `append_event` reads to assign the next cursor. Returns the number of rows
    /// removed. A `cap` of 0 clears the log.
    pub fn cap_task_events(&self, task_id: &str, cap: i64) -> Result<usize> {
        let removed = self
            .conn
            .execute(
                "DELETE FROM task_events
                 WHERE task_id = ?1
                   AND cursor <= (
                       SELECT MAX(cursor) FROM task_events WHERE task_id = ?1
                   ) - ?2",
                rusqlite::params![task_id, cap],
            )
            .context("cap task events")?;
        Ok(removed)
    }

    /// Return up to `limit` task ids after `after_task_id`, ordered by id.
    ///
    /// The maintenance actor uses this as a stable in-memory cursor over bounded passes.
    /// Ordering by the immutable primary key avoids an unbounded OFFSET scan and
    /// keeps pagination stable even when tasks are inserted or pruned.
    pub(crate) fn task_ids_after(
        &self,
        after_task_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<String>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let limit = sqlite_limit(limit);
        let mut stmt = self
            .conn
            .prepare(match after_task_id {
                Some(_) => "SELECT id FROM tasks WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
                None => "SELECT id FROM tasks ORDER BY id ASC LIMIT ?1",
            })
            .context("prepare task id query")?;
        let mut task_ids = Vec::new();
        if let Some(after_task_id) = after_task_id {
            let rows = stmt
                .query_map(rusqlite::params![after_task_id, limit], |row| {
                    row.get::<_, String>(0)
                })
                .context("query paged task ids")?;
            for row in rows {
                task_ids.push(row.context("read task id")?);
            }
            return Ok(task_ids);
        }
        let rows = stmt
            .query_map([limit], |row| row.get::<_, String>(0))
            .context("query task ids")?;
        for row in rows {
            task_ids.push(row.context("read task id")?);
        }
        Ok(task_ids)
    }

    /// Cap a single task's execution segments to its most recent `cap` rows
    /// (audit §2.2).
    ///
    /// The active execution-owner segment is exempt even if it is older than the
    /// cap, because deleting the live authority row would make resume planning
    /// under-report the current browser attachment. Turn bindings for deleted
    /// segments are removed with the segment rows so old `(session, turn)` pairs
    /// no longer point at non-existent segment ids.
    pub fn cap_task_segments(&self, task_id: &str, cap: i64) -> Result<usize> {
        let tx = self
            .conn
            .unchecked_transaction()
            .context("begin cap task segments transaction")?;
        tx.execute(
            "DELETE FROM task_turn_bindings
             WHERE task_id = ?1
               AND segment_id NOT IN (
                   SELECT segment_id FROM (
                       SELECT segment_id
                       FROM task_segments
                       WHERE task_id = ?1
                       ORDER BY started_at DESC, segment_seq DESC
                       LIMIT ?2
                   )
                   UNION
                   SELECT segment_id
                   FROM task_execution_owners
                   WHERE task_id = ?1
               )",
            rusqlite::params![task_id, cap],
        )
        .context("delete capped segment turn bindings")?;
        let removed = tx
            .execute(
                "DELETE FROM task_segments
                 WHERE task_id = ?1
                   AND segment_id NOT IN (
                       SELECT segment_id FROM (
                           SELECT segment_id
                           FROM task_segments
                           WHERE task_id = ?1
                           ORDER BY started_at DESC, segment_seq DESC
                           LIMIT ?2
                       )
                       UNION
                       SELECT segment_id
                       FROM task_execution_owners
                       WHERE task_id = ?1
                   )",
                rusqlite::params![task_id, cap],
            )
            .context("cap task segments")?;
        tx.commit()
            .context("commit cap task segments transaction")?;
        Ok(removed)
    }

    /// Reclaim free-list pages produced by retention deletes (audit §2.2).
    ///
    /// A thin wrapper over `PRAGMA incremental_vacuum` (a no-op unless
    /// `auto_vacuum=INCREMENTAL` is in effect, which `open` ensures). Cheap to
    /// call after a retention pass.
    pub fn incremental_vacuum(&self) -> Result<()> {
        self.conn
            .execute_batch("PRAGMA incremental_vacuum")
            .context("incremental vacuum")?;
        Ok(())
    }

    /// Backdate a task's `created_at` for retention tests (no production caller).
    ///
    /// `#[doc(hidden)]` and intended only for unit tests that need a task to fall
    /// outside the retention window without sleeping.
    #[doc(hidden)]
    pub fn set_task_created_at_for_test(&self, task_id: &str, created_at: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE tasks SET created_at = ?2 WHERE id = ?1",
                rusqlite::params![task_id, created_at],
            )
            .context("backdate task created_at")?;
        Ok(())
    }

    /// Resolve the task currently bound to `session_id`, if any.
    pub fn task_for_session(&self, session_id: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT task_id FROM task_session_bindings WHERE session_id = ?1",
                [session_id],
                |row| row.get(0),
            )
            .optional()
            .context("query task for session")
    }

    /// Resolve the task bound to a specific `(session_id, turn_id)`, if any.
    pub fn task_for_turn(&self, session_id: &str, turn_id: &str) -> Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT task_id FROM task_turn_bindings WHERE session_id = ?1 AND turn_id = ?2",
                rusqlite::params![session_id, turn_id],
                |row| row.get(0),
            )
            .optional()
            .context("query task for turn")
    }

    /// Look up the execution segment for a specific `(task_id, session_id, turn_id)`.
    ///
    /// Returns the matching [`Segment`] or `None`. The `(task_id, session_id,
    /// turn_id)` triple is unique (the v3 `idx_task_segments_task_session_turn`
    /// index), so at most one row matches.
    fn segment_for_turn(
        &self,
        task_id: &str,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Option<Segment>> {
        self.conn
            .query_row(
                "SELECT segment_id, session_id, turn_id, generation
                 FROM task_segments
                 WHERE task_id = ?1 AND session_id = ?2 AND turn_id = ?3",
                rusqlite::params![task_id, session_id, turn_id],
                |row| {
                    Ok(Segment {
                        segment_id: row.get(0)?,
                        session_id: row.get(1)?,
                        turn_id: row.get(2)?,
                        generation: row.get::<_, Option<i64>>(3)?,
                    })
                },
            )
            .optional()
            .context("query segment for turn")
    }

    /// Ensure exactly one execution segment exists for `(task_id, session_id,
    /// turn_id)`, returning it.
    ///
    /// Idempotent: re-calling with the same triple returns the existing segment
    /// (same `segment_id`). A `(session_id, turn_id)` is owned by at most one
    /// task; ensuring a segment for a turn already bound to a *different* task is
    /// rejected with `task_turn_conflict`. On first creation the segment is
    /// appended and the turn binding is recorded (source `ensure_turn_segment`).
    pub fn ensure_turn_segment(
        &self,
        task_id: &str,
        session_id: &str,
        turn_id: &str,
        generation: Option<i64>,
    ) -> Result<Segment> {
        if session_id.is_empty() || turn_id.is_empty() {
            bail!("missing session_id or turn_id");
        }
        if let Some(existing_task) = self.task_for_turn(session_id, turn_id)? {
            if existing_task != task_id {
                bail!("task_turn_conflict");
            }
        }
        if let Some(segment) = self.segment_for_turn(task_id, session_id, turn_id)? {
            return Ok(segment);
        }
        let segment = match generation {
            Some(value) => Segment::with_generation(session_id, turn_id, value),
            None => Segment::new(session_id, turn_id),
        };
        self.append_segment(task_id, segment.clone())?;
        self.bind_turn_task(
            session_id,
            turn_id,
            task_id,
            &segment.segment_id,
            "ensure_turn_segment",
        )?;
        Ok(segment)
    }

    /// Bind `session_id` to `task_id` (upsert), recording the bind time.
    pub fn bind_session_task(&self, session_id: &str, task_id: &str) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO task_session_bindings (session_id, task_id, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET task_id = excluded.task_id, updated_at = excluded.updated_at",
                rusqlite::params![session_id, task_id, now_millis()],
            )
            .context("bind session task")?;
        Ok(())
    }

    /// Bind a `(session_id, turn_id)` to `task_id`/`segment_id` (upsert),
    /// recording `source` and the bind time.
    pub fn bind_turn_task(
        &self,
        session_id: &str,
        turn_id: &str,
        task_id: &str,
        segment_id: &str,
        source: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO task_turn_bindings (session_id, turn_id, task_id, segment_id, source, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(session_id, turn_id) DO UPDATE SET
                     task_id = excluded.task_id,
                     segment_id = excluded.segment_id,
                     source = excluded.source,
                     created_at = excluded.created_at",
                rusqlite::params![session_id, turn_id, task_id, segment_id, source, now_millis()],
            )
            .context("bind turn task")?;
        Ok(())
    }

    /// Append a typed task-level event, enforcing that the JSON payload's
    /// `"kind"` field matches `kind`.
    ///
    /// The payload's `kind` discriminator must equal the `kind` argument so the
    /// stored event row and its JSON body cannot disagree; on mismatch the call
    /// is rejected with `task event kind mismatch`. Returns the assigned
    /// monotonic cursor (delegates to [`TaskStore::append_event`]).
    pub fn append_typed_event(
        &self,
        task_id: &str,
        kind: &str,
        payload: serde_json::Value,
    ) -> Result<i64> {
        if payload.get("kind").and_then(serde_json::Value::as_str) != Some(kind) {
            bail!("task event kind mismatch");
        }
        self.append_event(
            task_id,
            kind,
            &serde_json::to_string(&payload).context("serialize task event payload")?,
        )
    }

    /// Summarize a task's most recent execution segment, if any.
    ///
    /// "Most recent" mirrors [`TaskStore::segments`] ordering (`started_at`,
    /// `segment_seq` ascending), so the last segment is the highest
    /// `(started_at, segment_seq)` — selected here by ordering descending and
    /// taking the first row.
    fn last_segment_summary(&self, task_id: &str) -> Result<Option<LastSegmentSummary>> {
        self.conn
            .query_row(
                "SELECT segment_id, session_id, turn_id, generation
                 FROM task_segments
                 WHERE task_id = ?1
                 ORDER BY started_at DESC, segment_seq DESC
                 LIMIT 1",
                [task_id],
                |row| {
                    Ok(LastSegmentSummary {
                        segment_id: row.get(0)?,
                        session_id: row.get(1)?,
                        turn_id: row.get(2)?,
                        generation: row.get::<_, Option<i64>>(3)?,
                    })
                },
            )
            .optional()
            .context("query last segment summary")
    }

    /// List tasks with optional `state`/`scope_session_id` filters and pagination.
    ///
    /// Finding 4: `state` is applied as `tasks.state IN (...)`,
    /// `scope_session_id` restricts to tasks bound to that session via
    /// `task_session_bindings`, `limit` defaults to 100 when `<= 0` and is
    /// clamped to `[1, 500]`, and `segment_count`/`event_cursor` are computed via
    /// CORRELATED SUBQUERIES (not a `task_segments × task_events` join + COUNT,
    /// which would cartesian-product and overcount). Rows are ordered newest
    /// first (`created_at DESC, id ASC`). The most-recent segment is attached per
    /// row via [`TaskStore::last_segment_summary`].
    pub fn list_tasks(&self, filter: TaskListFilter) -> Result<Vec<TaskSummary>> {
        let requested = if filter.limit <= 0 { 100 } else { filter.limit };
        let limit = requested.clamp(1, 500);

        let mut where_clauses: Vec<String> = Vec::new();
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(states) = filter.state.as_ref().filter(|s| !s.is_empty()) {
            let placeholders = std::iter::repeat("?")
                .take(states.len())
                .collect::<Vec<_>>()
                .join(", ");
            where_clauses.push(format!("t.state IN ({placeholders})"));
            for state in states {
                params.push(Box::new(state.clone()));
            }
        }
        if let Some(session_id) = filter.scope_session_id.as_ref() {
            where_clauses.push(
                "t.id IN (SELECT task_id FROM task_session_bindings WHERE session_id = ?)"
                    .to_string(),
            );
            params.push(Box::new(session_id.clone()));
        }
        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };
        params.push(Box::new(limit));

        let sql = format!(
            "SELECT t.id, t.label, t.state, t.schema_version, t.created_at,
                    (SELECT COUNT(*) FROM task_segments s WHERE s.task_id = t.id) AS segment_count,
                    (SELECT COALESCE(MAX(e.cursor), 0) FROM task_events e WHERE e.task_id = t.id) AS event_cursor
             FROM tasks t
             {where_sql}
             ORDER BY t.created_at DESC, t.id ASC
             LIMIT ?"
        );
        let mut stmt = self.conn.prepare(&sql).context("prepare list_tasks")?;
        let param_refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok(TaskSummary {
                    task_id: row.get(0)?,
                    label: row.get(1)?,
                    state: row.get(2)?,
                    schema_version: row.get::<_, i64>(3)? as u32,
                    created_at: row.get(4)?,
                    segment_count: row.get(5)?,
                    event_cursor: row.get(6)?,
                    last_segment: None,
                })
            })
            .context("query list_tasks")?;
        let mut summaries = Vec::new();
        for row in rows {
            let mut summary = row.context("read task summary")?;
            summary.last_segment = self.last_segment_summary(&summary.task_id)?;
            summaries.push(summary);
        }
        Ok(summaries)
    }

    /// Flip every still-`pending` resume attempt whose `expires_at` is in the
    /// past to `status='expired'` (audit §2.1).
    ///
    /// Lazy sweep, run before the pending-slot check and before token redemption
    /// so an abandoned/expired attempt neither blocks the single pending slot nor
    /// stays redeemable past its TTL. Idempotent and cheap (a single UPDATE keyed
    /// by the `idx_task_resume_attempts_pending` partial index). Only `'pending'`
    /// rows are swept: an `'attached'` row is a completed redemption and is left
    /// alone.
    fn sweep_expired_resume_attempts(&self, now: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE task_resume_attempts
                 SET status = 'expired'
                 WHERE status = 'pending' AND expires_at <= ?1",
                [now],
            )
            .context("sweep expired resume attempts")?;
        Ok(())
    }

    /// Return the single `status='pending'` resume attempt for `task_id`, if any.
    ///
    /// The partial unique index `idx_task_resume_attempts_pending` guarantees at
    /// most one pending row per task, so this is a `query_row` returning `None`
    /// when there is no outstanding attempt.
    fn pending_resume_attempt(&self, task_id: &str) -> Result<Option<PendingResumeAttempt>> {
        // §2.1: expire stale pending attempts first so an abandoned/expired one
        // never permanently occupies the single pending slot (the documented
        // liveness purpose of the TTL).
        self.sweep_expired_resume_attempts(now_millis())?;
        self.conn
            .query_row(
                "SELECT attempt_id, session_id, turn_id, expires_at
                 FROM task_resume_attempts
                 WHERE task_id = ?1 AND status = 'pending'",
                [task_id],
                |row| {
                    Ok(PendingResumeAttempt {
                        attempt_id: row.get(0)?,
                        session_id: row.get(1)?,
                        turn_id: row.get(2)?,
                        expires_at: row.get(3)?,
                    })
                },
            )
            .optional()
            .context("query pending resume attempt")
    }

    /// Return the active execution owner of `task_id`, if one is attached.
    ///
    /// Reads the at-most-one `task_execution_owners` row (keyed by `task_id`).
    pub fn active_execution_owner(&self, task_id: &str) -> Result<Option<ActiveExecutionOwner>> {
        self.conn
            .query_row(
                "SELECT task_id, attempt_id, session_id, turn_id, segment_id
                 FROM task_execution_owners
                 WHERE task_id = ?1",
                [task_id],
                |row| {
                    Ok(ActiveExecutionOwner {
                        task_id: row.get(0)?,
                        attempt_id: row.get(1)?,
                        session_id: row.get(2)?,
                        turn_id: row.get(3)?,
                        segment_id: row.get(4)?,
                    })
                },
            )
            .optional()
            .context("query active execution owner")
    }

    /// Begin (or idempotently re-confirm) a resume attempt for `task_id`.
    ///
    /// Reconciles against the at-most-one outstanding pending attempt (the
    /// partial unique index). If a pending attempt for the *same*
    /// `(session_id, turn_id)` already exists, returns it with
    /// `resume_token: None` and `created: false` (idempotent retry — the raw
    /// token was never persisted, so it cannot be re-derived here). If a pending
    /// attempt exists for a *different* `(session_id, turn_id)`, or the task
    /// already has an active execution owner, fails with `task_resume_conflict`.
    ///
    /// Otherwise inserts a fresh `status='pending'` attempt storing only the
    /// token's SHA-256 hash, appends a `resume_attempt_started` event, and
    /// returns the raw token once (`resume_token: Some`, `created: true`).
    pub fn begin_resume_attempt(
        &self,
        task_id: &str,
        session_id: &str,
        turn_id: &str,
        generation: i64,
        ttl_ms: i64,
    ) -> Result<ResumeAttemptBegin> {
        if let Some(existing) = self.pending_resume_attempt(task_id)? {
            if existing.session_id == session_id && existing.turn_id == turn_id {
                return Ok(ResumeAttemptBegin {
                    attempt_id: existing.attempt_id,
                    resume_token: None,
                    expires_at: existing.expires_at,
                    created: false,
                });
            }
            bail!("task_resume_conflict");
        }
        if self.active_execution_owner(task_id)?.is_some() {
            bail!("task_resume_conflict");
        }
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let token = resume_token();
        let now = now_millis();
        let expires_at = now + ttl_ms;
        self.conn
            .execute(
                "INSERT INTO task_resume_attempts
                 (attempt_id, task_id, session_id, turn_id, token_hash, status, generation, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8)",
                rusqlite::params![
                    attempt_id,
                    task_id,
                    session_id,
                    turn_id,
                    token_hash(&token),
                    generation,
                    now,
                    expires_at
                ],
            )
            .context("insert resume attempt")?;
        self.append_typed_event(
            task_id,
            "resume_attempt_started",
            serde_json::json!({
                "kind": "resume_attempt_started",
                "attemptId": attempt_id,
                "taskId": task_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "generation": generation,
                "startedAt": now,
                "expiresAt": expires_at
            }),
        )?;
        Ok(ResumeAttemptBegin {
            attempt_id,
            resume_token: Some(token),
            expires_at,
            created: true,
        })
    }

    /// Rotate the wire token of a still-`pending` attempt, returning the new raw
    /// token.
    ///
    /// Used by Task 8's actor after a host restart, when the in-memory raw token
    /// for a persisted pending attempt is gone: rotation mints a fresh token,
    /// stores only its hash, and extends the expiry. It deliberately does NOT
    /// append a `resume_attempt_started` event (the attempt already started — a
    /// second start event would double-count). Fails with `invalid_resume_attempt`
    /// if no pending attempt matches `attempt_id`.
    pub fn rotate_resume_attempt_token(&self, attempt_id: &str) -> Result<String> {
        let token = resume_token();
        let updated = self
            .conn
            .execute(
                "UPDATE task_resume_attempts
                 SET token_hash = ?1, expires_at = MAX(expires_at, ?2)
                 WHERE attempt_id = ?3 AND status = 'pending'",
                rusqlite::params![token_hash(&token), now_millis() + 60_000, attempt_id],
            )
            .context("rotate resume attempt token")?;
        if updated != 1 {
            bail!("invalid_resume_attempt");
        }
        Ok(token)
    }

    /// Look up an attempt by raw token, accepting `pending` OR already-`attached`.
    ///
    /// Returns the matching [`AttachableAttempt`] for the row whose stored
    /// `token_hash` matches `token`, or `None` if no such pending/attached
    /// attempt exists. Accepting `attached` (not just `pending`) is what makes
    /// [`TaskStore::complete_resume_attached`] idempotent: a second attach with
    /// the same token still finds the row.
    fn attempt_by_token_for_attach(&self, token: &str) -> Result<Option<AttachableAttempt>> {
        // §2.1: expire stale pending attempts first, then enforce the TTL in the
        // redemption lookup itself. A 'pending' row past its `expires_at` is now
        // swept to 'expired' (so it no longer matches), while an already-'attached'
        // row stays redeemable to keep `complete_resume_attached` idempotent.
        let now = now_millis();
        self.sweep_expired_resume_attempts(now)?;
        self.conn
            .query_row(
                "SELECT attempt_id, task_id, session_id, turn_id
                 FROM task_resume_attempts
                 WHERE token_hash = ?1
                   AND (status = 'attached'
                        OR (status = 'pending' AND expires_at > ?2))",
                rusqlite::params![token_hash(token), now],
                |row| {
                    Ok(AttachableAttempt {
                        attempt_id: row.get(0)?,
                        task_id: row.get(1)?,
                        session_id: row.get(2)?,
                        turn_id: row.get(3)?,
                    })
                },
            )
            .optional()
            .context("query resume attempt by token")
    }

    /// Complete a resume attempt by attaching it to an execution segment.
    ///
    /// Idempotent: looks up the attempt by raw token (accepting pending OR
    /// already-attached), idempotently materializes the turn segment via
    /// [`TaskStore::ensure_turn_segment`], upserts the at-most-one
    /// `task_execution_owners` row for the task, and marks the attempt
    /// `status='attached'` with `completed_at`/`segment_id`. Calling twice with
    /// the same token returns the SAME segment and does not create a second
    /// owner or segment. Fails with `invalid_resume_token` if no
    /// pending/attached attempt matches the token.
    pub fn complete_resume_attached(
        &self,
        token: &str,
        generation: i64,
    ) -> Result<ResumeAttachedOutcome> {
        let AttachableAttempt {
            attempt_id,
            task_id,
            session_id,
            turn_id,
        } = match self.attempt_by_token_for_attach(token)? {
            Some(attempt) => attempt,
            None => bail!("invalid_resume_token"),
        };

        // Idempotent: same (task, session, turn) returns the same segment.
        let segment =
            self.ensure_turn_segment(&task_id, &session_id, &turn_id, Some(generation))?;

        // Upsert the single execution owner for the task (keyed by task_id).
        self.conn
            .execute(
                "INSERT INTO task_execution_owners
                 (task_id, attempt_id, session_id, turn_id, segment_id, started_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(task_id) DO UPDATE SET
                     attempt_id = excluded.attempt_id,
                     session_id = excluded.session_id,
                     turn_id = excluded.turn_id,
                     segment_id = excluded.segment_id,
                     started_at = excluded.started_at",
                rusqlite::params![
                    task_id,
                    attempt_id,
                    session_id,
                    turn_id,
                    segment.segment_id,
                    now_millis()
                ],
            )
            .context("upsert task execution owner")?;

        // Mark the attempt attached (idempotent: re-running sets the same values).
        self.conn
            .execute(
                "UPDATE task_resume_attempts
                 SET status = 'attached', completed_at = ?1, segment_id = ?2
                 WHERE attempt_id = ?3",
                rusqlite::params![now_millis(), segment.segment_id, attempt_id],
            )
            .context("mark resume attempt attached")?;

        Ok(ResumeAttachedOutcome {
            attempt_id,
            task_id,
            segment,
        })
    }

    /// Complete a resume attempt as blocked: record the reason and emit an event,
    /// without creating a segment or execution owner.
    ///
    /// Looks up the attempt by raw token, marks it `status='blocked'` with
    /// `completed_at` and the caller-supplied `payload` stored as JSON in
    /// `terminal_error`, then appends a `resume_attempt_blocked` event. The
    /// caller's `payload` need not carry a `"kind"` field: this method builds the
    /// full typed-event body (`kind` + `taskId`/`attemptId`/`at` merged with the
    /// caller's fields) before appending, so [`TaskStore::append_typed_event`]'s
    /// kind-match invariant holds. No segment and no owner are created. Fails
    /// with `invalid_resume_token` if no pending/attached attempt matches.
    ///
    /// Returns the affected task's `task_id` (already resolved during the token
    /// lookup) so the caller can project the `Blocked` task state without a
    /// second token→task lookup.
    pub fn complete_resume_blocked(
        &self,
        token: &str,
        payload: serde_json::Value,
    ) -> Result<String> {
        let AttachableAttempt {
            attempt_id,
            task_id,
            ..
        } = match self.attempt_by_token_for_attach(token)? {
            Some(attempt) => attempt,
            None => bail!("invalid_resume_token"),
        };

        let now = now_millis();
        let terminal_error =
            serde_json::to_string(&payload).context("serialize blocked resume payload")?;
        self.conn
            .execute(
                "UPDATE task_resume_attempts
                 SET status = 'blocked', completed_at = ?1, terminal_error = ?2
                 WHERE attempt_id = ?3",
                rusqlite::params![now, terminal_error, attempt_id],
            )
            .context("mark resume attempt blocked")?;

        // Build the full typed-event body: append_typed_event requires
        // payload["kind"] == "resume_attempt_blocked", but the caller's payload
        // carries only descriptive fields (e.g. reason/status). Start from the
        // caller's object (if any) and overlay the required discriminator + ids.
        let mut event = match payload {
            serde_json::Value::Object(map) => map,
            other => {
                let mut map = serde_json::Map::new();
                map.insert("payload".to_string(), other);
                map
            }
        };
        event.insert(
            "kind".to_string(),
            serde_json::Value::String("resume_attempt_blocked".to_string()),
        );
        event.insert(
            "taskId".to_string(),
            serde_json::Value::String(task_id.clone()),
        );
        event.insert(
            "attemptId".to_string(),
            serde_json::Value::String(attempt_id.clone()),
        );
        event.insert("at".to_string(), serde_json::Value::Number(now.into()));
        self.append_typed_event(
            &task_id,
            "resume_attempt_blocked",
            serde_json::Value::Object(event),
        )?;
        Ok(task_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    fn query_plan_details(store: &TaskStore, sql: &str) -> String {
        store
            .conn
            .prepare(sql)
            .unwrap()
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join("\n")
    }

    #[test]
    fn task_store_creates_resource_bound_indexes() {
        let (store, _dir) = open_temp_store();
        let segment_indexes = store
            .conn
            .prepare("PRAGMA index_list('task_segments')")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            segment_indexes
                .iter()
                .any(|name| name == "idx_task_segments_task_started_seq")
        );
        let task_indexes = store
            .conn
            .prepare("PRAGMA index_list('tasks')")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(
            task_indexes
                .iter()
                .any(|name| name == "idx_tasks_terminal_created")
        );
    }

    #[test]
    fn maintenance_recency_queries_use_bounded_indexes_without_temp_sort() {
        let (store, _dir) = open_temp_store();

        let prune_plan = query_plan_details(
            &store,
            "EXPLAIN QUERY PLAN
             SELECT id
             FROM tasks
             WHERE state IN ('completed', 'cancelled', 'failed')
               AND created_at < 123
             ORDER BY created_at ASC, id ASC
             LIMIT 2",
        );
        assert!(
            prune_plan.contains("idx_tasks_terminal_created"),
            "{prune_plan}"
        );
        assert!(!prune_plan.contains("SCAN tasks"), "{prune_plan}");
        assert!(!prune_plan.contains("TEMP B-TREE"), "{prune_plan}");

        let segment_plan = query_plan_details(
            &store,
            "EXPLAIN QUERY PLAN
             SELECT segment_id
             FROM task_segments
             WHERE task_id = 'task-1'
             ORDER BY started_at DESC, segment_seq DESC
             LIMIT 2",
        );
        assert!(
            segment_plan.contains("idx_task_segments_task_started_seq"),
            "{segment_plan}"
        );
        assert!(!segment_plan.contains("TEMP B-TREE"), "{segment_plan}");
    }

    #[test]
    fn task_state_reads_back_persisted_state() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        assert_eq!(store.task_state(&task_id).unwrap(), TaskState::Created);
        store.set_state(&task_id, TaskState::Running).unwrap();
        assert_eq!(store.task_state(&task_id).unwrap(), TaskState::Running);
    }

    #[test]
    fn resume_appends_new_segment_with_current_turn() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        store
            .append_segment(&task_id, Segment::new("s1", "t1"))
            .unwrap();
        // resume under a NEW turn
        store
            .append_segment(&task_id, Segment::new("s1", "t2"))
            .unwrap();
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
        assert_eq!(
            store.load_task(&task_id).unwrap().state,
            TaskState::Cancelled
        );
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
        assert_eq!(
            store.load_task(&task_id).unwrap().state,
            TaskState::Cancelled
        );
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
            control_state: Some(ControlProjection::Yielded),
            ..Default::default()
        };
        let cleanup = cancel_task(&store, &task_id, &yielded).unwrap();
        assert_eq!(
            store.load_task(&task_id).unwrap().state,
            TaskState::Cancelled
        );
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
        store
            .append_segment(&task_id, Segment::new("s1", "t1"))
            .unwrap();
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
        store
            .append_segment(&task_id, Segment::new("s1", "t2"))
            .unwrap();
        let segs = store.segments(&task_id).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].generation, Some(7));
        assert_eq!(segs[1].generation, None);
    }

    // v1 migration: an existing v1-shaped db (task_segments created WITHOUT
    // the generation column, meta version '1') must open, get the column added,
    // advance to the current version, and load its pre-existing segment with
    // generation None.
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

    // Finding 3: a real pre-v3 store may already hold duplicate
    // `(task_id, session_id, turn_id)` task_segments rows. Opening it at the
    // current schema version must
    // (a) dedupe by keeping the earliest row (MIN(rowid)) per group, then (b)
    // build the UNIQUE index `idx_task_segments_task_session_turn` successfully —
    // proving both that the dedupe SQL removed the right rows and that the index
    // is live afterward. Seeds a v2-shaped db (meta '2', task_segments with the
    // `generation` column added by the v1->v2 ALTER) holding TWO duplicate rows.
    #[test]
    fn opens_and_dedupes_duplicate_segments_then_enforces_unique_index_v3() {
        let dir = owner_only_tempdir();
        let db_path = dir.path().join("tasks.db");
        // Construct a v2-shaped db by hand: task_segments carries `generation`
        // (the column the v1->v2 migration ALTERs in), meta schema_version '2'.
        // Two task_segments rows share (task_id, session_id, turn_id) but differ
        // in segment_id; inserted in order so 'seg-early' gets the lower rowid.
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
                     generation INTEGER,
                     PRIMARY KEY (task_id, segment_id)
                 );
                 INSERT INTO meta (key, value) VALUES ('schema_version', '2');
                 INSERT INTO tasks (id, label, state, schema_version, created_at)
                     VALUES ('task-1', 'l', 'created', 2, 0);
                 INSERT INTO task_segments (task_id, segment_id, session_id, turn_id, started_at, generation)
                     VALUES ('task-1', 'seg-early', 's1', 't1', 0, NULL);
                 INSERT INTO task_segments (task_id, segment_id, session_id, turn_id, started_at, generation)
                     VALUES ('task-1', 'seg-late', 's1', 't1', 0, NULL);",
            )
            .unwrap();
            // Sanity: both duplicate rows exist before migration.
            let count: i64 = conn
                .query_row("SELECT COUNT(*) FROM task_segments", [], |row| row.get(0))
                .unwrap();
            assert_eq!(count, 2, "seed must contain two duplicate segment rows");
        }

        // Opening at the current version triggers the dedupe + unique-index migration.
        let store = TaskStore::open(dir.path()).unwrap();

        // (1) schema_version is now current.
        let version: String = store
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, TASK_STORE_SCHEMA_VERSION.to_string());

        // (2) Exactly one segment survives, and it is the EARLIEST (MIN(rowid))
        // row — proving the dedupe kept the right one.
        let segs = store.segments("task-1").unwrap();
        assert_eq!(segs.len(), 1, "dedupe must collapse to a single segment");
        assert_eq!(
            segs[0].segment_id, "seg-early",
            "dedupe must keep the earliest (lowest-rowid) segment"
        );

        // (3) The unique index is LIVE: a direct INSERT of another row with the
        // same (task_id, session_id, turn_id) now violates the index and fails.
        let dup_insert = store.conn.execute(
            "INSERT INTO task_segments (task_id, segment_id, session_id, turn_id, started_at, generation)
             VALUES ('task-1', 'seg-new', 's1', 't1', 0, NULL)",
            [],
        );
        assert!(
            dup_insert.is_err(),
            "post-migration unique index must reject a duplicate (task_id, session_id, turn_id)"
        );
    }

    #[test]
    fn opens_and_migrates_v3_segments_to_indexable_sequence() {
        let dir = owner_only_tempdir();
        let db_path = dir.path().join("tasks.db");
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
                     generation INTEGER,
                     PRIMARY KEY (task_id, segment_id)
                 );
                 INSERT INTO meta (key, value) VALUES ('schema_version', '3');
                 INSERT INTO tasks (id, label, state, schema_version, created_at)
                     VALUES ('task-1', 'l', 'created', 3, 0);
                 INSERT INTO task_segments (task_id, segment_id, session_id, turn_id, started_at, generation)
                     VALUES ('task-1', 'seg-1', 's1', 't1', 10, NULL);
                 INSERT INTO task_segments (task_id, segment_id, session_id, turn_id, started_at, generation)
                     VALUES ('task-1', 'seg-2', 's1', 't2', 10, NULL);
                 INSERT INTO task_segments (task_id, segment_id, session_id, turn_id, started_at, generation)
                     VALUES ('task-1', 'seg-3', 's1', 't3', 10, NULL);",
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

        let backfilled: Vec<(String, i64)> = store
            .conn
            .prepare(
                "SELECT segment_id, segment_seq
                 FROM task_segments
                 WHERE task_id = 'task-1'
                 ORDER BY started_at ASC, segment_seq ASC",
            )
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            backfilled,
            vec![
                ("seg-1".to_string(), 1),
                ("seg-2".to_string(), 2),
                ("seg-3".to_string(), 3),
            ]
        );
        assert_eq!(
            store
                .segments("task-1")
                .unwrap()
                .into_iter()
                .map(|segment| segment.segment_id)
                .collect::<Vec<_>>(),
            vec![
                "seg-1".to_string(),
                "seg-2".to_string(),
                "seg-3".to_string(),
            ]
        );

        store
            .append_segment(
                "task-1",
                Segment {
                    segment_id: "seg-4".into(),
                    session_id: "s1".into(),
                    turn_id: "t4".into(),
                    generation: Some(7),
                },
            )
            .unwrap();
        let appended_seq: i64 = store
            .conn
            .query_row(
                "SELECT segment_seq FROM task_segments WHERE segment_id = 'seg-4'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(appended_seq, 4);
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
        store
            .append_segment(&task_id, Segment::new("s1", "t1"))
            .unwrap();
        store
            .append_segment(&task_id, Segment::new("s1", "t2"))
            .unwrap();

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
            assert!(
                !section.turn_id.is_empty(),
                "section must carry active turn_id"
            );
        }

        // Task-level linking events are exported alongside the sections.
        assert_eq!(
            ep.events.len(),
            1,
            "exactly the one appended event is exported"
        );
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

        let c1 = store
            .append_event(&task_id, "segment_started", "a")
            .unwrap();
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
    fn ensure_turn_segment_is_idempotent_and_turn_binding_is_unique() {
        let (store, _dir) = open_temp_store();
        let task_a = store.create_task(default_new_task()).unwrap();
        let task_b = store.create_task(default_new_task()).unwrap();

        let first = store
            .ensure_turn_segment(&task_a, "session-1", "turn-1", Some(7))
            .unwrap();
        let second = store
            .ensure_turn_segment(&task_a, "session-1", "turn-1", Some(7))
            .unwrap();
        assert_eq!(first.segment_id, second.segment_id);

        let err = store
            .ensure_turn_segment(&task_b, "session-1", "turn-1", Some(7))
            .unwrap_err();
        assert!(err.to_string().contains("task_turn_conflict"));
    }

    #[test]
    fn session_binding_persists_across_store_reopen() {
        let dir = owner_only_tempdir();
        let store = TaskStore::open(dir.path()).unwrap();
        let task_id = store.create_task(default_new_task()).unwrap();
        let segment = store
            .ensure_turn_segment(&task_id, "session-1", "turn-1", Some(3))
            .unwrap();
        store.bind_session_task("session-1", &task_id).unwrap();
        store
            .bind_turn_task("session-1", "turn-1", &task_id, &segment.segment_id, "auto")
            .unwrap();
        drop(store);

        let reopened = TaskStore::open(dir.path()).unwrap();
        assert_eq!(
            reopened.task_for_session("session-1").unwrap(),
            Some(task_id.clone())
        );
        assert_eq!(
            reopened.task_for_turn("session-1", "turn-1").unwrap(),
            Some(task_id)
        );
    }

    #[test]
    fn list_tasks_orders_filters_and_reports_last_segment() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let segment = store
            .ensure_turn_segment(&task_id, "session-1", "turn-1", Some(11))
            .unwrap();
        let rows = store
            .list_tasks(TaskListFilter {
                state: None,
                limit: 100,
                scope_session_id: None,
            })
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].task_id, task_id);
        assert_eq!(rows[0].segment_count, 1);
        assert_eq!(
            rows[0].last_segment.as_ref().unwrap().segment_id,
            segment.segment_id
        );
    }

    #[test]
    fn task_events_require_json_payload_kind_to_match() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let cursor = store
            .append_typed_event(
                &task_id,
                "turn_ended",
                json!({
                    "kind": "turn_ended",
                    "taskId": task_id,
                    "segmentId": "segment-1",
                    "sessionId": "session-1",
                    "turnId": "turn-1",
                    "at": 1
                }),
            )
            .unwrap();
        assert_eq!(cursor, 1);
        let err = store
            .append_typed_event(&task_id, "turn_ended", json!({ "kind": "tabs_finalized" }))
            .unwrap_err();
        assert!(err.to_string().contains("task event kind mismatch"));
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

    #[test]
    fn resume_begin_is_idempotent_and_conflicts_across_sessions() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let first = store
            .begin_resume_attempt(&task_id, "session-1", "turn-1", 7, 60_000)
            .unwrap();
        let retry = store
            .begin_resume_attempt(&task_id, "session-1", "turn-1", 7, 60_000)
            .unwrap();
        assert_eq!(first.attempt_id, retry.attempt_id);
        assert!(first.resume_token.is_some());
        assert!(retry.resume_token.is_none());
        let err = store
            .begin_resume_attempt(&task_id, "session-2", "turn-1", 7, 60_000)
            .unwrap_err();
        assert!(err.to_string().contains("task_resume_conflict"));
    }

    #[test]
    fn resume_attached_is_idempotent_and_creates_active_owner() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let attempt = store
            .begin_resume_attempt(&task_id, "session-1", "turn-1", 7, 60_000)
            .unwrap();
        let token = attempt.resume_token.as_deref().unwrap();
        let first = store.complete_resume_attached(token, 7).unwrap();
        let retry = store.complete_resume_attached(token, 7).unwrap();
        assert_eq!(first.segment.segment_id, retry.segment.segment_id);
        assert_eq!(
            store
                .active_execution_owner(&task_id)
                .unwrap()
                .unwrap()
                .attempt_id,
            attempt.attempt_id
        );
    }

    #[test]
    fn blocked_resume_records_event_and_does_not_create_segment() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let attempt = store
            .begin_resume_attempt(&task_id, "session-1", "turn-1", 7, 60_000)
            .unwrap();
        store
            .complete_resume_blocked(
                attempt.resume_token.as_deref().unwrap(),
                json!({ "status": "blocked", "reason": "no_active_tab" }),
            )
            .unwrap();
        assert_eq!(store.segments(&task_id).unwrap().len(), 0);
        assert!(store.active_execution_owner(&task_id).unwrap().is_none());
        assert_eq!(
            store.events(&task_id).unwrap().last().unwrap().kind,
            "resume_attempt_blocked"
        );
    }

    // Task 8 relies on rotate_resume_attempt_token to recover a wire token for a
    // persisted pending attempt after a host restart (the in-memory raw token is
    // gone). Rotation must mint a NEW token, invalidate the OLD one, and leave
    // the attempt still attachable via the new token.
    #[test]
    fn rotate_resume_attempt_token_invalidates_old_token_and_issues_new() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let attempt = store
            .begin_resume_attempt(&task_id, "session-1", "turn-1", 7, 60_000)
            .unwrap();
        let old_token = attempt.resume_token.clone().unwrap();

        // Rotation mints a fresh token distinct from the original.
        let new_token = store
            .rotate_resume_attempt_token(&attempt.attempt_id)
            .unwrap();
        assert_ne!(new_token, old_token, "rotation must mint a new token");

        // The OLD token no longer resolves (its hash was overwritten).
        assert!(
            store.complete_resume_attached(&old_token, 7).is_err(),
            "old token must be rejected after rotation"
        );

        // Rotating an unknown attempt id is rejected. Tested while the attempt is
        // still pending so a non-pending status is not what causes the failure.
        let unknown_err = store
            .rotate_resume_attempt_token("no-such-attempt")
            .unwrap_err();
        assert!(
            unknown_err.to_string().contains("invalid_resume_attempt"),
            "unexpected error rotating unknown attempt: {unknown_err}"
        );

        // The NEW token DOES resolve, attaching to the same task/segment. Done
        // last because attaching moves the attempt out of 'pending'.
        let attached = store.complete_resume_attached(&new_token, 7).unwrap();
        assert_eq!(attached.attempt_id, attempt.attempt_id);
        assert_eq!(attached.task_id, task_id);
        assert_eq!(
            store
                .active_execution_owner(&task_id)
                .unwrap()
                .unwrap()
                .segment_id,
            attached.segment.segment_id
        );
    }

    #[test]
    fn expired_resume_token_is_not_redeemable() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        // ttl_ms = -1 => expires_at = now - 1, i.e. already expired at insert.
        let begin = store
            .begin_resume_attempt(&task_id, "s1", "t1", 7, -1)
            .unwrap();
        let token = begin.resume_token.expect("fresh attempt mints a token");
        // Redemption must reject an expired token rather than reattach.
        assert!(
            store.complete_resume_attached(&token, 7).is_err(),
            "expired resume token must not redeem"
        );
    }

    #[test]
    fn expired_pending_attempt_frees_the_single_pending_slot() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        // First attempt is born already expired and occupies the one pending slot.
        store
            .begin_resume_attempt(&task_id, "s1", "t1", 7, -1)
            .unwrap();
        // A new attempt for a DIFFERENT (session,turn) must succeed: the expired
        // pending row is swept to 'expired', no longer conflicting.
        let second = store
            .begin_resume_attempt(&task_id, "s2", "t2", 7, 60_000)
            .unwrap();
        assert!(
            second.created,
            "expired pending attempt must not permanently block a fresh attempt"
        );
    }

    #[test]
    fn unexpired_resume_token_still_redeems() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let begin = store
            .begin_resume_attempt(&task_id, "s1", "t1", 7, 60_000)
            .unwrap();
        let token = begin.resume_token.expect("fresh attempt mints a token");
        // A live token within TTL must still attach (no over-rejection).
        assert!(store.complete_resume_attached(&token, 7).is_ok());
    }

    #[test]
    fn attached_resume_token_redeems_after_ttl_elapses() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let begin = store
            .begin_resume_attempt(&task_id, "s1", "t1", 7, 60_000)
            .unwrap();
        let token = begin.resume_token.expect("fresh attempt mints a token");
        // First redemption while live: the row transitions pending -> attached.
        assert!(store.complete_resume_attached(&token, 7).is_ok());
        // Age the now-'attached' row well past its TTL (white-box: drive the
        // store's own connection so no production backdate surface is added).
        store
            .conn
            .execute(
                "UPDATE task_resume_attempts SET expires_at = ?1 WHERE token_hash = ?2",
                rusqlite::params![now_millis() - 1, token_hash(&token)],
            )
            .unwrap();
        // Idempotent re-attach must STILL redeem: an 'attached' row is matched
        // unconditionally and the sweep only touches 'pending' rows. This pins the
        // exact invariant the §2.1 WHERE clause protects.
        assert!(
            store.complete_resume_attached(&token, 7).is_ok(),
            "an already-attached row must stay redeemable past its TTL (idempotency)"
        );
    }

    #[test]
    fn prune_terminal_tasks_deletes_old_terminal_and_cascades() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        store
            .append_segment(&task_id, Segment::new("s1", "t1"))
            .unwrap();
        store.append_event(&task_id, "marker", "{}").unwrap();
        store.set_state(&task_id, TaskState::Completed).unwrap();
        // Backdate the row well before the retention window.
        store
            .set_task_created_at_for_test(&task_id, now_millis() - 1_000_000)
            .unwrap();

        // Retain only the last 60s of terminal tasks => this one is pruned.
        let pruned = store.prune_terminal_tasks(60_000).unwrap();
        assert_eq!(pruned, 1);
        assert!(!store.task_exists(&task_id).unwrap());
        // FK ON DELETE CASCADE removed the children too.
        assert_eq!(store.segments(&task_id).unwrap().len(), 0);
        assert_eq!(store.event_cursor(&task_id).unwrap(), 0);
    }

    #[test]
    fn prune_terminal_tasks_limited_bounds_work_per_call() {
        let (store, _dir) = open_temp_store();
        let mut task_ids = Vec::new();
        for _ in 0..3 {
            let task_id = store.create_task(default_new_task()).unwrap();
            store.set_state(&task_id, TaskState::Completed).unwrap();
            store
                .set_task_created_at_for_test(&task_id, now_millis() - 1_000_000)
                .unwrap();
            task_ids.push(task_id);
        }

        assert_eq!(store.prune_terminal_tasks_limited(60_000, 2).unwrap(), 2);
        assert_eq!(
            task_ids
                .iter()
                .filter(|task_id| store.task_exists(task_id).unwrap())
                .count(),
            1
        );
        assert_eq!(store.prune_terminal_tasks_limited(60_000, 2).unwrap(), 1);
        assert!(
            task_ids
                .iter()
                .all(|task_id| !store.task_exists(task_id).unwrap())
        );
    }

    #[test]
    fn prune_terminal_tasks_keeps_live_and_recent_tasks() {
        let (store, _dir) = open_temp_store();
        // A live (non-terminal) task, old enough to be in-window — must NOT be pruned.
        let live = store.create_task(default_new_task()).unwrap();
        store.set_state(&live, TaskState::Running).unwrap();
        store
            .set_task_created_at_for_test(&live, now_millis() - 1_000_000)
            .unwrap();
        // A terminal task created just now — within the window, must NOT be pruned.
        let recent = store.create_task(default_new_task()).unwrap();
        store.set_state(&recent, TaskState::Cancelled).unwrap();

        let pruned = store.prune_terminal_tasks(60_000).unwrap();
        assert_eq!(pruned, 0);
        assert!(store.task_exists(&live).unwrap());
        assert!(store.task_exists(&recent).unwrap());
    }

    #[test]
    fn cap_task_events_trims_to_the_most_recent_n() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        for _ in 0..5 {
            store.append_event(&task_id, "marker", "{}").unwrap();
        }
        // Keep only the 2 highest cursors.
        let removed = store.cap_task_events(&task_id, 2).unwrap();
        assert_eq!(removed, 3);
        // event_cursor reports MAX(cursor); the newest event survived.
        assert_eq!(store.event_cursor(&task_id).unwrap(), 5);
    }

    #[test]
    fn prune_terminal_tasks_keeps_blocked_recoverable_tasks() {
        let (store, _dir) = open_temp_store();
        // Blocked is NOT terminal (Blocked -> {Resuming, WaitingForHuman,
        // Cancelling, Failed}); it is recoverable live work and must survive
        // retention even when old.
        let blocked = store.create_task(default_new_task()).unwrap();
        store.set_state(&blocked, TaskState::Blocked).unwrap();
        store
            .set_task_created_at_for_test(&blocked, now_millis() - 1_000_000)
            .unwrap();
        assert_eq!(store.prune_terminal_tasks(60_000).unwrap(), 0);
        assert!(store.task_exists(&blocked).unwrap());
    }

    #[test]
    fn prune_terminal_tasks_deletes_old_failed_tasks() {
        let (store, _dir) = open_temp_store();
        // Failed is terminal (allowed_transitions -> empty slice) and must prune.
        let failed = store.create_task(default_new_task()).unwrap();
        store.set_state(&failed, TaskState::Failed).unwrap();
        store
            .set_task_created_at_for_test(&failed, now_millis() - 1_000_000)
            .unwrap();
        assert_eq!(store.prune_terminal_tasks(60_000).unwrap(), 1);
        assert!(!store.task_exists(&failed).unwrap());
    }

    #[test]
    fn task_ids_after_paginates_by_stable_id_order() {
        let (store, _dir) = open_temp_store();
        let mut expected = Vec::new();
        for _ in 0..3 {
            expected.push(store.create_task(default_new_task()).unwrap());
        }
        expected.sort();

        assert_eq!(store.task_ids_after(None, 2).unwrap(), expected[..2]);
        assert_eq!(
            store.task_ids_after(Some(&expected[0]), 2).unwrap(),
            expected[1..]
        );
        assert_eq!(
            store
                .task_ids_after(Some(expected.last().unwrap()), 2)
                .unwrap(),
            Vec::<String>::new()
        );
    }

    #[test]
    fn cap_task_events_edge_cases() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        for _ in 0..3 {
            store.append_event(&task_id, "marker", "{}").unwrap();
        }
        // cap >= count is a no-op.
        assert_eq!(store.cap_task_events(&task_id, 10).unwrap(), 0);
        assert_eq!(store.event_cursor(&task_id).unwrap(), 3);
        // cap == 0 clears the log.
        assert_eq!(store.cap_task_events(&task_id, 0).unwrap(), 3);
        assert_eq!(store.event_cursor(&task_id).unwrap(), 0);
    }

    #[test]
    fn cap_task_segments_trims_to_recent_segments_and_turn_bindings() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        for turn_id in ["t1", "t2", "t3", "t4"] {
            store
                .ensure_turn_segment(&task_id, "s1", turn_id, Some(7))
                .unwrap();
        }

        let removed = store.cap_task_segments(&task_id, 2).unwrap();
        assert_eq!(removed, 2);
        let turns: Vec<String> = store
            .segments(&task_id)
            .unwrap()
            .into_iter()
            .map(|segment| segment.turn_id)
            .collect();
        assert_eq!(turns, vec!["t3".to_string(), "t4".to_string()]);
        assert_eq!(store.task_for_turn("s1", "t1").unwrap(), None);
        assert_eq!(store.task_for_turn("s1", "t2").unwrap(), None);
        assert_eq!(store.task_for_turn("s1", "t4").unwrap(), Some(task_id));
    }

    #[test]
    fn cap_task_segments_preserves_active_execution_owner() {
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        let begin = store
            .begin_resume_attempt(&task_id, "s1", "t1", 7, 60_000)
            .unwrap();
        let token = begin.resume_token.expect("fresh attempt mints token");
        let attached = store.complete_resume_attached(&token, 7).unwrap();
        store
            .ensure_turn_segment(&task_id, "s1", "t2", Some(7))
            .unwrap();
        store
            .ensure_turn_segment(&task_id, "s1", "t3", Some(7))
            .unwrap();

        let removed = store.cap_task_segments(&task_id, 1).unwrap();
        assert_eq!(removed, 1);
        let segments = store.segments(&task_id).unwrap();
        assert!(
            segments
                .iter()
                .any(|segment| segment.segment_id == attached.segment.segment_id),
            "the active execution owner segment must survive segment capping"
        );
        assert!(
            segments.iter().any(|segment| segment.turn_id == "t3"),
            "the newest non-active segment should also be retained"
        );
        assert_eq!(store.task_for_turn("s1", "t2").unwrap(), None);
    }

    /// Helper: read the live `PRAGMA auto_vacuum` mode off a store's connection
    /// (0 = NONE, 1 = FULL, 2 = INCREMENTAL).
    fn auto_vacuum_mode(store: &TaskStore) -> i64 {
        store
            .conn
            .query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))
            .unwrap()
    }

    #[test]
    fn incremental_vacuum_succeeds_after_a_prune() {
        // §2.2: after retention deletes free up pages, `incremental_vacuum`
        // reclaims them. Drive a real prune, then vacuum, and assert Ok.
        let (store, _dir) = open_temp_store();
        let task_id = store.create_task(default_new_task()).unwrap();
        store
            .append_segment(&task_id, Segment::new("s1", "t1"))
            .unwrap();
        store.append_event(&task_id, "marker", "{}").unwrap();
        store.set_state(&task_id, TaskState::Completed).unwrap();
        // Backdate well past the retention window so the prune actually deletes.
        store
            .set_task_created_at_for_test(&task_id, now_millis() - 1_000_000)
            .unwrap();
        assert_eq!(store.prune_terminal_tasks(60_000).unwrap(), 1);

        // The vacuum is a no-op unless auto_vacuum=INCREMENTAL is in effect,
        // which `open` guarantees; either way it must succeed.
        store.incremental_vacuum().unwrap();
    }

    #[test]
    fn fresh_store_uses_incremental_auto_vacuum() {
        // §2.2: a freshly created db must come up in INCREMENTAL (mode 2),
        // set BEFORE setup_schema creates any table.
        let (store, _dir) = open_temp_store();
        assert_eq!(
            auto_vacuum_mode(&store),
            2,
            "fresh store must be auto_vacuum=INCREMENTAL"
        );
    }

    #[test]
    fn open_migrates_preexisting_none_mode_db_to_incremental() {
        // §2.2 migration branch (`if auto_vacuum != 2 { VACUUM }`): a db that
        // already exists with auto_vacuum=NONE AND at least one table cannot
        // honour a later mode change without a full VACUUM. `open` must detect
        // mode != 2 and run that VACUUM, converting the db to INCREMENTAL.
        let dir = owner_only_tempdir();
        let db_path = dir.path().join("tasks.db");

        // Pre-seed the EXACT file `open` will use (`<dir>/tasks.db`) with
        // auto_vacuum=NONE and a populated table, then close it so SQLite has
        // committed mode 0 to a non-empty db. A later mode flip alone is then a
        // no-op — only the migration VACUUM can convert it.
        {
            let seed = Connection::open(&db_path).unwrap();
            seed.pragma_update(None, "auto_vacuum", "NONE").unwrap();
            seed.execute_batch("CREATE TABLE _premigration_marker (x)")
                .unwrap();
            // Confirm the pre-seed really committed NONE (mode 0): this is what
            // makes the test load-bearing — without `open`'s VACUUM the db would
            // stay here.
            let seeded_mode: i64 = seed
                .query_row("PRAGMA auto_vacuum", [], |row| row.get(0))
                .unwrap();
            assert_eq!(seeded_mode, 0, "pre-seed must commit auto_vacuum=NONE");
        } // drop closes the connection, flushing mode 0 to disk.

        // Open through the real entry point against the same dir.
        let store = TaskStore::open(dir.path()).unwrap();

        // The migration VACUUM must have converted the pre-existing db.
        assert_eq!(
            auto_vacuum_mode(&store),
            2,
            "open must migrate a pre-existing NONE-mode db to INCREMENTAL"
        );

        // And the store is fully functional afterwards: the migration VACUUM
        // did not corrupt the schema setup_schema created on top.
        let task_id = store.create_task(default_new_task()).unwrap();
        assert_eq!(store.task_state(&task_id).unwrap(), TaskState::Created);
    }
}
