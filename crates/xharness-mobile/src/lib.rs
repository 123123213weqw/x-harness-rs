//! Mobile credentials and transport compose the original scoped Gateway.
//! No Agent, project storage, arbitrary RPC or desktop authentication lives here.
mod client;
mod handler;
mod pairing;
pub mod protocol;
pub use client::{run_outbound, OutboundConfig};
pub use pairing::{DeviceView, MobileHost, PairingOffer, PairingScopes};
pub use protocol::{ErrorCode, MobileResponse};
