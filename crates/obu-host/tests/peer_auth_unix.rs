#![cfg(unix)]

use obu_host::{
    peer_auth::{PeerAuthGate, PeerAuthMode, unix::UnixPeerAuthGate},
    socket::{Listener, unix::UnixSockListener},
};
use tokio::io::AsyncWriteExt;
use tokio::net::UnixStream;

#[tokio::test]
async fn unix_peer_auth_accepts_same_uid() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("auth.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();

    let path2 = path.clone();
    let server = tokio::spawn(async move {
        let mut peer = listener.accept().await.unwrap();
        let gate: Box<dyn PeerAuthGate<UnixStream>> =
            Box::new(UnixPeerAuthGate::new(PeerAuthMode::Auto));
        gate.authorize(&mut peer)
            .await
            .expect("same-uid peer should pass");
        assert!(peer.cred.is_some());
    });

    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    let mut client = UnixStream::connect(&path2).await.unwrap();
    client.write_all(b"x").await.unwrap();
    server.await.unwrap();
}
