-- SPDX-License-Identifier: MIT
-- This schema belongs only to an explicitly initialized independent Signer.
CREATE TABLE signer_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    identity_json TEXT NOT NULL
);
CREATE TABLE approvals (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('release','revocations')),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    canonical_body TEXT NOT NULL,
    approval_json TEXT NOT NULL,
    approval_digest TEXT NOT NULL CHECK(length(approval_digest) = 64),
    approver_identity TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('approved','revoked')),
    approved_at INTEGER NOT NULL CHECK(approved_at > 0),
    revoked_at INTEGER,
    CHECK((state = 'approved' AND revoked_at IS NULL) OR (state = 'revoked' AND revoked_at IS NOT NULL))
);
CREATE TABLE signing_intents (
    position INTEGER PRIMARY KEY CHECK(position > 0),
    operation_id TEXT NOT NULL UNIQUE REFERENCES approvals(operation_id),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    checkpoint_hash TEXT NOT NULL UNIQUE CHECK(length(checkpoint_hash) = 64),
    record_json TEXT NOT NULL,
    envelope_json TEXT,
    signed_at INTEGER,
    CHECK((envelope_json IS NULL AND signed_at IS NULL) OR (envelope_json IS NOT NULL AND signed_at IS NOT NULL))
);
CREATE TABLE release_watermarks (
    work_id TEXT PRIMARY KEY,
    release_id TEXT NOT NULL UNIQUE,
    version INTEGER NOT NULL CHECK(version > 0),
    package_hash TEXT NOT NULL CHECK(length(package_hash) = 64),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    published_at INTEGER NOT NULL CHECK(published_at > 0),
    operation_id TEXT NOT NULL UNIQUE REFERENCES signing_intents(operation_id)
);
CREATE TABLE release_identities (
    release_id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    operation_id TEXT NOT NULL UNIQUE REFERENCES signing_intents(operation_id),
    UNIQUE(work_id,version)
);
CREATE TABLE revocations_watermark (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    sequence INTEGER NOT NULL CHECK(sequence > 0),
    issued_at INTEGER NOT NULL CHECK(issued_at > 0),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    document_json TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE REFERENCES signing_intents(operation_id)
);
CREATE TABLE security_revocations (
    package_hash TEXT PRIMARY KEY CHECK(length(package_hash) = 64),
    effective_at INTEGER NOT NULL CHECK(effective_at > 0)
);
PRAGMA application_id = 1213682481; -- HWS1
PRAGMA user_version = 1;
