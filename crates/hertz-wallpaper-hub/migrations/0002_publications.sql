-- SPDX-License-Identifier: MIT
CREATE TABLE publication_authority (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    root_fingerprint TEXT NOT NULL CHECK(length(root_fingerprint)=64),
    generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 128),
    authorization_digest TEXT NOT NULL CHECK(length(authorization_digest)=64),
    chain_json TEXT NOT NULL CHECK(length(CAST(chain_json AS BLOB))<=262144),
    signer_service_identity TEXT NOT NULL CHECK(length(CAST(signer_service_identity AS BLOB))<=256),
    signer_ledger_id TEXT NOT NULL CHECK(length(signer_ledger_id)=36)
);
CREATE TABLE publication_operations (
    operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36),
    actor_id TEXT NOT NULL REFERENCES users(id),
    kind TEXT NOT NULL CHECK(kind IN ('release','revocations')),
    object_id TEXT NOT NULL CHECK(length(CAST(object_id AS BLOB)) BETWEEN 1 AND 64),
    request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
    body_json TEXT NOT NULL CHECK(length(CAST(body_json AS BLOB)) BETWEEN 2 AND 1100000), body_digest TEXT NOT NULL CHECK(length(body_digest)=64),
    evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB)) BETWEEN 2 AND 16384),
    state TEXT NOT NULL CHECK(state IN ('prepared','awaiting_approval','requested','unknown','signed','published','rejected')),
    receipt_json TEXT CHECK(length(CAST(receipt_json AS BLOB))<=1100000), error_code TEXT CHECK(length(CAST(error_code AS BLOB))<=256),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(kind,object_id)
);
CREATE INDEX publication_pending ON publication_operations(state,updated_at);
CREATE TABLE revocation_snapshots (
    sequence INTEGER PRIMARY KEY CHECK(sequence>0),
    operation_id TEXT NOT NULL UNIQUE REFERENCES publication_operations(operation_id),
    body_digest TEXT NOT NULL CHECK(length(body_digest)=64),
    signed_document TEXT NOT NULL CHECK(length(CAST(signed_document AS BLOB))<=1048576),
    issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    published_at INTEGER NOT NULL
);
