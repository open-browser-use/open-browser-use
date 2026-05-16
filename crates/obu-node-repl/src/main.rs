use anyhow::Result;
use clap::Parser;
use obu_node_repl::Cli;

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    obu_node_repl::diagnostics::install_tracing(cli.verbosity)?;
    obu_node_repl::cli::run(cli).await
}
