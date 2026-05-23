//! open-browser-use per-session broker daemon.
//!
//! This crate owns the local socket endpoint used by the agent-side SDK.

#![deny(rust_2018_idioms, unsafe_op_in_unsafe_fn)]
#![warn(missing_docs)]

pub mod backends;
pub mod cli;
pub mod diagnostics;
pub mod dispatcher;
pub mod error;
pub mod methods;
pub mod native_messaging;
pub(crate) mod ops;
pub mod peer_auth;
pub mod peer_lifecycle;
pub mod policy;
pub mod registry_lifecycle;
pub mod runtime_descriptor_lifecycle;
pub mod service_registry;
pub mod socket;
pub mod tab_state;
