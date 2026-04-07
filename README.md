# gov-ai

AI assistant for DAO governance proposals.

## Table of Contents

- [Week 10 - Load the System (Web2)](#week-10---load-the-system-web2)
- [Week 9 - Proof Over Vibes (Web2)](#week-9---proof-over-vibes-web2)
- [Week 8 - Design for Many Small Miners (Web2)](#week-8---design-for-many-small-miners-web2)
- [Week 7 - System Identity (Web2)](#week-7---system-identity-web2)
- [Week 6 - Refusal handling (Web2)](#week-6---refusal-handling-web2)
- [Downstream handling (routing)](#downstream-handling-routing)
- [Moderator checklist (Week 6 Web2)](#moderator-checklist-week-6-web2)
- [Supported sources](#supported-sources)
- [Setup](#setup)
- [Init user principles](#init-user-principles)
- [Run analysis (CLI)](#run-analysis-cli)
- [Two modes: CLI and API](#two-modes-cli-and-api)
- [Output format](#output-format)
- [Example reports](#example-reports)
- [API server (production-style)](#api-server-production-style)
- [Report viewer (pageServer.js)](#report-viewer-pageserverjs)
- [Benchmark (Web2 Micro-Challenge #4)](#benchmark-web2-micro-challenge-4)
- [Week 5 - Verification boundaries (Micro-Challenge #5)](#week-5---verification-boundaries-micro-challenge-5)
- [Important limitations](#important-limitations)
- [What this project is NOT](#what-this-project-is-not)

This project started as **Web3 Developer Loop - Experiment #3 (AI for governance or automation)**.
It now also documents and ships:
- Week 5 verification boundaries (verifiable vs interpretive layers)
- Week 6 refusal handling (Web2): deterministic refusal detection plus routing and human review tickets
- Week 7 system identity (Web2): exposes system identity, verification boundaries, and refusal handling in the UI
- Week 8 design for many small miners (Web2): dynamic timeout, financial proposal detection, multi-node consensus analysis
- Week 9 proof over vibes (Web2): deterministic / probabilistic / unverifiable verification hooks with optional strict routing
- Week 10 load the system (Web2): controlled single-node parallel stress testing with load artifacts and failure-mode tracking

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

## Week 10 - Load the System (Web2)

Week 10 focused on real parallel load using the real gov-ai workload shape, while intentionally avoiding the full financial multi-node orchestration path.

### Why a separate Week 10 mode exists

The normal financial path in `gov-ai.js` can invoke:
- financial proposal detection
- 3-attempt multi-node analysis
- consensus selection
- retry / backoff behavior
- full streaming verification lifecycle

That makes the default production-style path useful for real analysis, but poor as a clean parallel benchmark unit. For Week 10, this repository uses a **controlled single-node mode** instead:
- same extracted proposal input
- same governance-analysis prompt shape
- same JSON report contract
- streaming enabled for timing + Ambient metadata capture
- multi-node financial orchestration intentionally bypassed

This keeps the workload meaningful while making the benchmark interpretable.

### Week 10 harness

Week 10 uses a dedicated load harness:
- script: `week10-load.js`
- artifact folder: `load-reports/`

The harness records, per run:
- first token latency
- full completion time
- success / failure / timeout status
- refusal and routing signals
- Ambient metadata when available (`request_id`, `merkle_root`, validator line, auction, bidder)

The harness writes two artifact types:
- `load-result-<runs>-<timestamp>.json` — machine-readable raw run data + aggregates
- `load-summary-<runs>-<timestamp>.md` — human-readable summary

### Retained Week 10 artifact set

The final retained Week 10 checkpoints are:
- `1 / 1`
- `5 / 5`
- `10 / 10`
- `50 / 50`
- `100 / 100`

These artifacts are kept in `load-reports/`.

### Workload used

Proposal used for the retained Week 10 runs:
- Snapshot / Aave DAO proposal
- URL stored in `.env` as `PROPOSAL_URL`

Test mode used:
- extracted input reused across runs
- controlled single-node mode
- streaming enabled
- strict verification hooks disabled

### Week 10 results summary

Observed behavior across retained checkpoints:
- `1 / 1` — stable baseline, first token ~3.8s, completion ~20 min
- `5 / 5` — still 100% success, first token ~2.5s, completion ~20 min
- `10 / 10` — 100% success, but first token jumps to ~49s while completion stays ~20 min
- `50 / 50` — success rate drops to 86%; first real failures appear (`no_stream_content`, `HTTP 429`)
- `100 / 100` — success rate drops to 36%; dominant failure mode becomes `HTTP 429 Too many concurrent requests`

Important pattern:
- completion time for accepted runs stayed close to ~20 minutes even at higher load
- first-token latency did **not** degrade monotonically
- the clearest system limit showed up first in **reliability / admission failure**, not in total completion time

### How to interpret Week 10 honestly

This Week 10 benchmark does **not** claim to be a full end-to-end benchmark of the default financial multi-node production path.

What it does show:
- how the real gov-ai workload behaves in controlled single-node parallel execution
- how first-token responsiveness changes under load
- where streaming reliability starts to fail
- where rate limiting becomes the dominant system boundary

This makes Week 10 useful as a practical stress test and failure-mode map, even though the full production financial path remains a separate, longer-running workflow.

## Week 9 - Proof Over Vibes (Web2)

Week 9 adds a second post-processing layer: `verification_hooks`.

It classifies report fragments into:
- `deterministic` - directly anchored to extracted title/body/options, evidence quotes, or hard literals
- `probabilistic` - inference-heavy or recommendation-oriented statements (risks, benefits, confidence, likely outcomes)
- `unverifiable` - vague or weakly grounded statements without a clear anchor

Additional Week 9 signals:
- `mixed_categories_detected` - one report field contains multiple categories across its sentence-level segments
- `requires_separation` - mixed content should be split more explicitly
- `strict_rejection_triggered` - enabled when `STRICT_VERIFICATION_HOOKS=true` and mixed categories are found
- `routing_action` - `ALLOW`, `WARN`, or `HUMAN_REVIEW`

### Strict mode

Set in `.env` or shell:

```env
STRICT_VERIFICATION_HOOKS=true
```

Behavior:
- `false` (default): mixed or unverifiable content is surfaced as a warning in the report/UI
- `true`: mixed-category output is escalated to human review and included in the routing ticket

### Limits

- This is still heuristic classification, not cryptographic proof of truth.
- A deterministic label means the text is mechanically anchorable, not that the source itself is trustworthy.
- Sentence splitting is intentionally conservative to avoid destabilizing earlier Week 5-8 flows.

### Week 9 example artifacts

A full Week 9-style example generated from a live run is included in:
- `examples/reports/report-2026-03-27T18-42-51-048Z.json`
- `examples/routes/route-2026-03-27T18-42-51-049Z.json`
- `examples/reviews/ticket-2026-03-27T18-42-51-049Z.json`

This example shows `verification_hooks` in the report plus the downstream routing/review artifacts.

## Week 8 - Design for Many Small Miners (Web2)

Week 8's goal: "Design for many small miners."

This project implements solutions for handling variable miner speeds in a decentralized network.

### LatencyTracker (Dynamic Timeout)

Adaptive timeout based on rolling median of recent latencies:
- Stores last N latency measurements
- Timeout = median * 3
- Default: 60s if less than 3 measurements

### Financial Proposal Detection

Automatic detection of financial proposals using pattern matching:
- Dollar amounts: `$2.5M`, `$100K`
- Crypto tokens: `USDC`, `ETH`, `DAI`, `AAVE`, `ENS`
- Financial verbs: `transfer`, `allocate`, `distribute`, `fund`
- Treasury terms: `treasury`, `endowment`, `budget`, `revenue`
- Ethereum addresses: `0x...`

Minimum 2 pattern matches = financial proposal.

### Multi-Node Analysis (Consensus)

For financial proposals, the system runs 3 independent analyses:
1. Makes 3 requests to different nodes
2. Saves each result to `./temp/multi-node/`
3. Compares recommendations (suggested_option only: YAE/NAY/UNKNOWN)
4. Selects by consensus (2+ identical = consensus)
5. If no consensus, takes first result

Results saved:
- `analysis-{timestamp}-attempt-{N}.json` - each attempt
- `analysis-{timestamp}-chosen.json` - final choice with reason

### Configuration

- `MULTI_NODE_ENABLED` (default: true) - enable multi-node for financial proposals
- Set in environment or `.env` file

### Progress Logging

Enhanced console output:
```
==================================================
GovAI Analysis - 2026-03-22T10:54:00.000Z
```

### Example Reports (Week 8)

Example from Week 8 testing on DAO DAO Injective proposal:

- [report-2026-03-22T13-38-05-856Z.json](examples/reports/report-2026-03-22T13-38-05-856Z.json)
- [ticket-2026-03-22T13-38-05-856Z.json](examples/reviews/ticket-2026-03-22T13-38-05-856Z.json)
- [route-2026-03-22T13-38-05-856Z.json](examples/routes/route-2026-03-22T13-38-05-856Z.json)
Proposal: https://daodao.zone/...
==================================================
Fetching and extracting proposal data...
[2026-03-22T10:54:01.000Z] Starting analysis for: ...
[2026-03-22T10:54:01.000Z] Checking if financial proposal... YES
[2026-03-22T10:54:02.000Z] Financial proposal detected - running multi-node analysis...
[2026-03-22T10:54:15.000Z] Consensus check: 3 identical out of 3 (by suggested_option)
```

---
## Week 7 - System Identity (Web2)

Week 7's goal: "Expose system identity in your app."

This project now exposes system identity through collapsible sections in the report viewer:

### Verification Boundary Section
Shows which parts of the analysis are deterministic (verifiable) vs interpretive (require human review):
- **Deterministic**: Fields that can be directly verified from extracted data
- **Interpretive**: Fields requiring human judgment
- **Uncertainty Flags**: Signals indicating incomplete information
- **Method**: How boundaries are determined

### Refusal Handling Section
Displays when the system refused to provide a recommendation:
- **Refusal Detected**: Yes/No indicator
- **Signals**: What triggered the refusal (e.g., `unknowns_present`, `low_confidence`)
- **Routed To**: Where the request was forwarded (e.g., `HUMAN_REVIEW`)

### Prompt Used Section
Shows the prompt that generated the analysis:
- Summary of prompt intent
- Excerpt of prompt text
- Model used

### Week 7 Evaluation Section
For reports tagged with Week 7 evaluation:
- What surprised the tester
- Where external explanation was needed

The UI uses color-coded collapsible sections:
- 🔵 Blue: Week 7 evaluation
- 🟡 Yellow: Verification boundaries
- 🔴 Red: Refusal handling
- 🟢 Green: Prompt used

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
- `verification_hooks` - Week 9 deterministic / probabilistic / unverifiable hooks plus strict-mode state
- `refusal_handling` - Week 6 refusal decision and deterministic signals
- `routing` - final downstream routing decision after refusal + strict verification checks
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
- [report-2026-03-27T18-42-51-048Z.json](examples/reports/report-2026-03-27T18-42-51-048Z.json) — Week 9 example with `verification_hooks`

Routing and review examples:
- [route-2026-02-26T06-07-34-158Z.json](examples/routes/route-2026-02-26T06-07-34-158Z.json)
- [route-2026-03-27T18-42-51-049Z.json](examples/routes/route-2026-03-27T18-42-51-049Z.json) — Week 9 routing example
- [ticket-2026-02-26T06-07-34-158Z.json](examples/reviews/ticket-2026-02-26T06-07-34-158Z.json)
- [ticket-2026-03-27T18-42-51-049Z.json](examples/reviews/ticket-2026-03-27T18-42-51-049Z.json) — Week 9 review example

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
