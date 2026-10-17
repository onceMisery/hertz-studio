-- AI 持久任务与提案（技术路线 R4-J / §7.3）。
-- brief 等原始输入不持久化：ai_jobs 只存 input_hash，输入存活在有界内存。
-- 终态单向（state + state_revision CAS），派发标记单向
-- （not_dispatched → may_have_been_sent），一个 job 最多一次派发。

CREATE TABLE ai_jobs (
    job_id TEXT PRIMARY KEY,
    owner_instance_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    capability TEXT NOT NULL,
    key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    state TEXT NOT NULL,
    state_revision INTEGER NOT NULL,
    dispatch_state TEXT NOT NULL,
    attempt_id TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    result_proposal_id TEXT
);

CREATE UNIQUE INDEX idx_ai_jobs_key ON ai_jobs (principal, capability, key);
CREATE INDEX idx_ai_jobs_list ON ai_jobs (owner_instance_id, created_at, job_id);

CREATE TABLE ai_proposals (
    proposal_id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    validated_intent TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    state TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX idx_ai_proposals_job ON ai_proposals (job_id);

-- DataDir 总账（R4-B 会扩展 usage entries 与熔断）：整数 micro-USD，
-- reserved 是受理时的一次性预留，charged 是已计入的最终费用。
CREATE TABLE ai_budget_months (
    month TEXT PRIMARY KEY,
    reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
    charged_micro_usd INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0
);

-- 受理时间水位（§7.2）：只增不减，明显校时异常时暂停新生成。
ALTER TABLE ai_instance ADD COLUMN accepted_watermark INTEGER NOT NULL DEFAULT 0;
