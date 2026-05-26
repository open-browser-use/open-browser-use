//! Native-pipe broker support.
//!
//! Defines the kernel/broker frame protocol. The connection broker is wired
//! into `repl_manager` — `JsRuntimeManager` owns a `NativePipeBroker`.

pub mod broker;
pub mod connection;
pub mod protocol;
