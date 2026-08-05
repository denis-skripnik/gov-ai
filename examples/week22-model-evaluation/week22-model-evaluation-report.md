# Week 22 model evaluation

Theme: Beyond One Model

## Result
- Status: complete
- Models/profiles compared: 4
- Evaluation cases: 5
- Strong-fit evaluations: 8
- Benchmark hash: 7556873fb67923805f6b1343f27e218f03f99425c854cf39137142d88f12c8d6

## Best profile by product dimension
- structured_output: fast_summarizer — strong_fit (93/100)
- hallucination_resistance: conservative_verifier — strong_fit (92/100)
- reasoning: deep_governance_reasoner — strong_fit (90/100)
- research_grounding: conservative_verifier — strong_fit (92/100)
- coding_tooling: code_tool_specialist — strong_fit (92/100)

## Live API comparison addendum

A follow-up Dev Loop addendum compares real Ambient API responses for `ambient/large`, `z-ai/glm-5.2`, `moonshotai/kimi-k2.7-code`, and `deepseek/deepseek-v4-flash-0731` on three gov-ai tasks: structured JSON, missing-evidence guardrail, and coding fixture.

Artifact: `examples/week22-model-evaluation/live-model-comparison-v2/week22-live-model-comparison-report.md`

Small-run result:
- `ambient/large`: 3/3 successful, average score 98, average latency 9325 ms.
- `z-ai/glm-5.2`: 3/3 successful, average score 90, average latency 4084 ms.
- `moonshotai/kimi-k2.7-code`: 3/3 successful, average score 92, average latency 3565 ms.
- `deepseek/deepseek-v4-flash-0731`: 3/3 successful, average score 83, average latency 18457 ms.

Best by dimension in this small run:
- Structured output: `moonshotai/kimi-k2.7-code`.
- Missing-evidence guardrail: `ambient/large`.
- Coding fixture: `moonshotai/kimi-k2.7-code`.

## Limitations
- This is not a leaderboard-quality benchmark; it is a deterministic product benchmark over a small governance fixture.
- The live comparison addendum is a small API comparison only: 4 models, 3 cases, single run per case.
- Scores estimate product fit for gov-ai routing and regression use, not general model intelligence.

## Product use
Use this artifact to choose which model/profile to try for each gov-ai task type: schema output, missing-evidence guardrails, reasoning, source grounding, and fixture/tooling work. Treat it as model-selection evidence for this product, not as a broad benchmark of model quality.
