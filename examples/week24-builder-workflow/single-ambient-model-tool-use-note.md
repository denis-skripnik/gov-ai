# Week 24 — Single-Model Tool-Use Verification Note

## Provider / Model Claimed by This Run

- Provider: `custom`
- Model: `ambient/large`
- Base URL: `https://api.ambient.xyz/v1`
- Fallback providers: none (single-model configuration)
- Profile: `ambientweek24single` (temporary, single-model verification profile)

This run was executed inside a Hermes temporary profile configured with a single
model (`ambient/large`) and no fallback providers, so every tool-use decision in
this session originated from that one model.

## Files Inspected

1. `/home/assistent/ai-projects/gov-ai/package.json`
   - Project name: `gov-ai`, version `0.1.0`, ESM (`"type": "module"`).
   - Dependencies: `dotenv` (^17.2.3), `grammy` (^1.38.0).
   - Binary entry point: `gov-ai` → `./gov-ai.js`.

2. `/home/assistent/ai-projects/gov-ai/gov-ai.js`
   - CLI entry point dispatching subcommands: `init`, `analyze`,
     `multi-agent-review`, `open-inference-loop`, `agent-pipeline`,
     `routing-intelligence`, `model-evaluation`,
     `verification-repeatability`, `builder-workflow`.
   - Week 24 builder-workflow handler (lines 179–199) defaults the model to
     `ambient/large` via `process.env.WEEK24_BUILDER_MODEL || "ambient/large"`.
   - Loads `principles.json`, requires `AMBIENT_API_KEY` for the analyze path,
     and routes reports through deterministic multi-agent council and
     verification-hook classification.

No secret files (`.env`, API keys, tokens) were inspected.

## Tool Actions Used

| Step | Tool | Action |
|------|------|--------|
| 1 | `read_file` | Read `package.json` (12 lines, 183 bytes). |
| 2 | `read_file` | Read `gov-ai.js` (716 lines, truncated at 500; first 500 lines inspected). |
| 3 | `write_file` | Created this note at `examples/week24-builder-workflow/single-ambient-model-tool-use-note.md`. |
| 4 | `terminal` | Verified the file exists and contains the string `ambient/large`. |

All tool calls were executed by the Hermes agent runtime. The model (`ambient/large`)
decided which tools to call, in what order, and with which arguments; Hermes
performed the actual file reads, writes, and shell commands.

## Limitation

Tools are executed by Hermes, but tool-use decisions — which tool to call, what
arguments to pass, when to stop, and how to interpret results — come from the
model loop (`ambient/large`). This means the correctness and completeness of the
workflow depend on the single model's reasoning, not on a multi-model or
fallback safety net. If the model misjudges a step, Hermes will faithfully
execute the wrong action; there is no second model to catch the error in this
single-model profile.
