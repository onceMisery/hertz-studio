-- AI 费用账本与熔断（技术路线 R4-B / §8.4-§8.5）。
-- 每任务一条 usage entry：结算与任务终态同事务写入，账目可重入对账；
-- usage_state：reported（可信 usage）/ unknown（已派发未确认，按预留计）/
-- released（未派发即终止，无费用）。fake provider 恒为 0 费用：reported 0。
-- 熔断是持久闩锁：charged 超出月限额即 halt，翻月/换 provider/重启不自动
-- 解除，只有官方管理 reset（expectedRevision CAS）能恢复。

CREATE TABLE ai_usage_entries (
    job_id TEXT PRIMARY KEY,
    reservation_micro_usd INTEGER NOT NULL,
    accounted_micro_usd INTEGER NOT NULL,
    usage_state TEXT NOT NULL,
    pricing_snapshot TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

CREATE TABLE ai_budget_guard (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_instance_id TEXT NOT NULL,
    halted INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    trigger_job TEXT,
    revision INTEGER NOT NULL DEFAULT 0
);
