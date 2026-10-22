ALTER TABLE ai_jobs ADD COLUMN failure_code TEXT
    CHECK (failure_code IS NULL OR failure_code IN (
        'provider_error',
        'invalid_output',
        'internal_error'
    ));
