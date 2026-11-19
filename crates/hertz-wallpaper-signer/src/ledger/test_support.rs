// SPDX-License-Identifier: MIT
//! Isolated keys and protected files; no deployed identity or key is changed.
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use hertz_wallpaper::{
    manifest::Permissions,
    release::{
        authorization::{
            AuthorizationChain, KeyAuthorization, PublicKey, SignedKeyAuthorization, WorkingKey,
        },
        KeyPurpose, Release, RevocationEntry, Revocations,
    },
};

use super::Ledger;
use crate::{
    config::{Config, KeyConfig},
    platform,
    protocol::{self, Approval, Document, Evidence, Request, Response, Result},
};

pub(super) struct Fixture {
    pub config: Config,
    root: PathBuf,
    base: PathBuf,
}

impl Fixture {
    pub fn new() -> Self {
        #[cfg(windows)]
        let base = PathBuf::from(std::env::var_os("USERPROFILE").expect("user profile"));
        #[cfg(unix)]
        let base = PathBuf::from(std::env::var_os("HOME").expect("user home"));
        let root = base.join(format!("hertz-signer-test-{}", uuid::Uuid::new_v4()));
        let service = platform::current_identity().expect("current OS identity");
        for path in [
            &root,
            &root.join("data"),
            &root.join("checkpoints"),
            &root.join("keys"),
        ] {
            private_directory(path, &service);
        }
        #[cfg(windows)]
        let identities = [
            "S-1-5-21-1-2-3-1001",
            "S-1-5-21-1-2-3-1002",
            "S-1-5-21-1-2-3-1003",
        ];
        #[cfg(unix)]
        let identities = ["4000000001", "4000000002", "4000000003"];
        let config = Config {
            ledger_id: uuid::Uuid::new_v4().to_string(),
            hub_id: uuid::Uuid::new_v4().to_string(),
            service_identity: service,
            hub_identity: identities[0].into(),
            approver_identities: identities[1..].iter().map(|s| (*s).into()).collect(),
            #[cfg(windows)]
            endpoint: format!(r"\\.\pipe\hertz-wallpaper-signer-{}", uuid::Uuid::new_v4()),
            #[cfg(unix)]
            endpoint: root.join("signer.sock").to_string_lossy().into_owned(),
            database_path: root.join("data/signer.db"),
            checkpoint_directory: root.join("checkpoints"),
            release_key: KeyConfig {
                key_id: String::new(),
                seed_file: PathBuf::new(),
            },
            revocations_key: KeyConfig {
                key_id: String::new(),
                seed_file: PathBuf::new(),
            },
            authorization_chain_file: PathBuf::new(),
            root_fingerprint: String::new(),
            max_database_bytes: 16 * 1024 * 1024,
        };
        let mut fixture = Self { config, root, base };
        fixture.config = fixture.generation_config(1);
        fixture
    }

    pub fn generation_config(&self, generation: u8) -> Config {
        let mut config = self.config.clone();
        let root_key = SigningKey::from_bytes(&[11; 32]);
        let bootstrap = public("root-1", &root_key);
        let mut chain = AuthorizationChain {
            bootstrap_root: bootstrap.clone(),
            authorizations: vec![],
        };
        for number in 1..=generation {
            let release = SigningKey::from_bytes(&[21 + number; 32]);
            let revocations = SigningKey::from_bytes(&[31 + number; 32]);
            let body = KeyAuthorization {
                hub_id: config.hub_id.clone(),
                generation: number as u64,
                previous_digest: chain
                    .authorizations
                    .last()
                    .map(|a| a.authorization.canonical_digest().unwrap()),
                root_key_id: bootstrap.key_id.clone(),
                keys: [
                    WorkingKey {
                        purpose: KeyPurpose::Release,
                        key: public(&format!("release-{number}"), &release),
                    },
                    WorkingKey {
                        purpose: KeyPurpose::Revocations,
                        key: public(&format!("revocations-{number}"), &revocations),
                    },
                ],
                next_root: None,
            };
            let signature =
                URL_SAFE_NO_PAD.encode(root_key.sign(&body.signing_bytes().unwrap()).to_bytes());
            chain.authorizations.push(SignedKeyAuthorization {
                authorization: body,
                signature,
            });
        }
        config.release_key = KeyConfig {
            key_id: format!("release-{generation}"),
            seed_file: self.root.join(format!("keys/release-{generation}.seed")),
        };
        config.revocations_key = KeyConfig {
            key_id: format!("revocations-{generation}"),
            seed_file: self
                .root
                .join(format!("keys/revocations-{generation}.seed")),
        };
        config.authorization_chain_file = self.root.join(format!("keys/chain-{generation}.json"));
        config.root_fingerprint = bootstrap.fingerprint().unwrap();
        for (path, bytes) in [
            (&config.release_key.seed_file, vec![21 + generation; 32]),
            (&config.revocations_key.seed_file, vec![31 + generation; 32]),
            (
                &config.authorization_chain_file,
                serde_json::to_vec(&chain).unwrap(),
            ),
        ] {
            platform::new_private_bytes(path, &config.service_identity, &bytes)
                .expect("protected fixture file");
        }
        let path = self.root.join(format!("config-{generation}.toml"));
        platform::new_private_bytes(
            &path,
            &config.service_identity,
            toml::to_string(&config).unwrap().as_bytes(),
        )
        .unwrap();
        Config::load(&path).expect("validated isolated configuration")
    }

    pub async fn open(&self) -> Ledger {
        Ledger::initialize(&self.config)
            .await
            .expect("explicit fixture initialization");
        Ledger::open(self.config.clone(), None)
            .await
            .expect("open protected ledger")
    }

