// SPDX-License-Identifier: MIT
//! Ephemeral signatures and real native database/package owners, with no network provider.
use std::{io::Write, path::Path};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use ed25519_dalek::{Signer, SigningKey};
use hertz_wallpaper::{
    release::{
        authorization::{
            AuthorizationChain, KeyAuthorization, PublicKey, SignedKeyAuthorization, WorkingKey,
        },
        KeyPurpose, Release, RevocationEntry, Revocations, SignedRelease, SignedRevocations,
    },
    Permissions,
};
use sha2::{Digest, Sha256};

use super::{
    model::{AuthProfile, SourceProfile},
    subscriptions::{Binding, DownloadPlan, Subscriptions},
    AcceptedRelease,
};
use crate::wallpaper::{
    assets::{AssetStore, StagedPackage},
    jobs::JobError,
    library::{tempfileish, InstallWork, Library},
    playlist::FixedVersion,
};

pub(super) const WORK_ID: &str = "22222222-2222-4222-8222-222222222222";

pub(super) struct Authority {
    pub profile: SourceProfile,
    pub issued: u64,
}

impl Authority {
    pub fn new(origin: &str) -> Self {
        let root = SigningKey::from_bytes(&[11; 32]);
        Self {
            profile: SourceProfile {
                source_id: uuid::Uuid::new_v4().to_string(),
                origin: origin.into(),
                hub_id: uuid::Uuid::new_v4().to_string(),
                root_fingerprint: public("root-1", &root).fingerprint().unwrap(),
                auth: AuthProfile {
                    issuer: format!("{origin}/oidc"),
                    client_id: "native-public-client".into(),
                    audience: "wallpaper-hub".into(),
                    scopes: ["openid", "profile", "wallpaper.read", "wallpaper.write"]
                        .map(String::from)
                        .to_vec(),
                    algorithms: vec!["RS256".into()],
                },
            },
            issued: super::now() - 1,
        }
    }

    pub fn chain(&self, generation: u8) -> Vec<u8> {
        let root = SigningKey::from_bytes(&[11; 32]);
        let mut chain = AuthorizationChain {
            bootstrap_root: public("root-1", &root),
            authorizations: vec![],
        };
        for n in 1..=generation {
            let authorization = KeyAuthorization {
                hub_id: self.profile.hub_id.clone(),
                generation: n.into(),
                previous_digest: chain
                    .authorizations
                    .last()
                    .map(|a| a.authorization.canonical_digest().unwrap()),
                root_key_id: "root-1".into(),
                keys: [
                    WorkingKey {
                        purpose: KeyPurpose::Release,
                        key: public(
                            &format!("release-{n}"),
                            &SigningKey::from_bytes(&[21 + n; 32]),
                        ),
                    },
                    WorkingKey {
                        purpose: KeyPurpose::Revocations,
                        key: public(
                            &format!("revocations-{n}"),
                            &SigningKey::from_bytes(&[31 + n; 32]),
                        ),
                    },
                ],
                next_root: None,
            };
            let signature = signature(&root, &authorization.signing_bytes().unwrap());
            chain.authorizations.push(SignedKeyAuthorization {
                authorization,
                signature,
            });
        }
        serde_json::to_vec(&chain).unwrap()
    }

    pub fn release(&self, version: u64, hash: &str, generation: u8) -> SignedRelease {
        self.sign_release(
            Release {
                hub_id: self.profile.hub_id.clone(),
                work_id: WORK_ID.into(),
                release_id: uuid::Uuid::new_v4().to_string(),
                version,
                package_hash: hash.into(),
                bytes: 16,
                permissions: Permissions {
                    audio_spectrum: false,
                    pointer: false,
                },
                min_engine_protocol: 1,
                published_at: self.issued,
                key_id: format!("release-{generation}"),
            },
            generation,
        )
    }

    pub fn sign_release(&self, release: Release, generation: u8) -> SignedRelease {
        let signature = signature(
            &SigningKey::from_bytes(&[21 + generation; 32]),
            &release.signing_bytes().unwrap(),
        );
        SignedRelease { release, signature }
    }

