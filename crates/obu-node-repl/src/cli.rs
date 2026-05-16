//! Command-line entry for `obu-node-repl`.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

/// `obu-node-repl` command-line interface.
#[derive(Debug, Parser)]
#[command(name = "obu-node-repl", version)]
pub struct Cli {
    /// Increase verbosity. Repeat for more (`-v`, `-vv`).
    #[arg(short, long, action = clap::ArgAction::Count)]
    pub verbosity: u8,

    /// Optional session ID. If unset, a UUIDv4 short slug is generated.
    #[arg(long, env = "OBU_SESSION_ID")]
    pub session_id: Option<String>,

    /// Override working directory for the Node child.
    #[arg(long)]
    pub working_dir: Option<PathBuf>,

    /// Subcommand.
    #[command(subcommand)]
    pub command: Command,
}

/// Subcommand surface.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Run the MCP server.
    Mcp {
        /// Transport.
        #[command(subcommand)]
        transport: McpTransport,
    },
}

/// MCP transport selector.
#[derive(Debug, Subcommand)]
pub enum McpTransport {
    /// stdio transport.
    Stdio,
}

/// Dispatch CLI command.
pub async fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Mcp {
            transport: McpTransport::Stdio,
        } => crate::mcp_server::run_stdio_server_with_options(cli).await,
    }
}
