//! Process-liveness-driven reclamation of orphaned runtime artifacts and kernels.
//!
//! Each `obu-node-repl` kernel owns one `mcp-artifacts/<session_id>/` dir. The dir is
//! removed by [`crate::artifact_store::ArtifactStore`]'s `Drop`, which never runs when the
//! process is SIGKILLed / crashes / is reconnect-replaced. This module reclaims those leaks
//! on the next kernel startup: it writes an [`OwnerMarker`] (pid/ppid/started_at) into its own
//! session dir, then sweeps sibling dirs — reaping dirs whose owner pid is dead, and killing
//! sibling kernels that are alive but orphaned (their recorded parent pid is gone).

use std::path::Path;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const OWNER_FILE: &str = ".owner";

/// Liveness marker written into each session dir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerMarker {
    /// Owning kernel process id.
    pub pid: u32,
    /// Parent process id at creation (the `obu mcp stdio` spawner).
    pub ppid: u32,
    /// Unix seconds when the marker was written. Reserved for future pid-reuse hardening.
    pub started_at: u64,
}

/// What to do with a swept sibling session dir.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Live + parented, or markerless-young: leave it alone.
    Keep,
    /// Owner is dead (or markerless-old): remove the dir.
    ReapDir,
    /// Owner alive but orphaned: kill this pid, then remove the dir.
    KillAndReap(i32),
}

/// Outcome of a [`reap_runtime`] sweep.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct ReapReport {
    /// Orphaned dirs removed.
    pub dirs_reaped: usize,
    /// Orphaned sibling kernels killed.
    pub kernels_killed: usize,
    /// Live/young dirs left untouched (incl. the current session).
    pub kept: usize,
}