    pub fn revocations(
        &self,
        sequence: u64,
        entries: Vec<RevocationEntry>,
        generation: u8,
    ) -> Vec<u8> {
        self.revocations_at(
            sequence,
            entries,
            generation,
            self.issued,
            self.issued + 1800,
        )
    }

    pub fn revocations_at(
        &self,
        sequence: u64,
        entries: Vec<RevocationEntry>,
        generation: u8,
        issued: u64,
        expires: u64,
    ) -> Vec<u8> {
        let revocations = Revocations {
            hub_id: self.profile.hub_id.clone(),
            sequence,
            entries,
            issued_at: issued,
            expires_at: expires,
            key_id: format!("revocations-{generation}"),
        };
        let signature = signature(
            &SigningKey::from_bytes(&[31 + generation; 32]),
            &revocations.signing_bytes().unwrap(),
        );
        serde_json::to_vec(&SignedRevocations {
            revocations,
            signature,
        })
        .unwrap()
    }
}

pub(super) struct Fixture {
    root: tempfileish::TempDir,
    pub library: Library,
    pub assets: AssetStore,
    pub authority: Authority,
}

impl Fixture {
    pub async fn new() -> Self {
        let root = tempfileish::temp_dir("community-security");
        let library = Library::open(root.path()).await.unwrap();
        let assets = AssetStore::new(root.path()).unwrap();
        assets.bind_trust(library.trust().clone()).unwrap();
        Self {
            root,
            library,
            assets,
            authority: Authority::new("https://community.example"),
        }
    }
    pub fn root(&self) -> &Path {
        self.root.path()
    }
    pub async fn confirm(&self) {
        let a = &self.authority;
        self.library
            .trust()
            .confirm_source(&a.profile, &a.chain(1), &a.profile.root_fingerprint)
            .await
            .unwrap();
    }
    pub async fn accept(&self, release: &SignedRelease) -> AcceptedRelease {
        let a = &self.authority;
        self.library
            .trust()
            .accept(
                &a.profile.source_id,
                &a.chain(1),
                &a.revocations(1, vec![], 1),
                Some((&serde_json::to_vec(release).unwrap(), WORK_ID)),
            )
            .await
            .unwrap()
            .unwrap()
    }
    pub fn staged(&self, version: u32, permissions: Permissions) -> (String, StagedPackage, u64) {
        let bytes = package(version, &permissions);
        let job = uuid::Uuid::new_v4().to_string();
        let source = self.root().join(format!("source-{job}.hwpkg"));
        std::fs::write(&source, &bytes).unwrap();
        let snapshot = self.assets.snapshot_input(&job, &source, None).unwrap();
        let package = self.assets.validate_staged(&job).unwrap();
        assert_eq!(package.package_hash, snapshot.sha256);
        (job, package, snapshot.bytes)
    }
    pub async fn install(
        &self,
        job: &str,
        package: &StagedPackage,
        bytes: u64,
        source: &str,
    ) -> FixedVersion {
        self.assets.unpack_projection(job, package).unwrap();
        self.assets
            .content_writer()
            .unwrap()
            .publish_staging(job, &package.package_hash)
            .unwrap();
        let work_key = format!("{source}:{WORK_ID}");
        self.library
            .install(&InstallWork {
                remote_work_id: WORK_ID.into(),
                work_key: work_key.clone(),
                title: package.manifest.title.clone(),
                description: package.manifest.description.clone(),
                kind: "image".into(),
                package_hash: package.package_hash.clone(),
                manifest_json: package.manifest_json.clone(),
                package_bytes: bytes,
                version: package.manifest.version,
                source_id: source.into(),
            })
            .await
            .unwrap();
        FixedVersion {
            work_key,
            package_hash: package.package_hash.clone(),
        }
    }
    pub async fn prepare_update(
        &self,
        version: u32,
        previous: Option<FixedVersion>,
    ) -> (DownloadPlan, FixedVersion) {
        let subs = Subscriptions::new(&self.library);
        let sub = subs
            .subscribe(&self.authority.profile.source_id, WORK_ID)
            .await
            .unwrap();
        let mut plan = DownloadPlan {
            operation_id: uuid::Uuid::new_v4().to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            subscription_id: sub.subscription_id,
            source_id: sub.source_id,
            remote_work_id: sub.remote_work_id,
            binding: binding(sub.revision, previous),
        };
        if let Ok(bytes) = std::fs::read(self.root().join("config.json")) {
            plan.binding.config_revision = serde_json::from_slice::<serde_json::Value>(&bytes)
                .unwrap()["revision"]
                .as_u64()
                .unwrap();
        }
        let (job, package, bytes) = self.staged(
            version,
            Permissions {
                audio_spectrum: false,
                pointer: false,
            },
        );
        let mut release = self
            .authority
            .release(version.into(), &package.package_hash, 1)
            .release;
        release.bytes = bytes;
        let accepted = self.accept(&self.authority.sign_release(release, 1)).await;
        accepted.validate_package(&package, bytes).unwrap();
        subs.register(&plan, &job, &hash(&serde_json::to_vec(&plan).unwrap()))
            .await
            .unwrap();
        subs.save_release(&plan, &accepted).await.unwrap();
        subs.delta(&plan.operation_id, &package, &accepted)
            .await
            .unwrap();
        let fixed = self.install(&job, &package, bytes, &plan.source_id).await;
        (plan, fixed)
    }
    pub async fn close(self) -> tempfileish::TempDir {
        self.library.pool().close().await;
        (&*self.library.trust().pool).close().await;
        self.root
    }
}

