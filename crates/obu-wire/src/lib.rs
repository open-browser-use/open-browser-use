//! Shared wire-protocol types for the open-browser-use stack.
//!
//! Consumed by `obu-node-repl`, `obu-host`, and later SDK-side Rust tooling.
//! Carries the section 3.3 native-pipe envelope, the 4-byte LE length-prefix
//! codec, error codes, and host-extension version-handshake frames.

#![deny(rust_2018_idioms, unsafe_code)]
#![warn(missing_docs)]

pub mod envelope;
pub mod error;
pub mod frame;
pub mod runtime_dir;
pub mod version;

pub use envelope::{Notification, Request, Response, RpcMessage};
pub use error::{ErrorCode, ErrorObject};
pub use frame::{FrameCodec, MAX_FRAME_LEN};
pub use version::{Hello, HelloAck, MinVersion, VersionMismatch};
