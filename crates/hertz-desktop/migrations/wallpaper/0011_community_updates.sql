-- Product projection only. Root identities and monotonic safety live in trust.db.
CREATE TABLE community_accounts (
    source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(source_id),
    issuer TEXT NOT NULL CHECK(length(CAST(issuer AS BLOB)) BETWEEN 1 AND 2048),
    client_id TEXT NOT NULL CHECK(length(CAST(client_id AS BLOB)) BETWEEN 1 AND 256),
    subject TEXT NOT NULL CHECK(length(CAST(subject AS BLOB)) BETWEEN 1 AND 255),
    updated_at INTEGER NOT NULL
);
CREATE TABLE community_subscriptions (
    subscription_id TEXT PRIMARY KEY NOT NULL CHECK(length(subscription_id)=36),
    source_id TEXT NOT NULL REFERENCES sources(source_id),
    remote_work_id TEXT NOT NULL CHECK(length(remote_work_id)=36),
    channel TEXT NOT NULL DEFAULT 'stable' CHECK(channel='stable'),
    policy TEXT NOT NULL DEFAULT 'prompt' CHECK(policy IN ('prompt','cutpoint','startup')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    work_key TEXT REFERENCES works(work_key) CHECK(length(CAST(work_key AS BLOB))<=256),
    current_hash TEXT CHECK(length(current_hash)=64),
    previous_hash TEXT CHECK(length(previous_hash)=64),
    last_sync INTEGER NOT NULL DEFAULT 0,
    last_error TEXT CHECK(length(CAST(last_error AS BLOB))<=4096),
    UNIQUE(source_id,remote_work_id,channel)
);
CREATE TABLE community_updates (
    operation_id TEXT PRIMARY KEY NOT NULL CHECK(length(operation_id)=36),
    request_id TEXT NOT NULL UNIQUE CHECK(length(request_id)=36),
    subscription_id TEXT NOT NULL REFERENCES community_subscriptions(subscription_id),
    payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64),
    job_id TEXT NOT NULL UNIQUE CHECK(length(CAST(job_id AS BLOB)) BETWEEN 1 AND 64),
    binding_json TEXT NOT NULL CHECK(length(CAST(binding_json AS BLOB))<=16384),
    state TEXT NOT NULL CHECK(state IN ('queued','downloading','installed','ready','awaiting_confirmation','apply_requested','applied','failed','stale')),
    release_json TEXT CHECK(length(CAST(release_json AS BLOB))<=65536),
    candidate_hash TEXT CHECK(length(candidate_hash)=64),
    previous_hash TEXT CHECK(length(previous_hash)=64),
    delta_json TEXT CHECK(length(CAST(delta_json AS BLOB))<=16384),
    apply_request_id TEXT CHECK(length(apply_request_id)=36),
    apply_config_revision INTEGER CHECK(apply_config_revision>0),
    apply_config_digest TEXT CHECK(length(apply_config_digest)=64),
    apply_package_hash TEXT CHECK(length(apply_package_hash)=64),
    apply_work_key TEXT CHECK(length(CAST(apply_work_key AS BLOB))<=256),
    apply_rollback INTEGER NOT NULL DEFAULT 0 CHECK(apply_rollback IN (0,1)),
    error TEXT CHECK(length(CAST(error AS BLOB))<=4096),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX community_updates_pending ON community_updates(state,updated_at);
