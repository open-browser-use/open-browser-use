//! Native-pipe broker support.
//!
//! Phase 2A starts with the kernel/broker frame definitions. The connection
//! broker itself is wired into `repl_manager` in the next slice.

pub mod broker;
pub mod connection;
pub mod protocol;
