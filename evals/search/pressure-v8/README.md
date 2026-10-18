# Search Pressure v8: Repeated Balanced Throughput

Four fresh runs repeat the schema 6, 60-second balanced probe twice per edition. Each edition used one freshly built test binary in the isolated `target/search-pressure-repeat` directory. The runs were serialized. They used the same loopback source fixtures and did not use real providers, accounts, credentials, DBX stdio, or browser UI.

The offered load was 16 source operations per second for each of HTTP single, RPC single, HTTP aggregate, and RPC aggregate: 64 source operations per second total. Standard has two registered fixture sources and Full has eight. Aggregate outer requests fan out to every registered source; success is counted per source operation, so an outer HTTP 200 can contain `search_busy` failures.

| Edition | Entry | Run 2 | Run 3 |
| --- | --- | ---: | ---: |
| Standard | HTTP single | 652/960 (67.9%) | 760/960 (79.2%) |
| Standard | RPC single | 604/960 (62.9%) | 643/960 (67.0%) |
| Standard | HTTP aggregate | 498/960 (51.9%) | 662/960 (69.0%) |
| Standard | RPC aggregate | 403/960 (42.0%) | 510/960 (53.1%) |
| Full | HTTP single | 834/960 (86.9%) | 829/960 (86.4%) |
| Full | RPC single | 807/960 (84.1%) | 815/960 (84.9%) |
| Full | HTTP aggregate | 642/960 (66.9%) | 623/960 (64.9%) |
| Full | RPC aggregate | 300/960 (31.3%) | 311/960 (32.4%) |

Every source failure was `search_busy`. All runs reached the four-execution peak, ended with zero local executions and zero active fixture connections, and restored the gate to `[4, 16]`. Each report has `releaseEligible: false` and includes its own probe JSON, log, and 500 ms test-process memory samples.

The Full RPC aggregate result is consistently much lower than the other entries, while Standard rates vary more between runs. This confirms that the overload result depends on entry shape and scheduler conditions; it does not identify a safe production capacity. Keep the candidate gate at 4 executing sources, 16 waiters, 2 seconds to enter, and a 6-second total deadline. A change still requires real provider and DBX traffic plus an accepted success-rate and latency SLO. These measurements are not production RSS or release evidence.

Both runs per edition were independently checked against the exact current source hashes and test-binary hashes:

```powershell
node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v8/search-pressure-balanced-20261018-standard-r2.json `
  target/search-pressure-repeat/debug/deps/hertz_studio-6f3eb86935af49f7.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v8/search-pressure-balanced-20261018-standard-r3.json `
  target/search-pressure-repeat/debug/deps/hertz_studio-6f3eb86935af49f7.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v8/search-pressure-balanced-20261018-full-r2.json `
  target/search-pressure-repeat/debug/deps/hertz_studio-6d710df5b809c2cc.exe --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v8/search-pressure-balanced-20261018-full-r3.json `
  target/search-pressure-repeat/debug/deps/hertz_studio-6d710df5b809c2cc.exe --current
```
