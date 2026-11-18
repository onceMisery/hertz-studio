-- SPDX-License-Identifier: MIT
CREATE TABLE hub_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    hub_id TEXT NOT NULL, public_origin TEXT NOT NULL, issuer TEXT NOT NULL,
    client_id TEXT NOT NULL, api_audience TEXT NOT NULL
);
CREATE TABLE users (
    id TEXT PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('author','moderator','admin')),
    created_at INTEGER NOT NULL, UNIQUE(issuer,subject)
);
CREATE TABLE works (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
    operation_id TEXT NOT NULL, operation_digest TEXT NOT NULL,
    title TEXT NOT NULL, license_json TEXT NOT NULL, next_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, UNIQUE(owner_id,operation_id)
);
CREATE TABLE uploads (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id),
    work_id TEXT NOT NULL REFERENCES works(id), operation_id TEXT NOT NULL, operation_digest TEXT NOT NULL,
    package_hash TEXT NOT NULL, expected_bytes INTEGER NOT NULL CHECK(expected_bytes BETWEEN 1 AND 536870912),
    min_engine_protocol INTEGER NOT NULL CHECK(min_engine_protocol BETWEEN 1 AND 4294967295),
    state TEXT NOT NULL CHECK(state IN ('reserved','receiving','ready','validating','submitted','rejected','expired')),
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, release_id TEXT, purged_at INTEGER,
    UNIQUE(owner_id,operation_id)
);
CREATE INDEX uploads_active ON uploads(state,expires_at);
CREATE TABLE releases (
    id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), owner_id TEXT NOT NULL REFERENCES users(id),
    upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id), version INTEGER NOT NULL,
    package_hash TEXT NOT NULL, bytes INTEGER NOT NULL,
    title TEXT NOT NULL, description TEXT NOT NULL, kind TEXT NOT NULL,
    license_json TEXT NOT NULL, permissions_json TEXT NOT NULL, permissions_digest TEXT NOT NULL,
    body_json TEXT NOT NULL, body_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending_review','approved_pending_signature','signed_pending_public',
        'published','rejected','withdrawn','security_revoked','copyright_revoked')),
    signed_release TEXT, created_at INTEGER NOT NULL, UNIQUE(work_id,version)
);
CREATE INDEX releases_public ON releases(state,created_at);
CREATE TABLE reviews (
    id TEXT PRIMARY KEY, release_id TEXT NOT NULL REFERENCES releases(id),
    reviewer_id TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL, operation_digest TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
    package_hash TEXT NOT NULL, permissions_digest TEXT NOT NULL, body_digest TEXT NOT NULL,
    evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(reviewer_id,operation_id)
);
CREATE TABLE reports (
    id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id),
    release_id TEXT NOT NULL REFERENCES releases(id), operation_id TEXT NOT NULL, operation_digest TEXT NOT NULL,
    reason TEXT NOT NULL, description TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(author_id,operation_id)
);
CREATE TABLE revocations (
    package_hash TEXT PRIMARY KEY, reason TEXT NOT NULL CHECK(reason IN ('security','copyright')),
    effective_at INTEGER NOT NULL, snapshot_sequence INTEGER NOT NULL
);
CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL,
    object_id TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX audit_actor_action ON audit_events(actor_id,action,created_at);
