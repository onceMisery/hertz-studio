ALTER TABLE ai_jobs ADD COLUMN provider_http_status INTEGER
    CHECK (provider_http_status IS NULL OR provider_http_status BETWEEN 300 AND 599);
