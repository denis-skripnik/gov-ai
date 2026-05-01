# Week 12 benchmark improvement plan

## Scope
- Improve the existing `bench.js` so the benchmark is useful for the **Week 12 dev loop**.
- Add deterministic benchmark reporting for three Week 12 concerns: **output quality**, **latency**, and **failure modes**.
- Refactor benchmark-specific logic into testable helpers without changing the main gov-ai analysis pipeline.
- Add focused automated tests for the new/changed benchmark logic.

## Non-goals
- Do not change `gov-ai.js`, `gov-ai-api.js`, bot flows, or the Week 10 load harness.
- Do not expand the benchmark beyond a two-model comparison; keep it to Ambient and one closed baseline.
- Do not build a full scientific evaluation framework or semantic grading system.
- Do not do unrelated cleanup in neighboring files.

## Week 12 framing
This work is for the **developer loop**, not the user loop.
The benchmark should help a developer answer:
1. **Output quality** — did the provider return parseable, schema-shaped, sufficiently complete output?
2. **Latency** — how fast are successful runs across a small distribution, not just one average?
3. **Failure modes** — what failed, how often, and is retry masking a systemic issue?

## Milestones
1. Extract benchmark summarization/quality/failure helpers into a dedicated module.
2. Add RED tests for quality scoring, latency summaries, and failure-mode aggregation.
3. Implement helper module and wire `bench.js` to use it.
4. Update benchmark artifacts so JSON/text outputs expose Week 12 metrics clearly.
5. Run tests and syntax checks, then fix any issues.

## Files / subsystems
- `bench.js` — benchmark entrypoint and artifact writer
- `bench-helpers.js` — new benchmark-only helper module
- `bench.test.js` — tests for Week 12 benchmark logic
- `week12-bench/plan.md` — durable plan artifact

## Implementation tasks
1. Create a helper module for:
   - safe model JSON parsing
   - deterministic benchmark quality evaluation
   - latency distribution summary (`min`, `avg`, `median`, `p95`, `max`)
   - failure classification and aggregation
   - per-provider benchmark summary generation
2. Extend per-run benchmark records with:
   - `quality`
   - `failure_type`
   - `failure_message`
3. Define a simple benchmark quality rubric based on current report shape:
   - valid JSON
   - required top-level sections present
   - required analysis/recommendation fields present
   - completeness score for developer comparison
4. Update saved JSON artifact to include Week 12-friendly summaries for quality, latency, and failures.
5. Update text summary output to surface these same metrics concisely.

## Validation / test strategy
- TDD where reasonable for new benchmark helper behavior:
  - RED: add failing tests for quality evaluation, failure classification, and summary aggregation
  - GREEN: implement minimum logic to pass
  - REFACTOR: keep `bench.js` simple by moving logic into helpers
- Run:
  - `node --test bench.test.js`
  - `node --check bench.js`
  - `node --check bench-helpers.js`

## Risks / assumptions
- Assumption: a lightweight shape/completeness check is enough for Week 12 output-quality benchmarking; no deep semantic judge is required.
- Assumption: the closed baseline should be GPT-5.4 via OpenRouter instead of the previous Nous path.
- Assumption: keeping `bench.js` as the CLI entrypoint is preferable to introducing a larger harness.
- Risk: provider responses may include fenced JSON or extra text; the parser should tolerate that when possible.
- Risk: existing example benchmark artifacts may not reflect the new schema until the benchmark is rerun.

## Definition of done
- `bench.js` produces Week 12-oriented benchmark artifacts covering output quality, latency, and failure modes.
- New benchmark logic is covered by automated tests.
- Relevant checks pass locally.
- No out-of-scope project behavior is changed.