    pub fn release(&self, version: u64, tag: char) -> Document {
        Document::Release(Release {
            hub_id: self.config.hub_id.clone(),
            work_id: "22222222-2222-4222-8222-222222222222".into(),
            release_id: uuid::Uuid::new_v4().to_string(),
            version,
            package_hash: tag.to_string().repeat(64),
            bytes: 16,
            permissions: Permissions {
                audio_spectrum: false,
                pointer: false,
            },
            min_engine_protocol: 1,
            published_at: protocol::now().unwrap() as u64 - 1,
            key_id: self.config.release_key.key_id.clone(),
        })
    }

    pub fn revocations(&self, sequence: u64, entries: Vec<RevocationEntry>) -> Document {
        let now = protocol::now().unwrap() as u64;
        Document::Revocations(Revocations {
            hub_id: self.config.hub_id.clone(),
            sequence,
            issued_at: now - 1,
            expires_at: now + 1800,
            entries,
            key_id: self.config.revocations_key.key_id.clone(),
        })
    }

    pub async fn approve(&self, ledger: &mut Ledger, approval: &Approval) -> Result<Response> {
        ledger
            .handle(
                &self.config.approver_identities[0],
                Request::Approve {
                    approval: Box::new(approval.clone()),
                    confirmed_digest: approval.document.digest().unwrap(),
                },
            )
            .await
    }

    pub async fn sign(&self, ledger: &mut Ledger, approval: &Approval) -> Result<Response> {
        let operation_id = approval.operation_id.clone();
        let body_digest = approval.document.digest().unwrap();
        let request = match approval.document {
            Document::Release(_) => Request::SignRelease {
                operation_id,
                body_digest,
            },
            Document::Revocations(_) => Request::SignRevocations {
                operation_id,
                body_digest,
            },
        };
        ledger.handle(&self.config.hub_identity, request).await
    }

    pub async fn query(&self, ledger: &mut Ledger, approval: &Approval) -> Result<Response> {
        ledger
            .handle(
                &self.config.hub_identity,
                Request::Query {
                    operation_id: approval.operation_id.clone(),
                    body_digest: approval.document.digest().unwrap(),
                },
            )
            .await
    }

    pub fn snapshot_path(&self) -> PathBuf {
        self.root.join("snapshot.db")
    }

    #[cfg(windows)]
    pub fn directory_with_foreign_access(&self, rights: &str) -> PathBuf {
        let path = self.root.join(format!("acl-{}", uuid::Uuid::new_v4()));
        windows_directory(
            &path,
            &self.config.service_identity,
            &format!("(A;;{rights};;;WD)"),
        );
        path
    }

    #[cfg(windows)]
    pub fn private_child(&self, parent: &Path) -> PathBuf {
        let path = parent.join("protected");
        private_directory(&path, &self.config.service_identity);
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Only this freshly created UUID directory can be recursively removed.
        if self.root.is_absolute()
            && self.root.parent() == Some(self.base.as_path())
            && self
                .root
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("hertz-signer-test-"))
        {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

pub(super) fn approval(document: Document) -> Approval {
    Approval {
        operation_id: uuid::Uuid::new_v4().to_string(),
        document,
        evidence: Evidence {
            license_checked: true,
            sources_checked: true,
            static_scan_passed: true,
            preview_evidence: "isolated declarative fixture reviewed".into(),
            reason: "fixture approval".into(),
        },
    }
}

pub(super) fn assert_error<T>(result: Result<T>, expected: &str) {
    match result {
        Err(error) => assert_eq!(error.0, expected),
        Ok(_) => panic!("expected {expected}"),
    }
}

pub(super) async fn count(ledger: &Ledger, table: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
        .fetch_one(&ledger.pool)
        .await
        .unwrap()
}

pub(super) async fn interrupt_signature(
    fixture: &Fixture,
    ledger: &mut Ledger,
    approval: &Approval,
) {
    sqlx::raw_sql("CREATE TRIGGER interrupt_signature BEFORE UPDATE OF envelope_json ON signing_intents BEGIN SELECT RAISE(ABORT,'fixture interruption'); END")
        .execute(&ledger.pool).await.unwrap();
    assert_error(
        fixture.sign(ledger, approval).await,
        "operation_outcome_unknown",
    );
    assert_eq!(
        fixture.query(ledger, approval).await.unwrap().state,
        "registered"
    );
    sqlx::raw_sql("DROP TRIGGER interrupt_signature")
        .execute(&ledger.pool)
        .await
        .unwrap();
}

fn public(id: &str, key: &SigningKey) -> PublicKey {
    PublicKey::from_bytes(id.into(), key.verifying_key().as_bytes()).unwrap()
}

#[cfg(unix)]
fn private_directory(path: &Path, _identity: &str) {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(path).unwrap();
}

#[cfg(windows)]
fn private_directory(path: &Path, identity: &str) {
    windows_directory(path, identity, "");
}

#[cfg(windows)]
fn windows_directory(path: &Path, identity: &str, extra_acl: &str) {
    use std::{os::windows::ffi::OsStrExt, ptr::null_mut};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::CreateDirectoryW,
    };
    let sddl: Vec<u16> = format!("O:{identity}D:P(A;OICI;FA;;;{identity}){extra_acl}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        },
        0
    );
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor,
        bInheritHandle: 0,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let created = unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) };
    let error = std::io::Error::last_os_error();
    unsafe {
        LocalFree(descriptor);
    }
    assert_ne!(created, 0, "protected test directory: {error}");
}
