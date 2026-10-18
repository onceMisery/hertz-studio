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

```powershell
node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/search-pressure-balanced-20261019-standard-r1.json `
  target/search-pressure-v9/debug/deps/hertz_studio-61db3b33b663eb0e.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/search-pressure-balanced-20261019-standard-r2.json `
  target/search-pressure-v9/debug/deps/hertz_studio-61db3b33b663eb0e.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/search-pressure-balanced-20261019-full-r1.json `
  target/search-pressure-v9/debug/deps/hertz_studio-c4c77093892779d1.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v9/search-pressure-balanced-20261019-full-r2.json `
  target/search-pressure-v9/debug/deps/hertz_studio-c4c77093892779d1.exe --current
```
