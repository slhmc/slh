//! Dedicated Java servers. Separate from the client's servers.dat editor.
pub mod config;
pub mod host;
pub mod providers;
pub mod runtime;
pub mod horizon;
pub mod metrics;
pub mod recovery;
pub mod store;
pub mod discovery;
pub mod plugins;
pub use config::*;
pub use store::*;

#[cfg(test)]
mod tests;

pub mod artwork;

pub mod library;

pub mod players;
pub mod live;