/// Returns true if `pid` refers to a live process this user could signal.
#[cfg(unix)]
pub fn process_alive(pid: i32) -> bool {
    use rustix::process::{Pid, test_kill_process};
    if pid <= 0 {
        return false;
    }
    let Some(pid) = Pid::from_raw(pid) else {
        return false;
    };
    match test_kill_process(pid) {
        Ok(()) => true,
        Err(rustix::io::Errno::PERM) => true,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
pub fn process_alive(_pid: i32) -> bool {
    // No portable liveness check; never reap on non-unix.
    true
}

/// Build the marker for the current process. `started_at` is unix seconds.
pub fn current_marker() -> OwnerMarker {
    #[cfg(unix)]
    let ppid = rustix::process::getppid()
        .map(|p| p.as_raw_nonzero().get() as u32)
        .unwrap_or(0);
    #[cfg(not(unix))]
    let ppid = 0u32;
    OwnerMarker {
        pid: std::process::id(),
        ppid,
        started_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    }
}

/// Atomically write `.owner` into `session_dir` (temp file + rename).
pub fn write_owner_marker(session_dir: &Path, marker: &OwnerMarker) -> Result<()> {
    let bytes = serde_json::to_vec(marker).context("serialize owner marker")?;
    let tmp = session_dir.join(format!(".owner.tmp.{}", std::process::id()));
    std::fs::write(&tmp, &bytes).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, session_dir.join(OWNER_FILE)).context("rename owner marker")?;
    Ok(())
}

/// Read `.owner`; `Ok(None)` when missing or unparseable (never errors on corruption).
pub fn read_owner_marker(session_dir: &Path) -> Result<Option<OwnerMarker>> {
    let path = session_dir.join(OWNER_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}

/// Pure decision. `alive(pid)` is injected for testability.
/// `dir_mtime`/`now` are unix seconds; `grace` is the markerless grace window (seconds).
pub fn classify(
    marker: Option<&OwnerMarker>,
    dir_mtime: u64,
    now: u64,
    grace: u64,
    alive: impl Fn(i32) -> bool,
) -> Disposition {
    match marker {
        Some(m) => {
            let owner = m.pid as i32;
            if !alive(owner) {
                return Disposition::ReapDir;
            }
            // Owner alive: orphaned iff its recorded parent is gone.
            if m.ppid != 0 && !alive(m.ppid as i32) {
                return Disposition::KillAndReap(owner);
            }
            Disposition::Keep
        }
        None => {
            if now.saturating_sub(dir_mtime) > grace {
                Disposition::ReapDir
            } else {
                Disposition::Keep
            }
        }
    }
}

#[cfg(unix)]
fn kill_pid(pid: i32) {
    use rustix::process::{Pid, Signal, kill_process};
    if let Some(pid) = Pid::from_raw(pid) {
        let _ = kill_process(pid, Signal::KILL);
    }
}

#[cfg(not(unix))]
fn kill_pid(_pid: i32) {}

/// Sweep sibling session dirs under `artifact_root`, reclaiming orphaned dirs and killing
/// orphaned sibling kernels. Best-effort: per-entry errors are logged and skipped.
pub fn reap_runtime(
    artifact_root: &Path,
    current_session_id: &str,
    now: u64,
    grace: u64,
) -> Result<ReapReport> {
    let mut report = ReapReport::default();
    let entries = match std::fs::read_dir(artifact_root) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(report),
        Err(e) => return Err(e).context("read artifact root"),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Never follow/reap through a symlink (defense-in-depth; session roots are never symlinks).
        let ft = match std::fs::symlink_metadata(&path) {
            Ok(m) => m.file_type(),
            Err(_) => continue,
        };
        if ft.is_symlink() || !ft.is_dir() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name == current_session_id {
            report.kept += 1;
            continue;
        }
        let marker = read_owner_marker(&path).unwrap_or(None);
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        match classify(marker.as_ref(), mtime, now, grace, process_alive) {
            Disposition::Keep => report.kept += 1,
            Disposition::ReapDir => {
                if std::fs::remove_dir_all(&path).is_ok() {
                    report.dirs_reaped += 1;
                }
            }
            Disposition::KillAndReap(pid) => {
                kill_pid(pid);
                report.kernels_killed += 1;
                if std::fs::remove_dir_all(&path).is_ok() {
                    report.dirs_reaped += 1;
                }
            }
        }
    }
    if report.dirs_reaped > 0 || report.kernels_killed > 0 {
        tracing::info!(
            dirs_reaped = report.dirs_reaped,
            kernels_killed = report.kernels_killed,
            kept = report.kept,
            "reaper reclaimed orphaned runtime artifacts"
        );
    }
    Ok(report)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn own_process_is_alive() {
        assert!(process_alive(std::process::id() as i32));
    }

    #[test]
    fn invalid_pids_are_dead() {
        assert!(!process_alive(0));
        assert!(!process_alive(-1));
    }

    #[test]
    fn owner_marker_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let m = OwnerMarker {
            pid: 4242,
            ppid: 7,
            started_at: 100,
        };
        write_owner_marker(dir.path(), &m).unwrap();
        assert_eq!(read_owner_marker(dir.path()).unwrap(), Some(m));
    }

    #[test]
    fn corrupt_marker_reads_none() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".owner"), b"not json").unwrap();
        assert_eq!(read_owner_marker(dir.path()).unwrap(), None);
    }

    #[test]
    fn missing_marker_reads_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_owner_marker(dir.path()).unwrap(), None);
    }

    #[test]
    fn classify_decisions() {
        let now = 1_000_000u64;
        let grace = 600u64;
        // dead owner -> reap dir
        assert_eq!(
            classify(
                Some(&OwnerMarker {
                    pid: 999_999,
                    ppid: 1,
                    started_at: 0
                }),
                now,
                now,
                grace,
                |_| false
            ),
            Disposition::ReapDir
        );
        // alive owner + dead parent -> kill + reap
        assert_eq!(
            classify(
                Some(&OwnerMarker {
                    pid: 10,
                    ppid: 20,
                    started_at: 0
                }),
                now,
                now,
                grace,
                |p| p == 10
            ),
            Disposition::KillAndReap(10)
        );
        // alive owner + alive parent -> keep
        assert_eq!(
            classify(
                Some(&OwnerMarker {
                    pid: 10,
                    ppid: 20,
                    started_at: 0
                }),
                now,
                now,
                grace,
                |_| true
            ),
            Disposition::Keep
        );
        // markerless + old -> reap
        assert_eq!(
            classify(None, now - grace - 1, now, grace, |_| true),
            Disposition::ReapDir
        );
        // markerless + young -> keep
        assert_eq!(
            classify(None, now - 1, now, grace, |_| true),
            Disposition::Keep
        );
    }

    #[test]
    fn reap_runtime_reaps_dead_and_kills_orphans_keeps_current() {
        use std::process::Command;
        let root = tempfile::tempdir().unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        // current session dir (must be kept)
        let cur = root.path().join("obu-current");
        std::fs::create_dir_all(&cur).unwrap();
        write_owner_marker(&cur, &current_marker()).unwrap();

        // dead-owner dir -> reaped
        let dead = root.path().join("obu-dead");
        std::fs::create_dir_all(&dead).unwrap();
        write_owner_marker(
            &dead,
            &OwnerMarker {
                pid: 999_999,
                ppid: 1,
                started_at: 0,
            },
        )
        .unwrap();

        // orphaned kernel: real sleep child, recorded parent dead -> killed + reaped
        let mut child = Command::new("sleep").arg("60").spawn().unwrap();
        let child_pid = child.id();
        let orphan = root.path().join("obu-orphan");
        std::fs::create_dir_all(&orphan).unwrap();
        write_owner_marker(
            &orphan,
            &OwnerMarker {
                pid: child_pid,
                ppid: 999_999,
                started_at: 0,
            },
        )
        .unwrap();

        let report = reap_runtime(root.path(), "obu-current", now, 600).unwrap();

        assert!(cur.exists(), "current session must be kept");
        assert!(!dead.exists(), "dead-owner dir must be reaped");
        assert!(!orphan.exists(), "orphan dir must be reaped");
        assert!(report.dirs_reaped >= 2, "report: {report:?}");
        assert_eq!(report.kernels_killed, 1, "report: {report:?}");

        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(
            child.try_wait().unwrap().is_some(),
            "orphan kernel should have been killed"
        );
    }
}
