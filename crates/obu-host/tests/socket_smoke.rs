#![cfg(unix)]

use std::time::Duration;

use obu_host::{
    error::HostError,
    socket::{Listener, unix::UnixSockListener},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;

#[tokio::test]
async fn unix_listener_round_trips_a_payload() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("test.sock");
    let mut listener = UnixSockListener::bind(&path).unwrap();

    let path2 = path.clone();
    let server = tokio::spawn(async move {
        let mut peer = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 5];
        peer.stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");
        peer.stream.write_all(b"world").await.unwrap();
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    let mut client = UnixStream::connect(&path2).await.unwrap();
    client.write_all(b"hello").await.unwrap();
    let mut buf = vec![0u8; 5];
    client.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"world");
    server.await.unwrap();
}

#[tokio::test]
async fn unix_listener_refuses_to_unlink_a_live_socket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("live.sock");
    let _listener = UnixSockListener::bind(&path).unwrap();

    let err = match UnixSockListener::bind(&path) {
        Ok(_) => panic!("second bind unexpectedly succeeded"),
        Err(err) => err,
    };
    assert!(
        matches!(err, HostError::Io(ref io) if io.kind() == std::io::ErrorKind::AddrInUse),
        "expected AddrInUse, got {err:?}",
    );

    UnixStream::connect(&path).await.unwrap();
}
