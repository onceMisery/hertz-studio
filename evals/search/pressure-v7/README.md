# Search Pressure v7: Balanced Throughput

This reruns the schema 6, 60-second balanced probe after changing the result loop to enumerate entry names. The scheduling and gate configuration are unchanged. Both runs used loopback fixtures and the current test binaries; they did not use real providers, credentials, accounts, or DBX stdio.

The probe offered 16 source operations per second to each entry, 64 total. Both editions reached four local executions, reported only `search_busy` source failures, and restored the gate to `[4, 16]`. These are single-run overload measurements, not customer success-rate or latency targets.

| Edition | HTTP single | RPC single | HTTP aggregate | RPC aggregate |
| --- | ---: | ---: | ---: | ---: |
| Standard | 647 / 960 (67.40%) | 575 / 960 (59.90%) | 507 / 960 (52.81%) | 443 / 960 (46.15%) |
| Full | 682 / 960 (71.04%) | 713 / 960 (74.27%) | 474 / 960 (49.38%) | 219 / 960 (22.81%) |

Keep the candidate gate at 4 executing sources, 16 waiters, 2 seconds to enter, and a 6-second total deadline. The observed entry differences do not establish that changing the shared gate would improve real-provider or DBX behavior. Both reports are `releaseEligible: false`; memory samples cover the test process, in-process driver, and loopback upstream, not production service RSS.

Each report has `-probe.json.gz`, `-probe.log.gz`, and `-memory.jsonl.gz` sidecars. The checker passed against the original binaries when these reports were captured. Those binaries were not archived; subsequent Rust builds replaced the shared `target/debug/deps` files, so the original Full verification command no longer matches the report's recorded hash. Use the fresh, independently verified repetitions in [pressure-v8](../pressure-v8/README.md) for current reproducible evidence.
