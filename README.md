# gov-ai

AI assistant for DAO governance proposals.

This project is a demo for **Web3 Developer Loop – Experiment #3 (AI for governance or automation)**.

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
API_PORT=3000       # optional, default port for gov-ai-api.js
PAGE_PORT=3100      # optional, default port for pageServer.js
```

**Environment variables:**
- `AMBIENT_API_KEY` (required) - API key for Ambient inference provider
- `PROPOSAL_URL` (required for CLI) - URL of the proposal to analyze
- `TALLY_API_KEY` (optional) - API key for Tally GraphQL API, required only for Tally proposals
- `API_PORT` (optional) - Port for the HTTP API server (default: 3000)
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

- `report-snapshot-<id>.json`
- `report-tally-<org>-<id>.json`
- `report-<timestamp>.json` (fallback)

---

## Two modes: CLI and API

This repository contains two ways to run the project:

- `gov-ai.js` — CLI / demo version for local usage and experiments.
- `gov-ai-api.js` — minimal HTTP API server suitable as a base for a service.

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

(you can override the port via `API_PORT` environment variable)

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

---

## prod-reports

When using the API server, finished reports are saved to the `prod-reports/` folder:

```
prod-reports/<job_id>.json
```

This folder acts as a simple file-based storage for completed jobs.

---

## Output format

The tool produces a structured JSON report:

- `input` – source URL and metadata
- `extracted` – data actually extracted from the source
- `analysis` – LLM-generated structured analysis
  - `summary` – brief overview of the proposal
  - `key_changes` – list of key changes proposed
  - `benefits` – list of potential benefits
  - `risks` – list of identified risks
  - `unknowns` – list of unknown or missing information
  - `evidence_quotes` – relevant quotes from the proposal text
- `recommendation` – suggested action + reasoning
- `limitations` – explicit list of caveats

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

This repository includes example output reports for testing and demonstration purposes.

You can find them in the `reports/` folder:

- [report-snapshot-0xd187826a4f0ac86466f1241dc906aa39fd398c1de37b5047aafb6e321d95d39f.json](reports/report-snapshot-0xd187826a4f0ac86466f1241dc906aa39fd398c1de37b5047aafb6e321d95d39f.json)  
  Example report generated from a Snapshot proposal.

- [report-tally-uniswap-83.json](reports/report-tally-uniswap-83.json)  
  Example report generated from a Tally proposal (Uniswap governance).

- [report-2026-02-07T19-26-28-237Z.json](reports/report-2026-02-07T19-26-28-237Z.json)  
  Example report generated from a DAO DAO proposal (via Next.js fallback extraction).

These files allow reviewers to inspect the tool output format and behavior without running the code.

---

## Important limitations

- This is **NOT** financial, legal, or governance advice.
- The tool may fail to extract all proposal parameters.
- Voting options or current results may be missing.
- The AI model may misunderstand technical details.
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

This was created as part of **Web2 Developer Loop – Micro-Challenge #4 (cost + latency reality check)**.

### Files

* `bench.js` — runs a benchmark for a given proposal URL and saves results to `bench-results/`.

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

* `bench-results/bench-result-<timestamp>.json` — full machine-readable report
* `bench-results/bench-summary-<timestamp>.txt` — short human-readable summary

### Example results

This repository includes example benchmark results in:

```
bench-results/examples/
```

These files demonstrate the output format and contain one real comparison run between Ambient and an alternative provider.

### Notes

* Cost is estimated from `usage.prompt_tokens` and `usage.completion_tokens` if the API returns usage data.
* If usage is missing, cost is reported as `null`.
* This benchmark is meant as a **practical reality check**, not as a rigorous scientific performance evaluation.

### Streaming and verification details

Ambient verification metadata is best captured in streaming mode.

- stream=true: captures lifecycle events (auction, bids, bidder) and includes them in "__ambient"
- stream=false: returns minimal verification (verified, merkle_root) without lifecycle details
