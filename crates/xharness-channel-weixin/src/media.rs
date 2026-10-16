//! The CDN cipher is prescribed by the platform, not a new application cipher.
//! Keys, download params and signed URLs must not appear in diagnostics.
use crate::client::{base_info, bounded, transport_error};
use crate::{bounded_string, Client, Error};
use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::Aes128;
use base64::{engine::general_purpose::STANDARD, Engine};
use md5::{Digest, Md5};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub const MAX_ATTACHMENT_BYTES: usize = 4 * 1024 * 1024;

pub struct MediaKey([u8; 16]);
impl std::fmt::Debug for MediaKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MediaKey([redacted])")
    }
}
impl MediaKey {
    pub fn from_hex(value: &str) -> Result<Self, Error> {
        if value.len() != 32 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(Error::InvalidMedia);
        }
        let mut key = [0u8; 16];
        for (index, part) in value.as_bytes().as_chunks::<2>().0.iter().enumerate() {
            let hex = std::str::from_utf8(part).map_err(|_| Error::InvalidMedia)?;
            key[index] = u8::from_str_radix(hex, 16).map_err(|_| Error::InvalidMedia)?;
        }
        Ok(Self(key))
    }
    pub fn from_base64(value: &str) -> Result<Self, Error> {
        if value.len() > 64 {
            return Err(Error::InvalidMedia);
        }
        let raw = STANDARD.decode(value).map_err(|_| Error::InvalidMedia)?;
        if let Ok(key) = <[u8; 16]>::try_from(raw.as_slice()) {
            return Ok(Self(key));
        }
        if raw.len() == 32 {
            return Self::from_hex(std::str::from_utf8(&raw).map_err(|_| Error::InvalidMedia)?);
        }
        Err(Error::InvalidMedia)
    }
    fn hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }
    fn random() -> Result<Self, Error> {
        let mut key = [0u8; 16];
        getrandom::getrandom(&mut key).map_err(|_| Error::Configuration)?;
        Ok(Self(key))
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaKind {
    Image,
    File,
    Video,
}
impl MediaKind {
    fn wire(self) -> u8 {
        match self {
            Self::Image => 1,
            Self::Video => 2,
            Self::File => 3,
        }
    }
}

#[derive(Deserialize)]
pub struct MediaReference {
    encrypt_query_param: Option<String>,
    aes_key: Option<String>,
    encrypt_type: Option<u8>,
    full_url: Option<String>,
}
impl std::fmt::Debug for MediaReference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MediaReference([redacted])")
    }
}
impl MediaReference {
    pub fn from_json(value: Value) -> Result<Self, Error> {
        let reference: Self = serde_json::from_value(value).map_err(|_| Error::InvalidMedia)?;
        reference.validate()?;
        Ok(reference)
    }
    fn validate(&self) -> Result<(), Error> {
        if self.encrypt_type.is_some_and(|n| n != 1)
            || self
                .encrypt_query_param
                .as_ref()
                .is_some_and(|p| !bounded_string(p, 16 * 1024))
            || self
                .full_url
                .as_ref()
                .is_some_and(|p| !bounded_string(p, 16 * 1024))
            || (self.full_url.is_none() && self.encrypt_query_param.is_none())
        {
            return Err(Error::InvalidMedia);
        }
        Ok(())
    }
}
pub struct UploadedMedia {
    key: MediaKey,
    download_param: String,
    pub plaintext_bytes: usize,
    pub ciphertext_bytes: usize,
    kind: MediaKind,
}
impl std::fmt::Debug for UploadedMedia {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UploadedMedia([redacted])")
    }
}
impl Client {
    /// Only call after trusted sender authorization, not from an arbitrary URL
    /// in a controller command. Host still validates the decrypted content.
    pub async fn download_media(
        &self,
        reference: &MediaReference,
        key_override: Option<&MediaKey>,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, Error> {
        reference.validate()?;
        let parsed_key;
        let key = match key_override {
            Some(key) => key,
            None => {
                parsed_key = MediaKey::from_base64(
                    reference.aes_key.as_deref().ok_or(Error::InvalidMedia)?,
                )?;
                &parsed_key
            }
        };
        let url = match &reference.full_url {
            Some(url) => self.http.validate_cdn(url)?,
            None => {
                let mut url = self
                    .http
                    .cdn_base
                    .join("download")
                    .map_err(|_| Error::InvalidMedia)?;
                url.query_pairs_mut().append_pair(
                    "encrypted_query_param",
                    reference
                        .encrypt_query_param
                        .as_deref()
                        .ok_or(Error::InvalidMedia)?,
                );
                url
            }
        };
        let cipher = tokio::select! {
            biased;
            _ = cancel.cancelled()=>return Err(Error::Cancelled),
            result = async {
                let response = self.http.client.get(url).send().await.map_err(|e|transport_error(e,false))?;
                if response.status() != reqwest::StatusCode::OK { return Err(Error::InvalidMedia); }
                bounded(response,MAX_ATTACHMENT_BYTES+16).await.map_err(|_| Error::InvalidMedia)
            }=>result?,
        };
        decrypt(&cipher, key)
    }
    /// Uploads a bounded in-memory buffer only; no local filesystem paths.
    /// Upload is not a chat send and never completes the caller's outbox record.
    pub async fn upload_media(
        &self,
        to: &str,
        kind: MediaKind,
        plaintext: &[u8],
        cancel: &CancellationToken,
    ) -> Result<UploadedMedia, Error> {
        if !bounded_string(to, 512)
            || plaintext.is_empty()
            || plaintext.len() > MAX_ATTACHMENT_BYTES
        {
            return Err(Error::InvalidMedia);
        }
        let key = MediaKey::random()?;
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| Error::Configuration)?;
        let filekey: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let cipher = encrypt(plaintext, &key)?;
        let payload = json!({"filekey":filekey,"media_type":kind.wire(),"to_user_id":to,
            "rawsize":plaintext.len(),"rawfilemd5":format!("{:x}",Md5::digest(plaintext)),
            "filesize":cipher.len(),"no_need_thumb":true,"aeskey":key.hex(),"base_info":base_info()});
        let request = self
            .http
            .post("ilink/bot/getuploadurl", Some(&self.token), payload)?;
        let value = self.http.json(request, false, cancel).await?;
        let response: UploadWire =
            serde_json::from_value(value).map_err(|_| Error::MalformedResponse)?;
        let url = match response.upload_full_url.filter(|s| !s.is_empty()) {
            Some(url) => self.http.validate_cdn(&url)?,
            None => {
                let param = response
                    .upload_param
                    .filter(|s| bounded_string(s, 16 * 1024))
                    .ok_or(Error::MalformedResponse)?;
                let mut url = self
                    .http
                    .cdn_base
                    .join("upload")
                    .map_err(|_| Error::InvalidMedia)?;
                url.query_pairs_mut()
                    .append_pair("encrypted_query_param", &param)
                    .append_pair("filekey", &filekey);
                url
            }
        };
        let ciphertext_bytes = cipher.len();
        let download_param = tokio::select! {
            biased;
            _=cancel.cancelled()=>return Err(Error::Cancelled),
            result=async {
                // Never attach the Bot bearer token to a signed CDN request.
                let response=self.http.client.post(url).header("Content-Type","application/octet-stream").body(cipher).send().await.map_err(|e|transport_error(e,false))?;
                if response.status()!=reqwest::StatusCode::OK {return Err(Error::InvalidMedia);}
                let param=response.headers().get("x-encrypted-param").and_then(|p|p.to_str().ok()).filter(|p|bounded_string(p,16*1024)).ok_or(Error::MalformedResponse)?.to_owned();
                bounded(response,64*1024).await?;
                Ok(param)
            }=>result?,
        };
        Ok(UploadedMedia {
            key,
            download_param,
            plaintext_bytes: plaintext.len(),
            ciphertext_bytes,
            kind,
        })
    }
    /// Caller must journal an intent before this method and reconcile an
    /// AmbiguousSend. No retry or ID regeneration occurs inside this transport.
    pub async fn send_media(
        &self,
        to: &str,
        context_token: &str,
        client_id: &str,
        media: &UploadedMedia,
        name: Option<&str>,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        let reference = json!({"encrypt_query_param":media.download_param,"aes_key":STANDARD.encode(media.key.hex()),"encrypt_type":1});
        let item = match media.kind {
            MediaKind::Image => {
                json!({"type":2,"image_item":{"media":reference,"mid_size":media.ciphertext_bytes}})
            }
            MediaKind::Video => {
                json!({"type":5,"video_item":{"media":reference,"video_size":media.ciphertext_bytes}})
            }
            MediaKind::File => {
                let name = name
                    .filter(|n| valid_filename(n))
                    .ok_or(Error::InvalidMedia)?;
                json!({"type":4,"file_item":{"media":reference,"file_name":name,"len":media.plaintext_bytes.to_string()}})
            }
        };
        self.send_item(to, context_token, client_id, item, cancel)
            .await
    }
}
#[derive(Deserialize)]
struct UploadWire {
    upload_param: Option<String>,
    upload_full_url: Option<String>,
}
pub(crate) fn valid_filename(value: &str) -> bool {
    bounded_string(value, 255) && value != "." && value != ".." && !value.contains(['/', '\\'])
}
fn encrypt(plaintext: &[u8], key: &MediaKey) -> Result<Vec<u8>, Error> {
    if plaintext.is_empty() || plaintext.len() > MAX_ATTACHMENT_BYTES {
        return Err(Error::InvalidMedia);
    }
    let padding = 16 - plaintext.len() % 16;
    let mut ciphertext = plaintext.to_vec();
    ciphertext.resize(plaintext.len() + padding, padding as u8);
    let cipher = Aes128::new_from_slice(&key.0).map_err(|_| Error::InvalidMedia)?;
    for block in ciphertext.as_chunks_mut::<16>().0 {
        cipher.encrypt_block(block.as_mut_slice().into());
    }
    Ok(ciphertext)
}
fn decrypt(ciphertext: &[u8], key: &MediaKey) -> Result<Vec<u8>, Error> {
    if ciphertext.is_empty()
        || !ciphertext.len().is_multiple_of(16)
        || ciphertext.len() > MAX_ATTACHMENT_BYTES + 16
    {
        return Err(Error::InvalidMedia);
    }
    let mut plaintext = ciphertext.to_vec();
    let cipher = Aes128::new_from_slice(&key.0).map_err(|_| Error::InvalidMedia)?;
    for block in plaintext.as_chunks_mut::<16>().0 {
        cipher.decrypt_block(block.as_mut_slice().into());
    }
    let padding = usize::from(*plaintext.last().ok_or(Error::InvalidMedia)?);
    if !(1..=16).contains(&padding)
        || plaintext[plaintext.len() - padding..]
            .iter()
            .any(|b| usize::from(*b) != padding)
    {
        return Err(Error::InvalidMedia);
    }
    plaintext.truncate(plaintext.len() - padding);
    if plaintext.is_empty() || plaintext.len() > MAX_ATTACHMENT_BYTES {
        return Err(Error::InvalidMedia);
    }
    Ok(plaintext)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn official_key_encodings_and_padding_round_trip() {
        let key = MediaKey::from_hex("000102030405060708090a0b0c0d0e0f").unwrap();
        for length in [1, 15, 16, 17, 255, MAX_ATTACHMENT_BYTES] {
            let bytes = vec![0x55; length];
            let cipher = encrypt(&bytes, &key).unwrap();
            assert_eq!(decrypt(&cipher, &key).unwrap(), bytes);
            assert_eq!(cipher.len(), (length / 16 + 1) * 16);
        }
        assert_eq!(
            MediaKey::from_base64(&STANDARD.encode(key.0)).unwrap().0,
            key.0
        );
        assert_eq!(
            MediaKey::from_base64(&STANDARD.encode(key.hex()))
                .unwrap()
                .0,
            key.0
        );
        assert!(MediaKey::from_base64("bad").is_err());
        assert!(!format!("{key:?}").contains("000102"));
    }
    #[test]
    fn independent_aes_ecb_known_vector_and_padding_rejection() {
        let key = MediaKey::from_hex("000102030405060708090a0b0c0d0e0f").unwrap();
        let plaintext = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff,
        ];
        let cipher = encrypt(&plaintext, &key).unwrap();
        assert_eq!(
            &cipher[..16],
            &[
                0x69, 0xc4, 0xe0, 0xd8, 0x6a, 0x7b, 0x04, 0x30, 0xd8, 0xcd, 0xb7, 0x80, 0x70, 0xb4,
                0xc5, 0x5a
            ]
        );
        assert!(decrypt(&cipher[..16], &key).is_err());
        assert!(decrypt(&cipher[..31], &key).is_err());
        assert!(encrypt(&[], &key).is_err());
    }
}
