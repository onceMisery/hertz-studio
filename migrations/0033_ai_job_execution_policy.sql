-- Freeze execution/admission policy with each task. Historical jobs retain
-- their 60/30-second policy and 50,000 micro-USD bound; no bill is repriced.
ALTER TABLE ai_jobs ADD COLUMN queue_deadline_ms INTEGER NOT NULL DEFAULT 60000 CHECK (queue_deadline_ms = 60000);
ALTER TABLE ai_jobs ADD COLUMN run_deadline_ms INTEGER NOT NULL DEFAULT 30000 CHECK (run_deadline_ms IN (30000, 180000));
ALTER TABLE ai_jobs ADD COLUMN reservation_limit_micro_usd INTEGER NOT NULL DEFAULT 50000 CHECK (reservation_limit_micro_usd IN (50000, 500000));

CREATE TRIGGER ai_jobs_admission_policy BEFORE INSERT ON ai_jobs
WHEN NEW.reservation_micro_usd < 0
  OR NEW.reservation_micro_usd > NEW.reservation_limit_micro_usd
  OR CASE WHEN json_valid(NEW.pricing_snapshot) THEN
      json_extract(NEW.pricing_snapshot, '$.pricingVersion') LIKE 'metered-%'
      AND json_extract(NEW.pricing_snapshot, '$.pricingVersion') NOT IN ('metered-v1', 'metered-v2')
    ELSE 0 END
  OR NOT COALESCE(CASE WHEN NEW.run_deadline_ms = 180000 THEN
      NEW.capability = 'wallpaper.generate'
      AND NEW.reservation_limit_micro_usd = 500000
      AND CASE WHEN json_valid(NEW.pricing_snapshot) THEN
          json_extract(NEW.pricing_snapshot, '$.pricingVersion') = 'metered-v2'
          AND json_type(NEW.pricing_snapshot, '$.dimensions') = 'array'
          AND json_array_length(NEW.pricing_snapshot, '$.dimensions') = 3
          AND json_extract(NEW.pricing_snapshot, '$.dimensions[0].dimension') = 'inputTokens'
          AND json_extract(NEW.pricing_snapshot, '$.dimensions[1].dimension') = 'outputTokens'
          AND json_extract(NEW.pricing_snapshot, '$.dimensions[2].dimension') = 'imageOutput'
          AND NOT EXISTS (SELECT 1 FROM json_each(NEW.pricing_snapshot, '$.dimensions') AS d
            WHERE d.type IS NOT 'object'
              OR json_type(d.value, '$.quantityLimit') IS NOT 'integer'
              OR json_type(d.value, '$.unitPriceMicroUsd') IS NOT 'integer'
              OR json_type(d.value, '$.unitScale') IS NOT 'integer'
              OR json_extract(d.value, '$.quantityLimit') < 0
              OR json_extract(d.value, '$.unitPriceMicroUsd') < 0
              OR json_extract(d.value, '$.unitScale') <= 0)
          AND json_extract(NEW.pricing_snapshot, '$.dimensions[2].quantityLimit') = 1
          AND json_extract(NEW.pricing_snapshot, '$.dimensions[2].unitScale') = 1
          AND json_type(NEW.pricing_snapshot, '$.dimensions[2].imageSku') = 'object'
          AND json_type(NEW.pricing_snapshot, '$.dimensions[2].imageSku.width') = 'integer'
          AND json_type(NEW.pricing_snapshot, '$.dimensions[2].imageSku.height') = 'integer'
          AND json_type(NEW.pricing_snapshot, '$.dimensions[2].imageSku.qualityId') = 'text'
          AND json_extract(NEW.pricing_snapshot, '$.dimensions[2].imageSku.width') BETWEEN 1 AND 4096
          AND json_extract(NEW.pricing_snapshot, '$.dimensions[2].imageSku.height') BETWEEN 1 AND 4096
          AND json_extract(NEW.pricing_snapshot, '$.dimensions[2].imageSku.width')
            * json_extract(NEW.pricing_snapshot, '$.dimensions[2].imageSku.height') <= 8388608
          AND length(CAST(json_extract(NEW.pricing_snapshot, '$.dimensions[2].imageSku.qualityId') AS BLOB)) BETWEEN 1 AND 64
          AND json_type(NEW.pricing_snapshot, '$.dimensions[0].imageSku') IS NULL
          AND json_type(NEW.pricing_snapshot, '$.dimensions[1].imageSku') IS NULL
          AND json_type(NEW.pricing_snapshot, '$.inputMicroUsdPerMillion') IS NULL
          AND json_type(NEW.pricing_snapshot, '$.outputMicroUsdPerMillion') IS NULL
          AND json_type(NEW.pricing_snapshot, '$.maxInputTokens') IS NULL
          AND json_type(NEW.pricing_snapshot, '$.maxOutputTokens') IS NULL
        ELSE 0 END
    ELSE NEW.reservation_limit_micro_usd = 50000
      AND CASE WHEN json_valid(NEW.pricing_snapshot) THEN
        COALESCE(json_extract(NEW.pricing_snapshot, '$.pricingVersion') != 'metered-v2', 1)
        AND json_type(NEW.pricing_snapshot, '$.dimensions') IS NULL
      ELSE 1 END
    END, 0)
BEGIN
    SELECT RAISE(ABORT, 'invalid AI task admission policy');
END;

CREATE TRIGGER ai_jobs_frozen_policy BEFORE UPDATE OF
  queue_deadline_ms, run_deadline_ms, reservation_limit_micro_usd,
  reservation_micro_usd ON ai_jobs
WHEN NEW.queue_deadline_ms != OLD.queue_deadline_ms
  OR NEW.run_deadline_ms != OLD.run_deadline_ms
  OR NEW.reservation_limit_micro_usd != OLD.reservation_limit_micro_usd
  OR NEW.reservation_micro_usd != OLD.reservation_micro_usd
BEGIN
    SELECT RAISE(ABORT, 'AI task reservation and policy are immutable');
END;
