Week 16 Dev Loop — Verified vs Unverified Execution

I updated `gov-ai` so the Week 16 trust test is not just a separate note/example, but can run through the normal product pipeline.

What changed:
- Added support for local JSON proposal fixtures in `fetchAndExtract()`.
- Added a reproducible treasury-spending proposal fixture.
- Ran the fixture through the main `gov-ai.js analyze` flow using Ambient.
- Kept the generated main-pipeline report as an example artifact.
- Hardened JSON parsing for Ambient responses that wrap JSON in markdown or surrounding text.
- Added `AMBIENT_MODEL` and `AMBIENT_STREAM=false` support for more reliable model/runtime selection.
- Strengthened verification hooks: `analysis.unknowns` are now always classified as `unverifiable`, even when they contain hard literals like addresses or amounts.

Scenario:
A DAO proposal asks to transfer 250,000 USDC from the community treasury to `0x1234567890abcdef1234567890abcdef12345678` for Q2 grants. It says the recipient is the grants multisig, but provides no invoice, signer list, recipient-control proof, or budget breakdown.

Main run:
`MULTI_NODE_ENABLED=false AMBIENT_STREAM=false AMBIENT_MODEL=zai-org/GLM-5.1-FP8 node gov-ai.js analyze examples/week16-trust-verification/treasury-transfer-proposal.json`

Observed result:
- Ambient verification: `verified: true`
- Request ID: `4b04aec58e2a4e8ab5dda4a09b70af00`
- Merkle root: `88d6e16e438a8fcff1c02419aa290b7ea47c81b146b5f56ef7d36bce3cc105e4`
- `gov-ai` routing action: `WARN`
- Verification-hook segments: 23
- All `analysis.unknowns` segments classified as `unverifiable`

Why this matters:
The product now separates execution provenance from factual truth. Ambient can verify the inference run, but `gov-ai` still flags claims that need external evidence: multisig control, signer authority, recipient legitimacy, invoice validity, and budget justification.

Validation:
- `node --test test-fetcher-local-fixture.test.js test-verification-hooks.test.js`
- 11/11 tests passed
- `node examples/week16-trust-verification/run-existing-verification-hooks.js`
- focused routing result: `WARN`

Committed and pushed:
`01d7fcf Add Week 16 trust verification example`
