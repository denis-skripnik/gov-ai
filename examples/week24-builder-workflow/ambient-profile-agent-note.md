# Ambient Profile Agent Note — Week 24 Builders First Probe

## Command tested

```
node gov-ai.js builder-workflow examples/week24-builder-workflow "Add a small developer-facing integration example for Ambient-backed coding workflows."
```

The `builder-workflow` subcommand (gov-ai.js line 179) calls
`runWeek24BuilderWorkflow()` from `week24-builder-workflow.js`, which runs a
three-stage plan → implementation_sketch → review loop against the Ambient API
(`ambient/large` by default) and writes JSON + Markdown artifacts into this
directory.

## Files inspected

- `/home/assistent/ai-projects/gov-ai/package.json` — gov-ai project manifest.
  ESM (`"type": "module"`), `bin` entry `gov-ai → ./gov-ai.js`, dependencies are
  `dotenv` and `grammy`. No Ambient-specific dependency ships here; Ambient is
  reached as a remote model provider, not a bundled library.
- `/home/assistent/ai-projects/gov-ai/gov-ai.js` — CLI entry point. Week 24
  block at line 178–199 reads `WEEK24_BUILDER_MODEL` / `MAX_TOKENS` / `ATTEMPTS`
  env vars and delegates to the workflow module.
- `/home/assistent/ai-projects/gov-ai/week24-builder-workflow.js` — workflow
  implementation. Default base URL `https://api.ambient.xyz/v1`, default model
  `ambient/large`. Stages are built by `buildWeek24BuilderStages()`. SSE
  parsing via `parseSseFrames()`.

## Practical friction point

The workflow assumes a standard OpenAI-compatible `/chat/completions` streaming
endpoint with SSE `data:` frames. When Ambient is used as a coding-agent
backend, the real friction is that there is no native tool-calling / function-
calling surface in this workflow path: stages are plain text prompts and
responses, so structured tool dispatch (file edits, terminal runs) must be
orchestrated by the outer agent shell (Hermes), not by the model itself. This
means Ambient works fine as a reasoning/text-generation layer, but any
agentic tool-use loop has to be built around it rather than delegated to it.
This separate profile run exposed cwd/profile scoping friction, so absolute
paths are safer for reproducible builder examples.
