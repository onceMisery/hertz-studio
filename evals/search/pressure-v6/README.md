# Search pressure v6: balanced throughput

Schema 6 adds per-source failure codes to the 60-second balanced-throughput phase. The evidence exercises the production `SearchGate` through HTTP single-source, direct RPC single-source, HTTP aggregate, and direct RPC aggregate calls. It is a local fixture measurement, not a release or real-provider acceptance run.

## Workload and scope

Each entry offers 16 underlying source operations per second for 60 seconds. Standard has two ready fixture sources; each aggregate therefore makes 8 outer calls per second. Full has eight ready fixture sources; each aggregate makes 2 outer calls per second. In both editions the four entries offer 64 source operations per second in total. The HTTP path uses the real Axum router. RPC calls invoke `Rpc::call` in-process and do not traverse DBX stdio. Provider parsing runs over loopback fixture responses; no real provider, credential, account, or remote service is used.

The target is intentionally above the current gate's observed service capacity. The probe checks bounded admission, entry contention, source-order effects, rejection codes, latency, and recovery; it does not define an acceptable customer load or success-rate SLO. Aggregation returns per-source results with an outer 200 even when individual sources report `search_busy`.

## Results

The unchanged gate was 4 executing sources, 16 waiting callers, 2 seconds to enter, and a 6-second total source deadline. Both editions reached four local executions and ended with all permits and waiter seats restored (`[4, 16]`). Every failed source operation in the balanced phase reported `search_busy`. Scheduled-to-response P95 includes caller scheduling and gate wait.

| Edition | Entry | Source successes | Success rate | Successful ops/s | P95 ms |
| --- | --- | ---: | ---: | ---: | ---: |
| Standard | HTTP single | 624 / 960 | 65.00% | 10.40 | 1012.4 |
| Standard | RPC single | 564 / 960 | 58.75% | 9.40 | 997.8 |
| Standard | HTTP aggregate | 458 / 960 | 47.71% | 7.63 | 1030.3 |
| Standard | RPC aggregate | 408 / 960 | 42.50% | 6.80 | 952.9 |
| Full | HTTP single | 666 / 960 | 69.38% | 11.10 | 978.2 |
| Full | RPC single | 723 / 960 | 75.31% | 12.05 | 936.2 |
| Full | HTTP aggregate | 461 / 960 | 48.02% | 7.68 | 1083.1 |
| Full | RPC aggregate | 251 / 960 | 26.15% | 4.18 | 1049.2 |

In Full v5, aggregate source success fell monotonically with registration order: HTTP ranged from 100% to 21.7%, and RPC from 69.2% to 0.8%. The v6 rotating start order reduced that positional spread to 35.8–61.7% for HTTP aggregate and 20.8–32.5% for RPC aggregate. Standard's two aggregate sources also had closer success rates. This was one run per edition: it supports keeping the rotation, but does not prove a total-throughput improvement. Full HTTP aggregate source success fell from 68.23% in v5 to 48.02% in v6, while Full RPC aggregate remained low at 26.15%.

## Gate decision

Keep the current gate values as candidates; do not raise concurrency from this evidence alone. The probe saturates the gate by offering 64 source operations per second across all four entry types, but it has no real-provider rate limits, DBX transport, customer arrival distribution, or agreed success-rate/latency target. A higher limit could increase upstream rejection in production. The Full RPC aggregate gap merits another run with real transport and repeated or varied entry ordering before attributing it to the gate or freezing capacity.

Both reports remain `releaseEligible: false`. Process memory covers the test process, in-process driver, and loopback upstream; it is not production-service RSS.

## Evidence files

`search-pressure-balanced-20261018-standard.json` is the Standard report. `search-pressure-balanced-20261018-full-rebuilt.json` is the valid Full report. Each report has a `-probe.json`, `-probe.log`, and `-memory.jsonl` sidecar with raw probe output and 500 ms process samples. The independent checker verified both reports against current source bytes; Full was also checked against the exact test executable hash.

The initial Full attempt at `search-pressure-balanced-20261018-full.json` is retained but is not a measurement: its older test binary rejected startup because its embedded `online/mod.rs` source fingerprint no longer matched. Full was rebuilt with Rust 1.88.0 and rerun under the `full-rebuilt` name. No failed or historical evidence file was overwritten.

Recheck a completed report and its source fingerprint with:

```powershell
node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v6/search-pressure-balanced-20261018-standard.json --current

node scripts/check-search-pressure-evidence.js `
  evals/search/pressure-v6/search-pressure-balanced-20261018-full-rebuilt.json `
  target/search-pressure-balanced/debug/deps/hertz_studio-c4c77093892779d1.exe --current
```
