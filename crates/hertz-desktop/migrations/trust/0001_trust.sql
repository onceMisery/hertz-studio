-- Independent security state. Never include this database in library rollback.
CREATE TABLE trust_clock (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
    observed_at INTEGER NOT NULL CHECK(observed_at>=0)
);
INSERT INTO trust_clock(singleton,observed_at) VALUES(1,0);
CREATE TABLE trust_sources (
    source_id TEXT PRIMARY KEY NOT NULL,
    origin TEXT NOT NULL UNIQUE,
    hub_id TEXT NOT NULL UNIQUE,
    root_fingerprint TEXT NOT NULL CHECK(length(root_fingerprint)=64),
    profile_json TEXT NOT NULL CHECK(length(CAST(profile_json AS BLOB))<=65536),
    chain_json TEXT NOT NULL CHECK(length(CAST(chain_json AS BLOB))<=262144),
    generation INTEGER NOT NULL CHECK(generation>0),
    authorization_digest TEXT NOT NULL CHECK(length(authorization_digest)=64),
    revocations_json TEXT CHECK(length(CAST(revocations_json AS BLOB))<=1048576),
    revocations_watermark TEXT CHECK(length(CAST(revocations_watermark AS BLOB))<=2097152),
    observed_at INTEGER NOT NULL DEFAULT 0,
    last_sync INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE release_watermarks (
    source_id TEXT NOT NULL REFERENCES trust_sources(source_id),
    remote_work_id TEXT NOT NULL,
    channel TEXT NOT NULL CHECK(channel='stable'),
    watermark_json TEXT NOT NULL CHECK(length(CAST(watermark_json AS BLOB))<=4096),
    PRIMARY KEY(source_id,remote_work_id,channel)
);
CREATE TABLE release_receipts (
    source_id TEXT NOT NULL REFERENCES trust_sources(source_id),
    remote_work_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version>0),
    package_hash TEXT NOT NULL CHECK(length(package_hash)=64),
    digest TEXT NOT NULL CHECK(length(digest)=64),
    envelope_json TEXT NOT NULL CHECK(length(CAST(envelope_json AS BLOB))<=65536),
    content_kind TEXT,
    PRIMARY KEY(source_id,remote_work_id,version)
);
CREATE INDEX receipts_hash ON release_receipts(package_hash);
CREATE TABLE security_hashes (
    package_hash TEXT PRIMARY KEY NOT NULL CHECK(length(package_hash)=64),
    effective_at INTEGER NOT NULL CHECK(effective_at>0)
);
CREATE TABLE activated_web_hashes (
    package_hash TEXT PRIMARY KEY NOT NULL CHECK(length(package_hash)=64),
    activated_at INTEGER NOT NULL CHECK(activated_at>0)
);