pub(super) fn binding(revision: i64, previous: Option<FixedVersion>) -> Binding {
    Binding {
        config_revision: 4,
        config_digest: "1".repeat(64),
        topology_digest: "2".repeat(64),
        group_id: "group-1".into(),
        selection_json: "{}".into(),
        previous,
        subscription_revision: revision,
        playlist_revision: None,
    }
}

pub(super) fn assert_error<T>(result: Result<T, JobError>, expected: &str) {
    match result {
        Err(error) => assert_eq!(error.code, expected, "{}", error.message),
        Ok(_) => panic!("expected {expected}"),
    }
}

pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn config_receipt(
    root: &Path,
    request: &str,
    digest: &str,
    revision: u64,
    command: &str,
    saved: bool,
) {
    use crate::config_journal::{caller_sid, FileLock, Intent, Store};
    let _lock = FileLock::acquire(root).unwrap();
    let intent = Intent {
        caller_sid: caller_sid().unwrap(),
        request_id: request.into(),
        payload_digest: digest.into(),
        command: command.into(),
    };
    let base =
        serde_json::to_vec(&serde_json::json!({"revision":revision-1,"lastCommit":null})).unwrap();
    let target = serde_json::to_vec(&serde_json::json!({"revision":revision,"lastCommit":{"requestId":request,"payloadDigest":digest}})).unwrap();
    std::fs::write(root.join("config.json"), &base).unwrap();
    let mut store = Store::open(root).unwrap();
    store.prepare(&intent, &base, &target).unwrap();
    if saved {
        std::fs::write(root.join("config.json"), &target).unwrap();
    }
    store.finish(&intent.caller_sid, request, saved).unwrap();
}

fn public(id: &str, key: &SigningKey) -> PublicKey {
    PublicKey::from_bytes(id.into(), key.verifying_key().as_bytes()).unwrap()
}
fn signature(key: &SigningKey, bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(key.sign(bytes).to_bytes())
}
fn package(version: u32, permissions: &Permissions) -> Vec<u8> {
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==").unwrap();
    let manifest = serde_json::json!({
        "formatVersion":1,"workId":WORK_ID,"version":version,"title":format!("Community fixture {version}"),"description":"",
        "content":{"kind":"image","asset":"background"},
        "assets":[{"id":"background","kind":"image","source":"assets/background.png","variants":[]}],
        "files":[{"path":"assets/background.png","bytes":png.len(),"sha256":hash(&png),"mime":"image/png"}],
        "properties":[],"permissions":permissions,"license":{"code":"none","assets":"CC0-1.0","attribution":""}
    });
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("assets/background.png", png),
    ] {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
