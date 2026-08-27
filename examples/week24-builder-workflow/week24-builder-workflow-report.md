# Week 24 builder workflow report

Theme: Builders First
Status: complete
Project: gov-ai
Workflow type: ambient_backed_coding_agent_style
Model requested: ambient/large

## Metrics
- stages ok: 3/3
- request id present: 3/3
- streamed stages: 3/3
- retry attempts total: 3

## Stage results

### plan
- role: planner
- ok: true
- status: 200
- latency_ms: 11674
- first_byte_ms: 713
- request_id_present: true
- failure_type: null

Output preview:

```
# Implementation Plan: gov-ai Developer Workflow with Ambient Behind Coding-Agent CLI

## Goal
Provide a reusable workflow where a coding-agent-style CLI invokes Ambient as its execution backend, while the Hermes profile remains the default/unchanged main profile. Ambient is selected via config/env, not by editing Hermes.

## Non-Goals
- Modifying Hermes profile behavior or defaults.
- Building a new agent runtime; reuse existing Ambient capabilities.
- Shipping to production; this is a developer-facing workflow/template.

## Architecture Overview
```
coding-agent CLI (entrypoint)
   └── workflow adapter (selects backend profile)
         ├── default: Hermes profile (unchanged)
         └── 
```

### implementation_sketch
- role: implementer
- ok: true
- status: 200
- latency_ms: 12714
- first_byte_ms: 547
- request_id_present: true
- failure_type: null

Output preview:

```
# Patch Sketch: gov-ai Developer Workflow

## Goal
Wrap the Ambient profile behind a coding-agent CLI surface so it can be invoked programmatically while the main Hermes profile remains untouched.

---

## Files

### `src/profiles/ambient.ts`
```ts
export interface AmbientConfig {
  id: 'ambient';
  parent?: 'hermes';
  sandbox: boolean;
  timeoutMs: number;
  tools: string[]; // subset of Hermes tools
}

export function createAmbientProfile(overrides?: Partial<AmbientConfig>): AmbientConfig
```
- Imports `HermesConfig` type from `./hermes` for compatibility check, never mutates it.
- Default: `sandbox: true`, `timeoutMs: 30000`, `tools: ['read','write','grep','test']`.

### `src/workflows/d
```

### review
- role: reviewer
- ok: true
- status: 200
- latency_ms: 22795
- first_byte_ms: 606
- request_id_present: true
- failure_type: null

Output preview:

```
# Code Review: gov-ai Developer Workflow (Ambient behind coding-agent CLI)

## Acceptance Checks

**Transparency / non-invasiveness**
- [ ] Hermes profile config file remains byte-identical before/after wiring Ambient
- [ ] CLI launches with only env-var overrides (e.g. `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) — no CLI source patches
- [ ] Model name sent by CLI is preserved end-to-end (Ambient does not silently rewrite `model` field unless explicitly configured)
- [ ] A "bypass" mode exists: unset env var → CLI talks directly to upstream, no behavioral drift

**Functional parity**
- [ ] Non-streaming `/v1/messages` and `/v1/chat/completions` round-trip: system, user, assistant, tool_result 
```

## Interpretation

This is a developer-workflow probe, not a model leaderboard. It checks whether Ambient can sit behind a coding-agent-style loop with planning, implementation sketching, review, streaming, retries, auth, and report artifacts.

Workflow sha256: 2fbe268297900c9a43cc180eb5146a18153c07d5fbd370c2271df4a189d1915e
