//! Tracing initialization.

use tracing_subscriber::{EnvFilter, fmt};

/// Install global tracing. Logs go to stderr so stdout remains protocol-safe.
pub fn init(filter: &str) -> anyhow::Result<()> {
    let filter = EnvFilter::try_new(filter).unwrap_or_else(|_| EnvFilter::new("info"));
    fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .compact()
        .try_init()
        .map_err(|e| anyhow::anyhow!("tracing init failed: {e}"))?;
    Ok(())
}
