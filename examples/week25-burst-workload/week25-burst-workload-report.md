# Week 25 bounded burst workload report

Theme: Under Pressure
Status: complete
Model requested: ambient/large

## Metrics
- requests: 6/6 successful
- failed requests: 0
- request id present: 6/6
- streamed requests: 6/6
- retry attempts total: 6
- returned models: z-ai/glm-5.2

## Phases
- quiet_baseline: concurrency 1, requests 1, success 1/1
- parallel_burst: concurrency 2, requests 2, success 2/2
- sustained_low_volume: concurrency 1, requests 2, success 2/2
- recovery: concurrency 1, requests 1, success 1/1

## Scope

This is a bounded low-volume demand-shift probe, not a stress test and not evidence of network-wide capacity. Compare reports only when timestamps, prompt mix, and concurrency are recorded.