# Week 23 Infra Loop — Ambient verification-at-scale low-volume probe

## Scope and safety
- Evidence window: 2026-08-17T05:39:43.403Z → 2026-08-17T05:39:53.971Z
- Live requests: 8
- Max concurrency: 2
- Sustained-lane delay: 1000 ms
- Max tokens per request: 48
- No secrets, full model outputs, raw request ids, deployment changes, or external publication were used.

## Metrics
- Success rate: 6/8 (0.75)
- Verified true on OK runs: 0/6 (0)
- Verified false / missing on OK runs: 0 / 6
- Merkle root present on OK runs: 0/6
- Request id header present: 8/8
- Latency OK runs: min 593 / avg 1406 / median 1228 / p95 2462 / max 2462 ms
- First byte OK runs: min 295 / avg 1012 / median 903 / p95 1971 / max 1971 ms
- Local RSS delta per request: min -1024000 / avg 2633216 / median 270336 / p95 21762048 / max 21762048 bytes
- Failure modes: {"empty_output":2}
- Returned model labels: {"z-ai/glm-5.2":6}

## Lane breakdown
- sustained: ok/fail 2/2; latency avg 914 ms, max 1228 ms
- concurrent: ok/fail 4/0; latency avg 1653 ms, max 2462 ms

## Per-run sanitized evidence
| run | lane | ok | status | latency_ms | first_byte_ms | verified | merkle_root | request_id | output_chars | failure |
|---:|---|---|---:|---:|---:|---|---|---|---:|---|
| 1 | sustained | true | 200 | 1228 | 903 |  | false | true | 191 |  |
| 2 | sustained | true | 200 | 599 | 453 |  | false | true | 108 |  |
| 3 | sustained | false | 200 | 1337 | 1058 |  | false | true | 0 | empty_output |
| 4 | sustained | false | 200 | 843 | 625 |  | false | true | 0 | empty_output |
| 5 | concurrent | true | 200 | 1502 | 957 |  | false | true | 96 |  |
| 6 | concurrent | true | 200 | 2462 | 1971 |  | false | true | 177 |  |
| 7 | concurrent | true | 200 | 2053 | 1492 |  | false | true | 44 |  |
| 8 | concurrent | true | 200 | 593 | 295 |  | false | true | 195 |  |

## Observed issues
- 2/8 HTTP 200 streams produced usage/model metadata but no content, classified as `empty_output`.
- Verification-specific fields were absent in this run: verified true 0/6 OK runs, merkle root present 0/6 OK runs, lifecycle events 0.
- Some completions reached the 48-token cap with reasoning tokens but no visible content, so low output budgets can make verification probes look like content failures.

## Interpretation
- This is an operations smoke probe, not a load test or model-quality benchmark.
- Low concurrency checks whether verification metadata remains visible under small sustained and concurrent workloads without stressing the API.
- Local memory data describes the probe process RSS only; it is not Ambient server memory.

JSON artifact: /home/assistent/ai-projects/gov-ai/examples/week23-infra-loop/week23-ambient-verification-probe-output.json
