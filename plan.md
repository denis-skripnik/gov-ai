# Week 9 plan — Proof Over Vibes (Web2) for gov-ai

## Goal
Add Week 9 verification hooks so gov-ai can classify output fragments into:
- deterministic
- probabilistic
- unverifiable

And optionally reject responses that mix categories without explicit separation.

## Why this fits the project
The project already implements:
- Week 5: verification boundary
- Week 6: refusal handling
- Week 7: system identity in UI
- Week 8: latency + multi-node analysis

Week 9 is the natural next step: move from a broad deterministic vs interpretive split to a stricter proof-oriented classification layer.

## Scope
- Add a new classification layer for report claims/output sections
- Distinguish mechanically provable claims from uncertain/model-based claims
- Detect mixed-category responses without explicit separation
- Optionally fail/route such responses in strict mode
- Expose the result in JSON output and report viewer
- Document how this maps to Ambient Week 9 requirements

## Non-goals
- Do not implement cryptographic proof of proposal truth
- Do not claim trustless verification of source data
- Do not redesign the whole analyzer prompt architecture
- Do not change Week 5/6/7/8 behavior unless needed for compatibility

## Proposed design

### 1. New report block
Add a top-level block, tentatively:
- `verification_hooks`

Suggested shape:
- `segments`: classified items with path, text, category, reasons
- `mixed_categories_detected`: boolean
- `requires_separation`: boolean
- `strict_rejection_triggered`: boolean
- `routing_action`: `ALLOW | WARN | REJECT | HUMAN_REVIEW`
- `method`: version + notes

### 2. Category rules

#### deterministic
Statements directly checkable against extracted/source material, for example:
- exact title/body fragments
- exact option names
- exact numbers/amounts/addresses
- explicit vote/result literals already extracted

#### probabilistic
Statements that are evidence-based but still inferential, for example:
- risk estimates
- likely outcomes
- confidence-weighted recommendations
- multi-node consensus outputs

#### unverifiable
Statements not grounded enough for checking, for example:
- vague summary claims with no anchor
- broad judgments without cited evidence
- unsupported speculation

### 3. Mixed-category detection
Flag when a single response block or field combines multiple categories without separation.
Examples:
- one sentence mixes exact facts with speculative recommendation
- summary includes extracted fact + unsupported causal claim

### 4. Strict mode behavior
Add env/config switch, e.g.:
- `STRICT_VERIFICATION_HOOKS=true`

Behavior in strict mode:
- if mixed categories are detected without separation:
  - route to `HUMAN_REVIEW` or reject output for final use
- otherwise allow output

### 5. UI updates
Expose Week 9 block in `pageServer.js`:
- show segment categories
- show whether mixed output was detected
- show whether strict rejection fired

### 6. Documentation updates
Update `README.md` with:
- Week 9 description
- exact meaning of deterministic/probabilistic/unverifiable
- limitations
- how strict mode works

## Files likely to change
- `analyzer.js` — main classification logic
- `gov-ai.js` — apply hooks after analysis and before routing/save
- `pageServer.js` — render Week 9 output
- `README.md` — docs
- new test file(s), ideally for classification logic

## TDD / validation strategy
1. Add tests for classification helpers:
- deterministic match
- probabilistic recommendation/risk
- unverifiable vague claim
- mixed-category detection
- strict rejection behavior

2. Run syntax / runtime checks after changes:
- run Node syntax checks for changed entry files where practical
- run a lightweight smoke check that imports/executes the changed code paths without crashing
- ensure `pageServer.js` still starts
- ensure CLI path still builds/saves a report without schema-shape regressions

3. Run manual validation on current report fixtures and latest generated report:
- compare behavior against existing example reports in `examples/` when present
- compare behavior against the newest real report in `reports/`
- confirm old reports can still render
- confirm Week 9 block appears only when generated or is backward-compatible
- confirm newest report gets the expected `verification_hooks` structure without breaking existing Week 5–8 fields

## Risks / assumptions
- Current Week 5 heuristic boundary may overlap with Week 9 categories; avoid contradictory labels
- Some fields may need sentence-level splitting to classify well
- Overly strict rules may mark too much as unverifiable

## Delivery tiers

### MVP
- Report includes Week 9 verification hooks output
- 3-category classification works on core report fields
- Mixed-category detection works on representative examples
- Strict mode can reject or route ambiguous mixed outputs
- README explains the Week 9 behavior clearly

### Nice-to-have
- UI displays the new block in `pageServer.js`
- helper-level automated tests cover classifier and strict mode
- better sentence-level splitting/classification for mixed-field detection

## Definition of done
- MVP is complete and usable for Week 9 submission
- Nice-to-have items are implemented when time allows without destabilizing existing Week 5–8 behavior
