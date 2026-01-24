# gov-ai

AI assistant for DAO governance proposals.

This project is a demo for **Web3 Developer Loop – Experiment #3 (AI for governance or automation)**.

It takes a proposal URL (Snapshot, Tally, DAO DAO), extracts available data, and produces a structured analysis:
- summary of the proposal
- key changes
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

---

## Setup

```bash
npm install
```

Create `.env`:

```env
AMBIENT_API_KEY=...
PROPOSAL_URL="https://..."
TALLY_API_KEY=...   # optional, only for tally.xyz
```

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
- `recommendation` – suggested action + reasoning
- `limitations` – explicit list of caveats

---

## Example reports

This repository includes example output reports for testing and demonstration purposes.

You can find them in the `reports/` folder:

- [report-snapshot-0xd187826a4f0ac86466f1241dc906aa39fd398c1de37b5047aafb6e321d95d39f.json](reports/report-snapshot-0xd187826a4f0ac86466f1241dc906aa39fd398c1de37b5047aafb6e321d95d39f.json)  
  Example report generated from a Snapshot proposal.

- [report-tally-uniswap-83.json](reports/report-tally-uniswap-83.json)  
  Example report generated from a Tally proposal (Uniswap governance).

- [report-2026-01-24T10-15-26-521Z.json](reports/report-2026-01-24T10-15-26-521Z.json)  
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
- It does NOT verify inference integrity or receipts.
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
