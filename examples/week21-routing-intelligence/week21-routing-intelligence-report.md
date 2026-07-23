# Week 21 routing intelligence

## Result
- Status: complete
- Tasks routed: 6
- Average estimated TTFT: 507 ms
- Capacity fallback count: 1
- Route stability: 1
- Benchmark hash: 56eb8dcec2394f825139c65f60b637432e204f717e19cd8932ca910d2c92bed8

## Routing decisions
- summary_fast_path (summary): fast_summary_model — routed
- treasury_risk_review (treasury_risk): deep_governance_reasoner — routed
- policy_compliance_check (policy_compliance): balanced_policy_model — routed
- decision_support (decision_support): deep_governance_reasoner — routed
- prompt_injection_edge (routing_edge_case): balanced_policy_model — routed
- treasury_capacity_spike (treasury_risk): balanced_policy_model — capacity_fallback

## Edge cases
- prompt_injection: safe_edge_route via balanced_policy_model

## Interpretation
This is a deterministic local benchmark. It measures application-level routing policy behavior: category classification, capacity-aware fallback, latency preference, consistency, and safe handling of routing edge cases. It does not prove live Ambient network latency or factual answer quality.
