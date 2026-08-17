# Week 23 Infra Loop — Ambient verification-at-scale low-volume probe

## Scope and safety
- Evidence window: 2026-08-17T05:44:02.776Z → 2026-08-17T05:44:12.914Z
- Live requests: 8
- Max concurrency: 2
- Sustained-lane delay: 1000 ms
- Max tokens per request: 128
- No secrets, full model outputs, raw request ids, deployment changes, or external publication were used.

## Metrics
- Success rate: 8/8 (1)
- Verified true on OK runs: 0/8 (0)
- Verified false / missing on OK runs: 0 / 8
- Merkle root present on OK runs: 0/8
- Request id header present: 8/8
- Latency OK runs: min 677 / avg 1228 / median 920 / p95 2171 / max 2171 ms
- First byte OK runs: min 406 / avg 684 / median 759 / p95 961 / max 961 ms
- Local RSS delta per request: min -1941504 / avg 1632768 / median 0 / p95 14782464 / max 14782464 bytes
- Failure modes: {}
- Returned model labels: {"z-ai/glm-5.2":8}

## Lane breakdown
- sustained: ok/fail 4/0; latency avg 933 ms, max 1420 ms
- concurrent: ok/fail 4/0; latency avg 1524 ms, max 2171 ms

## Per-run sanitized evidence
| run | lane | ok | status | latency_ms | first_byte_ms | verified | merkle_root | request_id | output_chars | failure |
|---:|---|---|---:|---:|---:|---|---|---|---:|---|
| 1 | sustained | true | 200 | 1420 | 838 |  | false | true | 193 |  |
| 2 | sustained | true | 200 | 823 | 406 |  | false | true | 182 |  |
| 3 | sustained | true | 200 | 677 | 435 |  | false | true | 176 |  |
| 4 | sustained | true | 200 | 813 | 436 |  | false | true | 144 |  |
| 5 | concurrent | true | 200 | 1228 | 859 |  | false | true | 124 |  |
| 6 | concurrent | true | 200 | 1775 | 759 |  | false | true | 191 |  |
| 7 | concurrent | true | 200 | 2171 | 961 |  | false | true | 193 |  |
| 8 | concurrent | true | 200 | 920 | 781 |  | false | true | 67 |  |

## Interpretation
- This is an operations smoke probe, not a load test or model-quality benchmark.
- Low concurrency checks whether verification metadata remains visible under small sustained and concurrent workloads without stressing the API.
- Local memory data describes the probe process RSS only; it is not Ambient server memory.

JSON artifact: examples/week23-infra-loop-v2/week23-ambient-verification-probe-output.json
