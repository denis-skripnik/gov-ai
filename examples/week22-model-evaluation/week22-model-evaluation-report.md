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

## Limitations
- This is not a leaderboard-quality benchmark; it is a deterministic product benchmark over a small governance fixture.
- Scores are policy-fit heuristics for gov-ai routing and prompt evaluation, not measured model intelligence.
- Use live API results only as an additional low-volume smoke check, and keep outputs sanitized.

## Product use
Use this artifact to choose which model/profile to try for each gov-ai task type: schema output, missing-evidence guardrails, reasoning, source grounding, and fixture/tooling work. Treat it as model-selection evidence for this product, not as a broad benchmark of model quality.
