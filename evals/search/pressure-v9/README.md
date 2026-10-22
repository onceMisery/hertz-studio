# Search Pressure v9: Alternating Entry Order

Schema 7 adds schedule version 2 to the 60-second balanced probe. HTTP and RPC are scheduled at equal source-operation rates; within each equal-rate pair, the first slot alternates by sequence, so HTTP starts first on even sequences and RPC starts first on odd sequences. The single-source pair and aggregate pair use this rule independently. The evidence checker recomputes every `scheduledMs` from the recorded entry and sequence.

The offered load remains 16 source operations per second for each of HTTP single, RPC single, HTTP aggregate, and RPC aggregate: 64 source operations per second total. Standard has two ready fixture sources; Full has eight. Each edition ran twice, serially, on the same Windows x64 host and Rust 1.88.0 test profile. Test binaries were built in the isolated D-drive target `target/search-pressure-v9`. Runs used loopback fixtures only, without real providers, accounts, credentials, DBX stdio, or browser UI.

| Edition | Entry | Run 1 | Run 2 |
| --- | --- | ---: | ---: |
| Standard | HTTP single | 695/960 (72.40%) | 820/960 (85.42%) |
| Standard | RPC single | 531/960 (55.31%) | 487/960 (50.73%) |
| Standard | HTTP aggregate | 517/960 (53.85%) | 662/960 (68.96%) |
| Standard | RPC aggregate | 527/960 (54.90%) | 607/960 (63.23%) |
| Full | HTTP single | 847/960 (88.23%) | 846/960 (88.13%) |
| Full | RPC single | 690/960 (71.88%) | 657/960 (68.44%) |
| Full | HTTP aggregate | 466/960 (48.54%) | 480/960 (50.00%) |
| Full | RPC aggregate | 570/960 (59.38%) | 583/960 (60.73%) |

Every source failure was `search_busy`. All four runs reached four local executing sources, ended with zero local executions and zero active fixture connections, and restored the gate to `[4, 16]`. Every report passed independent checks for schema, alternating schedule timestamps, current source hashes, exact test-binary hash, and its probe/log/memory sidecars. The sampled memory belongs to the test process and fixture driver, not the production service; `releaseEligible` remains false.

Compared with pressure-v8, Full RPC aggregate no longer has the lowest success rate: under the alternating schedule it is 10.83 and 10.73 percentage points above HTTP aggregate in the two runs. This reversal shows that the earlier apparent HTTP advantage was sensitive to timing. Standard also varies substantially between repetitions. The fixture still cannot identify a safe production capacity. Keep the candidate gate at 4 executing sources, 16 waiters, 2 seconds to enter, and a 6-second total deadline; decide only after real provider and DBX measurements against an accepted success-rate and latency SLO.

## Final-build repetition (2026-10-19)

The final source and test binaries were measured again after the latest changes. Standard R1/R2 and Full R1 each used one 60-second balanced cycle. Full R2 additionally ran three 120-second mixed-pressure cycles with idle sampling; its balanced-throughput phase remains a separate 60-second measurement.

| Edition | Entry | Final R1 | Final R2 |
| --- | --- | ---: | ---: |
| Standard | HTTP single | 83.54% | 84.48% |
| Standard | RPC single | 60.94% | 62.29% |
| Standard | HTTP aggregate | 71.46% | 71.04% |
| Standard | RPC aggregate | 68.96% | 66.77% |
| Full | HTTP single | 88.75% | 88.23% |
| Full | RPC single | 71.88% | 71.15% |
| Full | HTTP aggregate | 57.81% | 56.35% |
| Full | RPC aggregate | 65.31% | 63.23% |

All four final reports passed independent `--current` checks for source and executable hashes. Every run reached four local executing sources and restored the gate to `[4, 16]`. The Full R2 long run completed 26,208 requests over three cycles of 120.46, 120.27, and 120.25 seconds; its report includes 936 test-process memory samples. Failures in the balanced phase were fixture-level `search_busy`. These results do not validate real providers, accounts, native DBX, production-service RSS, weak hardware, or release eligibility, which remains false. The gate stays a candidate pending real-provider and DBX measurements against an accepted success-rate and latency SLO.

Current-worktree recheck: each report's embedded probe, log and memory hashes, observation structure and metrics pass the evidence checker, but strict `--current` now finds one source mismatch: `crates/hertz-studio/src/routes.rs`. Its intervening change adds lyric-emotion lock routes (commit `31fc21f`); the other 13 recorded source hashes, including the online search and gate modules, still match. The isolated test binaries under `target/search-pressure-final` have been removed, so their executable hashes cannot be recomputed. Treat these as verified archival measurements, not a complete current-source-and-binary recheck. This does not justify changing the candidate gate; real-provider/DBX load and an accepted user SLO remain necessary.

Dispatch-order audit: of the 12 v9 reports, the eight current/final reports and three other early reports pass the actual-start alternation check. The remaining early Standard R1 report is rejected because six HTTP/RPC pairs started in the reverse order from their schedule. Its metrics remain archival data, but it is excluded from evidence that the alternating schedule was followed. The audit adds no latency threshold and does not change the candidate gate.

Reports and sidecars are committed as `.gz`; `.gitattributes` keeps them binary and pins the remaining text artifacts to LF. CI verifies the eight current/final reports through [`verified.json`](./verified.json) (`node scripts/check-search-pressure-evidence.js --archive evals/search/pressure-v9/verified.json`). The early runs stay archival and are intentionally outside that manifest.

```powershell
node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/search-pressure-balanced-20261019-standard-r1.json.gz `
  target/search-pressure-v9/debug/deps/hertz_studio-61db3b33b663eb0e.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/search-pressure-balanced-20261019-standard-r2.json.gz `
  target/search-pressure-v9/debug/deps/hertz_studio-61db3b33b663eb0e.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/search-pressure-balanced-20261019-full-r1.json.gz `
  target/search-pressure-v9/debug/deps/hertz_studio-c4c77093892779d1.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/search-pressure-balanced-20261019-full-r2.json.gz `
  target/search-pressure-v9/debug/deps/hertz_studio-c4c77093892779d1.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/final-20261019-standard-r1.json.gz `
  target/search-pressure-final/debug/deps/hertz_studio-1c6d71add61e1950.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/final-20261019-standard-r2.json.gz `
  target/search-pressure-final/debug/deps/hertz_studio-1c6d71add61e1950.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/final-20261019-full-r1.json.gz `
  target/search-pressure-final/debug/deps/hertz_studio-6fa1dfdcad4c1f52.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/final-20261019-full-r2.json.gz `
  target/search-pressure-final/debug/deps/hertz_studio-6fa1dfdcad4c1f52.exe --current
```
