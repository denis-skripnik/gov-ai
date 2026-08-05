# Week 22 API/Web model recheck

## Why

Denis asked whether Week 22 used only GLM and whether Ambient had added DeepSeek, Kimi, or other models in the API and web UI.

## API `/models` result

Checked live Ambient API `/models` with the `gov-ai` Ambient key.

Result:
- HTTP status: 200
- Models observed: 21

Observed families:
- Ambient routers: `ambient/large`, `ambient/small`
- GLM / Z.ai: `z-ai/glm-5.2`, `z-ai/glm-4.5-air`
- Gemma: `google/gemma-4-26b-a4b-it`, `google/gemma-4-31b-it`
- OpenAI OSS: `openai/gpt-oss-120b`, `openai/gpt-oss-20b`
- Kimi / Moonshot: `moonshotai/kimi-k2.5`, `moonshotai/kimi-k2.6`, `moonshotai/kimi-k2.7-code`
- Qwen: `qwen/qwen3-coder-30b-a3b-instruct`, `qwen/qwen3-next-80b-a3b-instruct`, `qwen/qwen3.5-35b-a3b`, `qwen/qwen3.6-27b`, `qwen/qwen3.6-35b-a3b`
- DeepSeek: `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-flash-0731`
- Other: `nvidia/nemotron-3-nano-30b-a3b`, `stepfun/step-3.7-flash`, `xiaomi/mimo-v2.5`

## Small live smoke

Prompt: `Say exactly: OK`

Observed:
- `moonshotai/kimi-k2.7-code`: HTTP 200, returned `OK`
- `deepseek/deepseek-v4-flash-0731`: HTTP 200, returned `OK`
- `moonshotai/kimi-k2.6`: HTTP 429, no workers available
- `deepseek/deepseek-v4-flash`: earlier smoke returned HTTP 429, no workers available
- `qwen/qwen3-coder-30b-a3b-instruct`: earlier smoke returned HTTP 429, no workers available
- `openai/gpt-oss-120b`: earlier smoke returned HTTP 429, no workers available
- `ambient/large`: HTTP 200, routed to `z-ai/glm-5.2`, but with small token limits it spent tokens as reasoning and produced empty visible content in this exact tiny prompt smoke.
- `ambient/small`: HTTP 200, routed to Gemma, but with small token limits it also produced empty visible content in this exact tiny prompt smoke.

## Web UI result

Checked the logged-in Ambient web chat.

Visible model/mode controls:
- top dropdown: `Chat`, `Thinking`
- input `+` button: opens file picker, not model selection
- no visible DeepSeek/Kimi/GLM/raw-model selector near the input field

## Updated recommendation

The first Week 22 report was not wrong for web UI: the web chat currently exposes only Chat/Thinking, so that User Loop can stay as-is.

But for API/dev study, we should add at least:
- Kimi code: `moonshotai/kimi-k2.7-code`
- DeepSeek: `deepseek/deepseek-v4-flash-0731`

Use them in a small API model-comparison addendum, not as replacement for the browser User Loop.
