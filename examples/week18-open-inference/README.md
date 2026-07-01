# Week 18 — Open Inference Runtime Matrix

This example validates the Week 18 Developer Loop idea for `gov-ai`: the same governance proposal can be evaluated through configurable OpenAI-compatible runtime profiles while preserving runtime telemetry.

## Local mock smoke test

```bash
WEEK18_MOCK=true node gov-ai.js open-inference-loop examples/week18-open-inference/mock-proposal.json
```

The mock path does not call external services. It validates orchestration, fallback selection, JSON quality checks, and artifact writing.

## Live runtime profiles

The runner can use:

- Ambient runtime from the existing Ambient environment variables.
- Any external OpenAI-compatible endpoint via `OPEN_INFERENCE_API_URL` and `OPEN_INFERENCE_MODEL`.

The output records model, stream flag, latency, JSON validity, schema completeness, failure type, and verification metadata when the runtime provides it.
