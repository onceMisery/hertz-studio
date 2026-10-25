// SPDX-License-Identifier: MIT
//! Self-signed host identity with explicit SHA-256 pinning and TLS signature checks.
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, ServerConfig, SignatureScheme};
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpStream;
use tokio_rustls::{client::TlsStream, TlsConnector};

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("invalid host identity or certificate fingerprint")]
    Identity,
    #[error("TLS connection failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("TLS handshake timed out")]
    Timeout,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint([u8; 32]);
impl Fingerprint {
    pub fn of(certificate: &[u8]) -> Self {
        Self(Sha256::digest(certificate).into())
    }
    pub fn parse(text: &str) -> Result<Self, TlsError> {
        if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(TlsError::Identity);
        }
        let mut bytes = [0; 32];
        for (target, pair) in bytes.iter_mut().zip(text.as_bytes().as_chunks::<2>().0) {
            *target = u8::from_str_radix(
                std::str::from_utf8(pair).map_err(|_| TlsError::Identity)?,
                16,
            )
            .map_err(|_| TlsError::Identity)?;
        }
        Ok(Self(bytes))
    }
    pub fn hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }
}
impl std::fmt::Debug for Fingerprint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.hex())
    }
}

/// DER secret material is only exposed to the profile's secure persistence owner.
pub struct HostIdentity {
    certificate: Vec<u8>,
    private_key: zeroize::Zeroizing<Vec<u8>>,
}
impl HostIdentity {
    pub fn generate() -> Result<Self, TlsError> {
        let rcgen::CertifiedKey { cert, key_pair } =
            rcgen::generate_simple_self_signed(vec!["hertz.local".into(), "localhost".into()])
                .map_err(|_| TlsError::Identity)?;
        Ok(Self {
            certificate: cert.der().to_vec(),
            private_key: zeroize::Zeroizing::new(key_pair.serialize_der()),
        })
    }
    pub fn from_der(certificate: Vec<u8>, private_key: Vec<u8>) -> Result<Self, TlsError> {
        let identity = Self {
            certificate,
            private_key: zeroize::Zeroizing::new(private_key),
        };
        identity.server_config()?;
        Ok(identity)
    }
    pub fn certificate_der(&self) -> &[u8] {
        &self.certificate
    }
    pub fn private_key_der(&self) -> &[u8] {
        &self.private_key
    }
    pub fn fingerprint(&self) -> Fingerprint {
        Fingerprint::of(&self.certificate)
    }
    pub fn server_config(&self) -> Result<Arc<ServerConfig>, TlsError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|_| TlsError::Identity)?
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(self.certificate.clone())],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.private_key.to_vec())),
            )
            .map_err(|_| TlsError::Identity)?;
        Ok(Arc::new(config))
    }
}

#[derive(Debug)]
struct PinnedVerifier {
    fingerprint: Fingerprint,
    provider: Arc<rustls::crypto::CryptoProvider>,
}
impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if Fingerprint::of(end_entity.as_ref()) != self.fingerprint {
            return Err(rustls::Error::General(
                "host certificate fingerprint changed".into(),
            ));
        }
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
pub fn pinned_client_config(fingerprint: Fingerprint) -> Arc<ClientConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Arc::new(
        ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .expect("ring supports default TLS versions")
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
                fingerprint,
                provider,
            }))
            .with_no_client_auth(),
    )
}
pub async fn connect(
    address: SocketAddr,
    fingerprint: Fingerprint,
) -> Result<TlsStream<TcpStream>, TlsError> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let stream = TcpStream::connect(address).await?;
        stream.set_nodelay(true)?;
        TlsConnector::from(pinned_client_config(fingerprint))
            .connect(
                ServerName::try_from("hertz.local").expect("static DNS name"),
                stream,
            )
            .await
            .map_err(TlsError::from)
    })
    .await
    .map_err(|_| TlsError::Timeout)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn pinned_tls_roundtrip_rejects_different_host_and_reloads_identity() {
        let identity = HostIdentity::generate().unwrap();
        let fingerprint = identity.fingerprint();
        let restored = HostIdentity::from_der(
            identity.certificate_der().to_vec(),
            identity.private_key_der().to_vec(),
        )
        .unwrap();
        assert_eq!(restored.fingerprint(), fingerprint);
        assert_eq!(Fingerprint::parse(&fingerprint.hex()).unwrap(), fingerprint);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(identity.server_config().unwrap());
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                if let Ok(mut stream) = acceptor.accept(stream).await {
                    stream.write_all(b"ok").await.unwrap();
                }
            }
        });
        let mut stream = connect(address, fingerprint).await.unwrap();
        let mut reply = [0; 2];
        stream.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"ok");
        assert!(
            connect(address, HostIdentity::generate().unwrap().fingerprint())
                .await
                .is_err()
        );
        server.await.unwrap();
    }
}
