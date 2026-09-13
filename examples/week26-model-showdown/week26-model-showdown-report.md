# Week 26 model showdown report

Status: complete
Window: 2026-09-13T07:12:04.930Z — 2026-09-13T07:12:45.519Z
Logical requests: 24

## Direct model ranking
1. qwen/qwen3.8-27b
2. qwen/qwen3.6-27b
3. z-ai/glm-5.2

## Model summaries
### z-ai/glm-5.2
- group: direct
- correctness: 100/100
- exact matches: 6/6
- completion: 6/6
- consistency: 66.66666666666667%
- latency median: 1910.5 ms
- TTFT median: 1624.5 ms
- returned models: {"z-ai/glm-5.2":6}

### qwen/qwen3.6-27b
- group: direct
- correctness: 100/100
- exact matches: 6/6
- completion: 6/6
- consistency: 100%
- latency median: 885 ms
- TTFT median: 412 ms
- returned models: {"qwen/qwen3.6-27b":6}

### qwen/qwen3.8-27b
- group: direct
- correctness: 100/100
- exact matches: 6/6
- completion: 6/6
- consistency: 100%
- latency median: 895 ms
- TTFT median: 393 ms
- returned models: {"qwen/qwen3.8-27b":6}

### ambient/large
- group: routed_baseline
- correctness: 100/100
- exact matches: 6/6
- completion: 6/6
- consistency: 100%
- latency median: 2208 ms
- TTFT median: 1971 ms
- returned models: {"z-ai/glm-5.2":6}

## Scope

- Small deterministic developer probe, not a general model leaderboard.
- API evidence only; no web-UI behavior was tested.
- Latency observations apply only to the recorded time window.