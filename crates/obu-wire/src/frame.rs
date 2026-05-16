//! 4-byte little-endian length-prefix codec.

use std::io;

use bytes::{Buf, BufMut, Bytes, BytesMut};
use thiserror::Error;
use tokio_util::codec::{Decoder, Encoder};

/// Maximum permitted frame body length.
pub const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

/// Frame codec error.
#[derive(Debug, Error)]
pub enum FrameError {
    /// I/O failure.
    #[error("io: {0}")]
    Io(#[from] io::Error),
    /// Length prefix exceeds `MAX_FRAME_LEN`.
    #[error("oversize frame ({0} bytes; max {MAX_FRAME_LEN})")]
    Oversize(usize),
}

/// Length-prefix codec.
#[derive(Debug, Default, Clone, Copy)]
pub struct FrameCodec;

impl Decoder for FrameCodec {
    type Item = Bytes;
    type Error = FrameError;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {
        if src.len() < 4 {
            return Ok(None);
        }

        let len = u32::from_le_bytes([src[0], src[1], src[2], src[3]]) as usize;
        if len > MAX_FRAME_LEN {
            return Err(FrameError::Oversize(len));
        }
        if src.len() < 4 + len {
            src.reserve(4 + len - src.len());
            return Ok(None);
        }

        src.advance(4);
        Ok(Some(src.split_to(len).freeze()))
    }
}

impl Encoder<Bytes> for FrameCodec {
    type Error = FrameError;

    fn encode(&mut self, item: Bytes, dst: &mut BytesMut) -> Result<(), Self::Error> {
        if item.len() > MAX_FRAME_LEN {
            return Err(FrameError::Oversize(item.len()));
        }
        dst.reserve(4 + item.len());
        dst.put_u32_le(item.len() as u32);
        dst.extend_from_slice(&item);
        Ok(())
    }
}
