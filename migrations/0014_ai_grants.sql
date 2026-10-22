-- AI 受限授权与 DataDir 实例身份（技术路线 R2-G，§5.4/§5.5/§7.3）。
-- 只存凭据摘要，不持久明文凭据；policy_revision 是授权策略的全局水位，
-- 任何 grant 变更都会递增，用于拒绝过期的授权上下文。

CREATE TABLE ai_instance (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_instance_id TEXT NOT NULL,
    policy_revision INTEGER NOT NULL DEFAULT 0,
    schema_version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE ai_grants (
    grant_id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    credential_digest TEXT NOT NULL,
    scopes TEXT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_ai_grants_digest ON ai_grants (credential_digest);
