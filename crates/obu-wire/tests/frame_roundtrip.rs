use bytes::BytesMut;
use futures_util::{SinkExt, StreamExt};
use obu_wire::FrameCodec;
use tokio_util::codec::{Decoder, Encoder, FramedRead, FramedWrite};

#[test]
fn encode_decode_short_frame() {
    let mut codec = FrameCodec;
    let mut buf = BytesMut::new();
    codec.encode(b"hello".to_vec().into(), &mut buf).unwrap();

    assert_eq!(&buf[..4], &5u32.to_le_bytes());
    assert_eq!(&buf[4..], b"hello");

    let mut codec = FrameCodec;
    let out = codec.decode(&mut buf).unwrap().unwrap();
    assert_eq!(&out[..], b"hello");
}

#[test]
fn decode_partial_returns_none() {
    let mut codec = FrameCodec;
    let mut buf = BytesMut::new();
    buf.extend_from_slice(&5u32.to_le_bytes());
    buf.extend_from_slice(b"hel");
    let out = codec.decode(&mut buf).unwrap();
    assert!(out.is_none());
}

#[test]
fn decode_rejects_oversize_frame() {
    let mut codec = FrameCodec;
    let mut buf = BytesMut::new();
    buf.extend_from_slice(&(obu_wire::MAX_FRAME_LEN as u32 + 1).to_le_bytes());
    let err = codec.decode(&mut buf).unwrap_err();
    assert!(err.to_string().contains("oversize"));
}

#[tokio::test]
async fn async_pipe_roundtrip() {
    let (a, b) = tokio::io::duplex(1024);
    let (a_r, a_w) = tokio::io::split(a);
    let (b_r, b_w) = tokio::io::split(b);

    let mut sink = FramedWrite::new(a_w, FrameCodec);
    let mut source = FramedRead::new(b_r, FrameCodec);

    sink.send(b"ping".to_vec().into()).await.unwrap();
    drop(sink);
    let frame = source.next().await.unwrap().unwrap();
    assert_eq!(&frame[..], b"ping");

    let _ = (a_r, b_w);
}
