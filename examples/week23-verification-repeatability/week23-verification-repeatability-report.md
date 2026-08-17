# Week 23 verification repeatability

Theme: Verified Intelligence

## Result
- Status: complete
- Total runs: 10
- Deterministic: true
- Latency ms min/avg/max: 0.311 / 0.697 / 3.551
- Benchmark hash: 58c0fcde1c9e8cab55c24aacebfb46d19cafb64116ebfd7041f738c1f7a2fc72

## Preserved proof fields
- verified: true
- merkle_root: 88d6e16e438a8fcff1c02419aa290b7ea47c81b146b5f56ef7d36bce3cc105e4
- request_id: 4b04aec58e2a4e8ab5dda4a09b70af00

## Repeatability groups
- strict_mode=false: deterministic=true, unique_hashes=1, routing=WARN
- strict_mode=true: deterministic=true, unique_hashes=1, routing=HUMAN_REVIEW

## Limitations
- This benchmark verifies deterministic local verification-hook behavior, not live model accuracy.
- Latency and memory metrics are smoke-test signals and vary by hardware/runtime.
- Ambient verified, merkle_root, and request_id fields are preserved as proof metadata and are not recomputed locally.

## Product use
Use this artifact as a reproducibility gate for gov-ai verification hooks before trusting repeated reports or comparing live model outputs. It should fail review if repeated local verification produces drift for the same report/proposal fixture.
