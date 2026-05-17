//! Rust MCP server that runs JavaScript in a managed Node child.

#![deny(rust_2018_idioms, unsafe_code)]

pub mod artifact_store;
pub mod cli;
pub mod diagnostics;
pub mod display_router;
pub mod mcp_server;
pub mod native_pipe;
pub mod repl_manager;
pub mod result_budget;
pub mod sdk_discovery;
pub mod trust;

pub use cli::Cli;
