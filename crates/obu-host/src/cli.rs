//! Command-line arguments.

use std::path::PathBuf;

use clap::Parser;

/// `obu-host` command-line interface.
#[derive(Debug, Parser)]
#[command(name = "obu-host", version, about)]
pub struct Cli {
    /// Override socket path.
    #[arg(long, env = "OBU_HOST_SOCKET_PATH")]
    pub socket: Option<PathBuf>,

    /// Session identifier. Defaults to a fresh UUIDv4 when omitted.
    #[arg(long, env = "OBU_SESSION_ID")]
    pub session_id: Option<String>,

    /// CdpBackend endpoint URL.
    #[arg(long, env = "OBU_CDP_URL")]
    pub cdp_url: Option<String>,

    /// Run as a Chrome Native Messaging host.
    #[arg(long, env = "OBU_NATIVE_MESSAGING")]
    pub native_messaging: bool,

    /// Optional capability-token gate. Held by Rust processes only.
    #[arg(long, env = "OBU_CAPABILITY_TOKEN")]
    pub capability_token: Option<String>,

    /// Peer-auth mode: auto, strict, or off.
    #[arg(long, env = "OBU_PEER_AUTH", default_value = "auto")]
    pub peer_auth: String,

    /// Tracing filter.
    #[arg(long, env = "OBU_LOG", default_value = "info")]
    pub log: String,
}
