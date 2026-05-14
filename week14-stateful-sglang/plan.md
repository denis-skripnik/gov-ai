# Week 14 plan - Stateful + faster systems

## Goal

Implement a developer-loop proof that `gov-ai` can combine explicit state/memory with the Week 14 SGLang performance focus.

The default project is `gov-ai` because previous Ambient developer-loop work already lives here. If the weekly assignment stops fitting governance-analysis workflows, move the work into a new dedicated project instead of forcing it into this repository.

## Scope

- Add a small JSON-backed memory layer.
- Feed bounded prior state into prompts.
- Add a live OpenAI-compatible benchmark runner for the Ambient API/SGLang rollout path.
- Compare no-memory vs with-memory prompt modes.
- Capture latency, retries, failure modes, JSON validity, and output stability.
- Commit example benchmark artifacts.

## Non-goals

- Do not change the main production governance pipeline.
- Do not require a local SGLang server.
- Do not claim semantic correctness from exact-output stability.
- Do not treat the developer-loop API benchmark as the User Loop chat test.

## Files

- `week14-stateful-sglang/memory-store.js`
- `week14-stateful-sglang/prompt-state.js`
- `week14-stateful-sglang/sglang-bench.js`
- `week14-stateful-sglang/week14.test.js`
- `examples/week14-stateful-sglang/*`

## Validation

- Unit tests: `node --test week14-stateful-sglang/week14.test.js`
- Mock benchmark: `node week14-stateful-sglang/sglang-bench.js --mock`
- Live benchmark against Ambient API with `SGLANG_API_URL`, `SGLANG_API_KEY`, and `SGLANG_MODEL` set.

## Definition of done

- Memory prompt path works locally.
- Live benchmark produces JSON and text artifacts.
- Artifacts show latency, throughput, retries, failures, JSON validity, and stability.
- README has a Week 14 block above Week 12.
