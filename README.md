# gov-ai

AI assistant for DAO governance proposals.

## Table of Contents

- [Week 6 - Refusal handling (Web2)](#week-6---refusal-handling-web2)
- [Moderator checklist (Week 6 Web2)](#moderator-checklist-week-6-web2)
- [Run analysis (CLI)](#run-analysis-cli)
- [Output format](#output-format)
- [Example reports](#example-reports)
- [API server (production-style)](#api-server-production-style)
- [Report viewer (pageServer.js)](#report-viewer-pageserverjs)
- [Benchmark (Web2 Micro-Challenge #4)](#benchmark-web2-micro-challenge-4)
- [Week 5 - Verification boundaries (Micro-Challenge #5)](#week-5---verification-boundaries-micro-challenge-5)
- [Important limitations](#important-limitations)

This project started as **Web3 Developer Loop - Experiment #3 (AI for governance or automation)**.
It now also documents and ships:
- Week 5 verification boundaries (verifiable vs interpretive layers)
- Week 6 refusal handling (Web2): deterministic refusal detection plus routing and human review tickets

It takes a proposal URL (Snapshot, Tally, DAO DAO), extracts available data, and produces a structured analysis:
- summary of the proposal
- key changes
- benefits
- risks
- unknowns / missing information
- recommendation based on user principles
- explicit limitations

The design goal is **honesty and conservatism**:
- if some data cannot be extracted, it is marked as `UNKNOWN`
- the tool does not guess voting options or results
- the output is meant to **assist** human decision-making, not replace it

---

## Week 6 - Refusal handling (Web2)

Refusal is a **system decision**, not just model text.

The detector uses deterministic signals from the produced report and extracted input:
- `recommendation.suggested_option == "UNKNOWN"`
- `recommendation.confidence == "low"`
- missing extracted options (`extracted.options` is empty)
- `analysis.unknowns` is present (underspecified inputs)
- `extracted.source_type == "generic"` (incomplete-source signal)

Current conservative trigger rule marks refusal when high-signal conditions are present (`UNKNOWN` option, low confidence, missing options, or unknowns present). The system can still route to review based on incomplete inputs even when model wording sounds confident.

---

## Downstream handling (routing)

CLI runs produce explicit downstream artifacts:
- full report in `reports/`
- routing decision in `routes/route-*.json` for every run
- review ticket in `reviews/ticket-*.json` when refusal is detected

Review tickets store a reference to `report_path` instead of duplicating the report payload.
This keeps refusal behavior observable and auditable across report, route, and review artifacts.

---

## Moderator checklist (Week 6 Web2)

- Prompt used: `report.input.prompt_used`
- Refusal state and signals: `report.refusal_handling.refusal_detected` and `report.refusal_handling.signals`
- Routing trail: `routes/`, `reviews/`, and the referenced report in `reports/`

---

## Supported sources

- Snapshot (via official GraphQL API)
- Tally (via official GraphQL API, requires API key)
- DAO DAO (via Next.js `__NEXT_DATA__` fallback extraction)
- Any other site: generic HTML text fallback (best-effort)

**Note on Tally URLs:** Tally URLs may use organization slug in the format `/gov/<slug>/...`. The tool resolves the governor address via the Tally API.

---

## Setup

```bash
npm install
```

Create `.env` (see `.env.example` for reference):

```env
AMBIENT_API_KEY=...
PROPOSAL_URL="https://..."
TALLY_API_KEY=...   # optional, only for tally.xyz
PORT=3000           # optional, default port for gov-ai-api.js
PAGE_PORT=3100      # optional, default port for pageServer.js
```

**Environment variables:**
- `AMBIENT_API_KEY` (required) - API key for Ambient inference provider
- `PROPOSAL_URL` (required for CLI) - URL of the proposal to analyze
- `TALLY_API_KEY` (optional) - API key for Tally GraphQL API, required only for Tally proposals
- `PORT` (optional) - Port for the HTTP API server (default: 3000)
- `PAGE_PORT` (optional) - Port for the report viewer server (default: 3100)

---

## Init user principles

```bash
node gov-ai.js init
```

Edit `principles.json` and fill in your preferences.

---

## Run analysis (CLI)

```bash
node gov-ai.js
```

or

```bash
node gov-ai.js analyze <url>
```

The result will be saved as:

- `reports/report-*.json` - full analysis report
- `routes/route-*.json` - routing decision
- `reviews/ticket-*.json` - review queue ticket (only when refusal is detected)

Notes:
- CLI report filenames still use source-aware naming when available (for example `report-snapshot-...`, `report-tally-...`, or `report-<timestamp>.json`).
- `reports/`, `routes/`, and `reviews/` are created automatically by the CLI when needed.

---

## Two modes: CLI and API

This repository contains two ways to run the project:

- `gov-ai.js` - CLI / demo version for local usage and experiments.
- `gov-ai-api.js` - minimal HTTP API server suitable as a base for a service.

Both use the same core logic (`fetcher.js` and `analyzer.js`) and produce the same report JSON format.

---

## API server (production-style)

To run the HTTP API server:

```bash
node gov-ai-api.js
```

By default it starts on:

```
http://localhost:3000
```

(you can override the port via `PORT` environment variable)

### Endpoints

#### POST /analyze

Starts analysis in background and returns a job id.

Request body:

```json
{
  "url": "https://...",
  "principles": { }
}
```

If `principles` is not provided, the server uses `principles.json`.

Response:

```json
{
  "status": true,
  "job_id": "2026-01-24T13-05-12-123Z",
  "queued": true
}
```

#### GET /job/:id

Returns the result when ready.

If not ready:

```json
{ "status": false }
```

If ready:

```json
{
  "status": true,
  "report": { }
}
```

---

## Report viewer (pageServer.js)

To view saved reports in a browser, run the report viewer server:

```bash
node pageServer.js
```

By default it starts on:

```
http://localhost:3100
```

(you can override the port via `PAGE_PORT` environment variable)

The viewer provides:
- A list of all saved reports in the `reports/` directory
- Individual report pages with structured display of all analysis fields
- Support for English (default) and Russian via `?lang=ru` query parameter
- Rendering of the `benefits` field alongside other analysis sections
- Display of `__ambient` verification metadata when present in the report JSON

Page server behavior:
- It reads reports from `./reports/`.
- Example files are not loaded automatically at runtime.
- To view bundled examples in the browser, copy files from `examples/reports/` into `reports/`.

---

## prod-reports

When using the API server, finished reports are saved to the `prod-reports/` folder:

```
prod-reports/<job_id>.json
```

This folder acts as a simple file-based storage for completed jobs.

---

## Output format

The tool produces a structured JSON report with these main blocks:

- `input` - source URL and metadata
- `extracted` - data actually extracted from the source
- `analysis` - LLM-generated structured analysis
- `recommendation` - suggested action + reasoning
- `limitations` - explicit list of caveats
- `verification_boundary` - Week 5 deterministic vs interpretive split
- `refusal_handling` - Week 6 refusal decision and deterministic signals
- `week6_evaluation` - manual evaluation placeholder (`agree_with_refusal`)

Key analysis fields:
- `analysis.summary` - brief overview of the proposal
- `analysis.key_changes` - list of key changes proposed
- `analysis.benefits` - list of potential benefits
- `analysis.risks` - list of identified risks
- `analysis.unknowns` - list of unknown or missing information
- `analysis.evidence_quotes` - relevant quotes from the proposal text

### Prompt provenance

Each report includes `report.input.prompt_used` for reproducibility without duplicating the full prompt payload.

Included fields:
- `prompt_used_excerpt`
- `prompt_used_sha256`
- `prompt_used_files`

`prompt_used_files` references input files (with per-file hashes), including:
- `./principles.json`
- `./report.schema.json`

### Ambient verification (optional)

When using Ambient as the inference provider, the report includes an extra top-level field `__ambient`.
It contains verification metadata returned by Ambient (receipt-like info), for example:

- verified: boolean
- merkle_root: string
- request_id: string
- model: string
- verified_by_validators: string (example: "Verified by 3 validators")
- auction: { status, bids: { placed, revealed }, address } (may be null)
- bidder: string (explorer URL) (may be null)

Notes:
- To capture "UI-like" fields such as auction and bidder, streaming must be enabled (stream=true).
- This does not prove that the proposal data is correct - it only attaches provider-side verification metadata for the inference request.

---

## Example reports

This repository includes example artifacts for testing and demonstration.

Examples live under:
- `examples/reports/`
- `examples/routes/`
- `examples/reviews/`

Report examples:
- [report-snapshot-0xe5435766bae1f44d1ce354cea93acf4f38216f4e7ca071ccbb0ad0e856b34363.json](examples/reports/report-snapshot-0xe5435766bae1f44d1ce354cea93acf4f38216f4e7ca071ccbb0ad0e856b34363.json)
- [report-tally-ens-107313977323541760723614084561841045035159333942448750767795024713131429640046.json](examples/reports/report-tally-ens-107313977323541760723614084561841045035159333942448750767795024713131429640046.json)
- [report-2026-02-26T06-07-34-157Z.json](examples/reports/report-2026-02-26T06-07-34-157Z.json)

Routing and review examples:
- [route-2026-02-26T06-07-34-158Z.json](examples/routes/route-2026-02-26T06-07-34-158Z.json)
- [ticket-2026-02-26T06-07-34-158Z.json](examples/reviews/ticket-2026-02-26T06-07-34-158Z.json)

Examples are documentation-only fixtures. Runtime outputs are written to `reports/`, `routes/`, and `reviews/`.

---

## Important limitations

- This is **NOT** financial, legal, or governance advice.
- The tool may fail to extract all proposal parameters.
- Voting options or current results may be missing.
- The AI model may misunderstand technical details.
- Refusal routing escalates ambiguous or underspecified cases to human review instead of forcing a confident answer.
- **Critical proposals must always be reviewed manually.**

This tool helps with **orientation and structuring**, not with making final decisions.

---

## What this project is NOT

- It is NOT a trustless or cryptographically verifiable system.
- It does NOT prove that the proposal data is correct.
- It does NOT provide trustless / end-to-end verifiable inference integrity.
- It may attach provider-side verification metadata (Ambient "__ambient"), but this is not the same as full trustless verification.
- It does NOT automatically vote or execute actions.

---

## Implementation notes

The project is implemented in Node.js.

- The CLI version (`gov-ai.js`) is intended for local usage and experiments.
- The API version (`gov-ai-api.js`) exposes the same functionality over HTTP.

Both use the Ambient API (v1 chat completions) for LLM inference. The API key is created on the Ambient website in the "API Keys" section and provided via the `AMBIENT_API_KEY` environment variable.

---

## Why this exists

The goal is to explore how AI can:
- reduce cognitive load when reading long proposals
- highlight risks and unknowns
- make governance participation more accessible
- while staying honest about uncertainty and failure modes

## Benchmark (Web2 Micro-Challenge #4)

This repository also includes an optional benchmark script used to compare **cost, latency, and reliability** of different inference providers using the same extracted proposal data and the same prompt.

This was created as part of **Web2 Developer Loop - Micro-Challenge #4 (cost + latency reality check)**.

### Files

- `bench.js` - runs a benchmark for a given proposal URL and saves results to `bench-results/`.

### Run

```bash
node bench.js "https://daodao.zone/dao/juno/proposals/370"
```

or set `PROPOSAL_URL` in `.env`.

### Environment variables (in addition to the main ones)

```env
NOUS_API_KEY=...
NOUS_MODEL=Hermes-4-70B

BENCH_RUNS=3
BENCH_TIMEOUT_MS=30000
BENCH_RETRIES=2

# Pricing (USD per 1M tokens), used to estimate cost from token usage:
AMBIENT_TIER=standard   # or mini
AMBIENT_STANDARD_IN_PER_M=0.35
AMBIENT_STANDARD_OUT_PER_M=1.71
AMBIENT_MINI_IN_PER_M=0.05
AMBIENT_MINI_OUT_PER_M=0.50
NOUS_IN_PER_M=0.05
NOUS_OUT_PER_M=0.20
```

### Output

The benchmark produces:

- `bench-results/bench-result-<timestamp>.json` - full machine-readable report
- `bench-results/bench-summary-<timestamp>.txt` - short human-readable summary

### Example results

This repository includes example benchmark results in:

```
examples/bench-results/
```

These files demonstrate the output format and contain one real comparison run between Ambient and an alternative provider.

### Notes

- Cost is estimated from `usage.prompt_tokens` and `usage.completion_tokens` if the API returns usage data.
- If usage is missing, cost is reported as `null`.
- This benchmark is meant as a **practical reality check**, not as a rigorous scientific performance evaluation.

## Week 5 - Verification boundaries (Micro-Challenge #5)

This project includes a Week 5 addition: the report is programmatically split into verifiable and non-verifiable layers after the LLM response is received.

Each report includes a top-level `verification_boundary` block with:

### Structure

- `deterministic` - statements that can be mechanically checked against extracted proposal fields, evidence quotes, explicit numeric or address literals, and explicit voting option matches.
- `interpretive` - statements that rely on reasoning, summarization, risk evaluation, or recommendation logic.
- `uncertainty_flags` - derived automatically from missing extracted fields, low confidence recommendations, and explicit uncertainty markers in the analysis.

### Important clarification

`__ambient.verified = true` confirms inference integrity and commitment (provider-side verification), but it does **not** make interpretive conclusions true.

The `verification_boundary` block exists to make this distinction explicit inside the report itself.

### Deterministic labeling improvements

The deterministic classification logic was refined to:

- Only mark `contains_numbers_or_addresses` if actual numeric literals are present.
- Only mark `mentions_extracted_options` if the suggested option appears with proper word boundaries.
- Avoid false matches for short tokens like "yes" inside unrelated words.
- Avoid incorrectly attaching evidence-match reasons to recommendation fields when no real textual match exists.

This ensures deterministic labels reflect actual mechanical verifiability, not heuristic artifacts.

### Example reports (Week 5 structure)

Updated example reports are available in:

```
examples/reports/
```

- `report-2026-02-26T06-07-34-157Z.json`
- `report-snapshot-0xe5435766bae1f44d1ce354cea93acf4f38216f4e7ca071ccbb0ad0e856b34363.json`
- `report-tally-ens-107313977323541760723614084561841045035159333942448750767795024713131429640046.json`

These files demonstrate:

- `__ambient` verification metadata
- explicit separation of deterministic vs interpretive layers
- uncertainty handling
- structured DAO recommendation logic

## Streaming and verification details

Ambient verification metadata is best captured in streaming mode.

- stream=true: captures lifecycle events (auction, bids, bidder) and includes them in "__ambient"
- stream=false: returns minimal verification (verified, merkle_root) without lifecycle details
