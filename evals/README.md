# Evaluation artifacts

This directory holds two different kinds of files. Keep the distinction when
adding new evidence.

## Frozen inputs (keep raw)

- `stage-intent/v*/cases.jsonl` and the v3 label corpus are read directly by
  `scripts/check-stage-evaluation.js`.
- `stage/legacy-v1` is replayed by `scripts/check-stage-legacy-fixtures.js`.
- `search/v1/corpus.py` is the synthetic library generator used by
  `scripts/benchmark-search.js`.
- Small handwritten summaries, baselines and READMEs stay readable as written.

These files are byte-hashed by checks, so line endings are pinned in
`.gitattributes` (`text eol=lf`, or `-text` for binary fixtures).

## Run outputs (gzip)

Raw per-call reports, probe dumps, memory samples and logs are machine-local
measurements, not build products. They are stored as `.gz`:

- `*-probe.json.gz` — raw probe mirror of the report's `probe` field.
- `*-probe.log.gz` — test stdout.
- `*-memory.jsonl.gz` — 500 ms process samples.
- `<run>.json.gz` — the report itself.

`scripts/check-search-pressure-evidence.js` reads both plain and `.gz` files and
appends `.gz` to the recorded `probeFile` / `logFile` / `memoryFile` sidecars
when the plain name is absent.

## What is current

- `search/pressure-v9/` keeps the twelve runs referenced by its README. The
  eight current/final reports are listed in `verified.json`; CI verifies that
  manifest (structure, sidecars, hashes). The four early
  `search-pressure-balanced-*` runs stay as archival data and are deliberately
  not in the manifest (one was rejected by the dispatch-order audit).
- `search/pressure-v1`, `pressure-v2`, `pressure-v6`, `pressure-v7` and
  `pressure-v8` keep their READMEs plus gzipped archival reports. They are
  superseded by v9 and are not CI-gated.
- `search/pressure-v3`, `pressure-v4` and `search/pressure-v5` had no README and
  were superseded; their raw data was removed from this branch. Git history of
  the branch still has it.

## Retention rules

1. A new benchmark version replaces the previous version's raw run outputs.
   Keep the previous README and its summary; do not keep a third copy of the
   observations.
2. Every committed report must either appear in a `verified.json` manifest used
   by CI, or be explicitly described as archival in the directory README.
3. Large raw archives that are not needed for a current claim belong in a
   release asset or CI artifact, not in git.
4. Never commit a report whose sidecars are missing or whose recorded hashes no
   longer match. Regenerate or drop it.

Verify the current archive with:

```powershell
node scripts/check-search-pressure-evidence.js --archive evals/search/pressure-v9/verified.json
```
