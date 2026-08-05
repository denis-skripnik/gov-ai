# Week 22 live model comparison addendum

Status: complete
Models compared: 4
Cases: 3
Comparison hash: 5468b77ace638f36e1d53ae2dfe998e96d7a4a52b1317e222f29c3b0d4959a41

## Per-model summary
- ambient/large: 3/3 successful, average score 98, average latency 9325 ms
- z-ai/glm-5.2: 3/3 successful, average score 90, average latency 4084 ms
- moonshotai/kimi-k2.7-code: 3/3 successful, average score 92, average latency 3565 ms
- deepseek/deepseek-v4-flash-0731: 3/3 successful, average score 83, average latency 18457 ms

## Best model by dimension in this small run
- structured_output: moonshotai/kimi-k2.7-code, score 100, latency 1606 ms
- hallucination_resistance: ambient/large, score 95, latency 4988 ms
- coding_tooling: moonshotai/kimi-k2.7-code, score 100, latency 4246 ms

## Recommendations
- Use ambient/large as the production default router because it hides some direct-model volatility.
- Include Kimi code in Dev Loop coding/tooling comparisons when workers are available.
- Include DeepSeek flash 0731 in Dev Loop reasoning and guardrail comparisons because it answered the smoke check and is a distinct family from GLM.
- Treat direct model IDs as availability-sensitive: rerun a small probe before publishing strong model claims.

## Limitations
- Small live comparison only: 4 models, 3 cases, single run per case.
- Scores are rubric checks for gov-ai report utility, not general intelligence scores.
- No secrets, private content, or production writes were used.
