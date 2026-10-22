-- Freeze prices and the reservation before dispatch. Historical prices cannot
-- be reconstructed from today's configuration; mark legacy snapshots explicitly.
ALTER TABLE ai_jobs ADD COLUMN reservation_micro_usd INTEGER NOT NULL DEFAULT 50000;
ALTER TABLE ai_jobs ADD COLUMN pricing_snapshot TEXT NOT NULL DEFAULT '{}';
UPDATE ai_jobs SET pricing_snapshot = json_object(
    'provider', provider, 'model', model, 'pricingVersion', 'legacy-unverified',
    'reservationMicroUsd', reservation_micro_usd);

-- Only normalized, adapter-verified counters belong here, never model text.
ALTER TABLE ai_usage_entries ADD COLUMN reported_usage TEXT;
