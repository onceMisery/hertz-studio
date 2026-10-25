// SPDX-License-Identifier: MIT
//! Invitations contain data, never arbitrary executable URLs or redirect targets.
use crate::members::Secret;
use crate::tls::Fingerprint;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Deserialize;
use std::net::SocketAddr;
use uuid::Uuid;

const PREFIX: &str = "hertz-listen:v1:";
pub struct Invitation {
    pub address: SocketAddr,
    pub room_id: Uuid,
    pub fingerprint: Fingerprint,
    pub secret: Secret,
}
#[derive(Debug, thiserror::Error)]
#[error("invalid or unsupported room invitation")]
pub struct InvitationError;
impl Invitation {
    pub fn encode(&self) -> zeroize::Zeroizing<String> {
        let json = zeroize::Zeroizing::new(
            serde_json::json!({"address":self.address.to_string(), "room_id":self.room_id,
            "fingerprint":self.fingerprint.hex(),"secret":self.secret.expose()})
            .to_string(),
        );
        zeroize::Zeroizing::new(format!(
            "{PREFIX}{}",
            URL_SAFE_NO_PAD.encode(json.as_bytes())
        ))
    }
    pub fn parse(text: &str) -> Result<Self, InvitationError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            address: SocketAddr,
            room_id: Uuid,
            fingerprint: String,
            secret: Secret,
        }
        if text.len() > 2048 {
            return Err(InvitationError);
        }
        let encoded = text.trim().strip_prefix(PREFIX).ok_or(InvitationError)?;
        let decoded = zeroize::Zeroizing::new(
            URL_SAFE_NO_PAD
                .decode(encoded)
                .map_err(|_| InvitationError)?,
        );
        let fields: Fields = serde_json::from_slice(&decoded).map_err(|_| InvitationError)?;
        if fields.room_id.is_nil()
            || fields.address.port() == 0
            || fields.address.ip().is_unspecified()
            || fields.address.ip().is_multicast()
        {
            return Err(InvitationError);
        }
        Ok(Self {
            address: fields.address,
            room_id: fields.room_id,
            fingerprint: Fingerprint::parse(&fields.fingerprint).map_err(|_| InvitationError)?,
            secret: fields.secret,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strict_roundtrip_supports_ipv6_and_rejects_arbitrary_urls_or_extra_fields() {
        let invitation = Invitation {
            address: "[::1]:43210".parse().unwrap(),
            room_id: Uuid::new_v4(),
            fingerprint: Fingerprint::of(b"certificate"),
            secret: Secret::generate().unwrap(),
        };
        let encoded = invitation.encode();
        let parsed = Invitation::parse(&encoded).unwrap();
        assert_eq!(parsed.address, invitation.address);
        assert_eq!(parsed.room_id, invitation.room_id);
        assert_eq!(parsed.fingerprint, invitation.fingerprint);
        assert_eq!(parsed.secret.expose(), invitation.secret.expose());
        assert!(Invitation::parse("https://attacker/anything").is_err());
        assert!(Invitation::parse(&"x".repeat(3000)).is_err());
        let decoded = URL_SAFE_NO_PAD
            .decode(encoded.strip_prefix(PREFIX).unwrap())
            .unwrap();
        let mut fields: serde_json::Value = serde_json::from_slice(&decoded).unwrap();
        fields["url"] = "https://attacker".into();
        assert!(Invitation::parse(&format!(
            "{PREFIX}{}",
            URL_SAFE_NO_PAD.encode(fields.to_string())
        ))
        .is_err());
    }
}
