# Ambient Week 14 — Live benchmark rollup

All live runs used Ambient API `https://api.ambient.xyz/v1/chat/completions` with model `zai-org/GLM-5.1-FP8`.

## Runs

- `week14-sglang-bench-2026-05-14T22-45-46-461Z.json` — parallel 1, no_memory: ok/fail 3/0, avg 26382 ms, median 25686 ms, p95 30543 ms, retries 1, JSON 3/3, exact-match 0.333
- `week14-sglang-bench-2026-05-14T22-45-46-461Z.json` — parallel 1, with_memory: ok/fail 3/0, avg 27830 ms, median 29142 ms, p95 36514 ms, retries 0, JSON 3/3, exact-match 0.333
- `week14-sglang-bench-2026-05-14T22-46-55-659Z.json` — parallel 3, no_memory: ok/fail 3/0, avg 21907 ms, median 15569 ms, p95 34972 ms, retries 0, JSON 3/3, exact-match 0.333
- `week14-sglang-bench-2026-05-14T22-46-55-659Z.json` — parallel 3, with_memory: ok/fail 3/0, avg 23076 ms, median 24895 ms, p95 24921 ms, retries 0, JSON 3/3, exact-match 0.333
- `week14-sglang-bench-2026-05-14T22-49-25-553Z.json` — parallel 5, no_memory: ok/fail 5/0, avg 23047 ms, median 20165 ms, p95 31198 ms, retries 0, JSON 5/5, exact-match 0.2
- `week14-sglang-bench-2026-05-14T22-49-25-553Z.json` — parallel 5, with_memory: ok/fail 5/0, avg 20688 ms, median 19255 ms, p95 24752 ms, retries 0, JSON 5/5, exact-match 0.2

## Aggregate
- no_memory: total ok/fail 11/0; run-level avg latency mean 23779 ms; run-level median mean 20473 ms
- with_memory: total ok/fail 11/0; run-level avg latency mean 23865 ms; run-level median mean 24431 ms

## Interpretation

- The benchmark is now live, not mock and not localhost.
- Across serial/parallel checks, all live requests completed successfully after switching to Ambient API + `zai-org/GLM-5.1-FP8`.
- Parallel 5x result is the strongest throughput datapoint: 5/0 ok/fail for no_memory and 5/0 ok/fail for with_memory, no retries.
- Latency is consistently around ~20–28s in these small Week 14 runs, far below the old Week 12 ~141s avg baseline, but still not a perfect same-prompt before/after comparison.
- Exact output stability is low (0.2–0.333) because outputs differ byte-for-byte, but JSON structure remained valid in successful runs.
