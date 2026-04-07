# Week 10 load test plan for gov-ai

## Goal
Implement a standalone `week10-load.js` script for Ambient Week 10 that runs parallel inference stress tests using the current gov-ai core pipeline, captures first-token latency, completion time, failure modes, and Ambient verification metadata, and saves only aggregate artifacts to `load-reports/`.

## Scope
- Add standalone `week10-load.js` in project root
- Add a dedicated `week10-load-test/plan.md` artifact for this work
- Reuse current extraction + prompt/inference pipeline behavior
- Measure per-run first token latency, total duration, status, and Ambient verification metadata
- Save aggregate JSON and markdown summaries into `load-reports/`
- Avoid writing normal `reports/`, `routes/`, or `reviews/` artifacts during load tests

## Non-goals
- Do not route through `gov-ai-api.js`
- Do not modify normal CLI behavior in `gov-ai.js`
- Do not implement full distributed benchmark infrastructure
- Do not claim `__ambient` proves throughput; it is supporting execution evidence only

## Deliverables
- `week10-load.js` executable script
- `load-reports/load-result-<runs>-<timestamp>.json`
- `load-reports/load-summary-<runs>-<timestamp>.md`

## Implementation approach
1. Parse CLI args: `--url`, `--runs`, `--concurrency`, `--model`, `--timeout-ms`, `--strict-hooks`, `--out-dir`.
2. Load `principles.json` and run `fetchAndExtract(url)` exactly once per batch.
3. Implement a dedicated streaming analysis runner inside `week10-load.js` based on `analyzer.js` streaming path.
4. Capture:
   - request start time
   - first token arrival time
   - stream completion time
   - JSON parse validity
   - `__ambient` fields: verified, merkle_root, request_id, model, verified_by_validators, auction, bidder
5. After model output parses, compute `verification_hooks` and refusal heuristics locally for batch metrics.
6. Run jobs with bounded concurrency (worker pool), not unbounded `Promise.all`.
7. Aggregate stats: success/failure counts, avg/median/p95/min/max for first-token and total duration, failure type counts, ambient metadata counts, refusal counts, strict rejection counts.
8. Save result JSON + high-quality markdown summary to `load-reports/`.

## Expected files/subsystems
- `week10-load.js`
- `week10-load-test/plan.md`
- runtime output dir `load-reports/` (created on demand)

## Validation strategy
- Run syntax check: `node --check week10-load.js`
- Run a lightweight smoke test with 1 run and concurrency 1 if credentials are present and cost is acceptable
- Validate that no standard `reports/`, `routes/`, or `reviews/` files are produced by the load script
- Validate JSON/markdown outputs are created in `load-reports/`

## Risks / assumptions
- First-token latency requires local streaming instrumentation rather than black-box `analyzeWithLLM`
- Ambient API may return rate limits or capacity-related failures under load
- Financial proposal multi-node behavior must be bypassed for deterministic load testing against a single run pipeline
- Shared extracted input is intentional to isolate inference behavior from extraction variance

## Definition of done
- A standalone script can run 10/50/100-style batches with bounded concurrency
- Output includes usable evidence for Week 10: timings, failure modes, degradation pattern inputs, and Ambient verification metadata samples
- Artifacts are isolated to `load-reports/` only
