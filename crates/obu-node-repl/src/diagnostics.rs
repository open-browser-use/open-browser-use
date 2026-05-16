//! Tracing initialization.

use anyhow::Result;
use tracing_subscriber::{EnvFilter, fmt};

/// Install global tracing. Logs go to stderr because stdout is the MCP stream.
pub fn install_tracing(verbosity: u8) -> Result<()> {
    let default = match verbosity {
        0 => "info",
        1 => "debug",
        _ => "trace",
    };
    let filter = EnvFilter::try_from_env("OBU_LOG").unwrap_or_else(|_| EnvFilter::new(default));
    fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .compact()
        .try_init()
        .map_err(|e| anyhow::anyhow!("tracing init failed: {e}"))?;
    Ok(())
}
