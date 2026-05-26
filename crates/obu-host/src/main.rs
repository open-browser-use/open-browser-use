use std::path::PathBuf;
use std::sync::Arc;

use clap::Parser;
use uuid::Uuid;

use obu_host::{
    backends::{BrowserBackend, cdp::CdpBackend, webext::WebExtensionBackend},
    cli::Cli,
    diagnostics,
    dispatcher::Dispatcher,
    peer_auth::{PeerAuthGate, PeerAuthMode, unix::UnixPeerAuthGate},
    peer_lifecycle::PeerLifecycleDiagnostics,
    policy::ConfiguredHostPolicy,
    socket::{self, Listener, unix::UnixSockListener},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Cli::parse();
    diagnostics::init(&args.log)?;

    if args.native_messaging {
        return obu_host::native_messaging::run(args).await;
    }

    let session_id = args
        .session_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let socket_path: PathBuf = args
        .socket
        .clone()
        .unwrap_or_else(|| socket::default_socket_path(&session_id));

    tracing::info!(
        socket = ?socket_path,
        %session_id,
        cdp_url = ?args.cdp_url,
        "obu-host binding socket"
    );

    let mut listener = UnixSockListener::bind(&socket_path)?;
    let peer_auth_mode = PeerAuthMode::parse(&args.peer_auth);
    let peer_diagnostics = PeerLifecycleDiagnostics::default();
    let peer_auth =
        UnixPeerAuthGate::new_with_diagnostics(peer_auth_mode, peer_diagnostics.clone());
    let registry = Arc::new(obu_host::service_registry::ServiceRegistry::default());
    let backend: Arc<dyn BrowserBackend> = match args.cdp_url.as_deref() {
        Some(url) => {
            tracing::info!(%url, "connecting CDP backend");
            Arc::new(CdpBackend::connect(url, registry.clone()).await?)
        }
        None => Arc::new(WebExtensionBackend::default()),
    };
    let task_store = open_task_store();
    let dispatcher = Arc::new(Dispatcher::new_with_policy_peer_diagnostics_and_task_store(
        env!("CARGO_PKG_VERSION").into(),
        backend,
        Arc::new(ConfiguredHostPolicy::from_env()),
        peer_diagnostics,
        task_store,
    ));
    let capability_token = args.capability_token.clone();

    tracing::info!(?peer_auth_mode, "obu-host accepting peers");
    loop {
        let mut peer = listener.accept().await?;
        match peer_auth.authorize(&mut peer).await {
            Ok(()) => {
                tracing::info!(cred = ?peer.cred, "peer authorized");
                let dispatcher = dispatcher.clone();
                let capability_token = capability_token.clone();
                tokio::spawn(async move {
                    if let Err(error) = dispatcher
                        .serve_peer(peer.stream, capability_token.as_deref())
                        .await
                    {
                        tracing::warn!(%error, "peer dispatcher ended with error");
                    }
                });
            }
            Err(err) => {
                tracing::warn!(error = %err, "peer rejected");
                drop(peer);
            }
        }
    }
}

/// Provision the durable task store under `<runtime_dir>/tasks`.
///
/// The directory is created owner-only before the store opens. A failure here
/// is non-fatal: the host keeps running and `browser.tasks.*` RPCs resolve to
/// `task_store_unavailable` rather than taking down the whole broker.
fn open_task_store() -> Option<obu_host::task_store_actor::TaskStoreHandle> {
    use obu_wire::runtime_dir::{ensure_owner_only_dir, resolve_runtime_dir};

    let task_dir = resolve_runtime_dir().join("tasks");
    match ensure_owner_only_dir(&task_dir)
        .map_err(anyhow::Error::from)
        .and_then(|_| obu_host::task_store_actor::TaskStoreHandle::open(task_dir))
    {
        Ok(handle) => Some(handle),
        Err(error) => {
            tracing::warn!(%error, "task store unavailable; browser.tasks.* will fail");
            None
        }
    }
}
