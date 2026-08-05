# Week 22 Infra Loop — Ambient low-volume multi-model probe

## Scope and safety
- Evidence timestamp: 2026-08-05T12:31:29.595Z → 2026-08-05T12:31:35.384Z
- Live chat requests: 4
- Concurrency: 1
- Max tokens per chat request: 64
- No API keys, prompts with sensitive data, deployment, commits, or aggressive load were used.

## Live API evidence
- /models status: 200; ok: true; latency: 716 ms; request id present: false; ids observed: 21

| model_requested | status | ok | latency_ms | request_id_present | model_returned | output_field | error_preview |
|---|---:|---|---:|---|---|---|---|
| ambient/large | 200 | true | 1212 | true | z-ai/glm-5.2 | choices[0].message.content |  |
| zai-org/GLM-5.1-FP8 | 400 | false | 177 | false |  |  | {"error":{"message":"Unknown model: 'zai-org/GLM-5.1-FP8'. Valid models: ['ambient/large', 'ambient/small', 'z-ai/glm-5.2', 'z-ai/glm-4.5-air', 'google/gemma-4-26b-a4b-it', 'google/gemma-4-31b-it', 'openai/gpt-oss-120b', |
| z-ai/glm-5.2 | 200 | true | 1086 | true | z-ai/glm-5.2 | choices[0].message.content |  |
| google/gemma-4-26b-a4b-it | 200 | false | 2598 | true | gemma-4-26B_q4_0-it-21bfe2a8.gguf | choices[0].message.content |  |

## Live metrics
- Successful models: 2/4
- Failed models: 2/4
- Latency min / avg / max: 177 / 1268 / 2598 ms
- Request-id presence: 3/4
- Models returning content field: 3/4

## Synthetic/local evidence
- Source: deterministic local fallback design derived from Week 21 routing profiles; no extra live requests
- Simulated request count: 0
- Primary if available: z-ai/glm-5.2
- Fallback if unavailable: ambient/large
- All-live-fail behavior: gov-ai local/mock routing profile only; do not synthesize live Ambient evidence

## Limitations
- This is an operations smoke probe, not a quality benchmark.
- One tiny prompt per model cannot prove reliability, reasoning quality, or factual accuracy.
- Sequential low volume avoids capacity pressure, so it does not measure concurrent load behavior.
- Request-id presence is recorded as a boolean only; exact request IDs are intentionally not stored in the summary table.
- If /models is unavailable or partial, candidate models fall back to the conservative local allowlist.
