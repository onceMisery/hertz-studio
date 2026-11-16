-- Non-secret submission identity belongs to the accepted job, so a lost HTTP
-- receipt can be recovered after its in-memory quote has expired.
CREATE TABLE ai_wallpaper_submissions (
    job_id TEXT PRIMARY KEY REFERENCES ai_jobs(job_id) ON DELETE CASCADE,
    quote_id TEXT NOT NULL,
    request_id TEXT NOT NULL
);
