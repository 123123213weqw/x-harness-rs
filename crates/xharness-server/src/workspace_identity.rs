//! Domain-separated machine endpoint identity before bearer disclosure. This
//! proof grants no write/RPC authority and is not a desktop authentication proof.
#![forbid(unsafe_code)]
#![deny(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::let_underscore_must_use,
    unused_must_use
)]
#![cfg_attr(
    not(test),
    forbid(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::let_underscore_must_use,
        unused_must_use
    )
)]

use hmac::{Hmac, Mac};
use sha2::Sha256;
#[derive(Debug)]
pub enum ProofError {
    InvalidInput,
    Key(hmac::digest::InvalidLength),
}
impl std::fmt::Display for ProofError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("workspace endpoint identity proof failed")
    }
}
impl std::error::Error for ProofError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Key(error) => Some(error),
            _ => None,
        }
    }
}
fn hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn mac(token: &str, nonce: &str, scope: &str) -> Result<Hmac<Sha256>, ProofError> {
    if !hex64(token) || !hex64(nonce) || !hex64(scope) {
        return Err(ProofError::InvalidInput);
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).map_err(ProofError::Key)?;
    mac.update(b"xharness-workspace-read-v1\0");
    mac.update(nonce.as_bytes());
    mac.update(scope.as_bytes());
    Ok(mac)
}
pub fn proof(token: &str, nonce: &str, scope: &str) -> Result<String, ProofError> {
    Ok(mac(token, nonce, scope)?
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
pub fn verify(token: &str, nonce: &str, scope: &str, proof: &str) -> Result<bool, ProofError> {
    if !hex64(proof) {
        return Ok(false);
    }
    let mut bytes = [0u8; 32];
    for (index, pair) in proof.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        let h = (pair[0] as char)
            .to_digit(16)
            .ok_or(ProofError::InvalidInput)?;
        let l = (pair[1] as char)
            .to_digit(16)
            .ok_or(ProofError::InvalidInput)?;
        bytes[index] = (h * 16 + l) as u8;
    }
    Ok(mac(token, nonce, scope)?.verify_slice(&bytes).is_ok())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn proof_binds_fresh_challenge_key_scope_and_separate_protocol_domain() {
        let token = "a".repeat(64);
        let nonce = "b".repeat(64);
        let scope = "c".repeat(64);
        let p = proof(&token, &nonce, &scope).unwrap();
        assert!(verify(&token, &nonce, &scope, &p).unwrap());
        assert!(!verify(&token, &"d".repeat(64), &scope, &p).unwrap());
        assert!(!verify(&token, &nonce, &"d".repeat(64), &p).unwrap());
        assert!(!verify(&"d".repeat(64), &nonce, &scope, &p).unwrap());
        assert!(!crate::verify_desktop_identity(&token, &nonce, &p));
        assert!(proof("short", &nonce, &scope).is_err());
        assert!(!verify(&token, &nonce, &scope, "invalid").unwrap());
    }
}
